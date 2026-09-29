import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getLanguageModel } from "@/lib/agents/llm";
import { runOrchestratorToText } from "@/lib/agents/orchestrator";
import { resetSearchState } from "@/lib/agents/search-agent";
import { GET as statusGET } from "@/app/api/status/route";
import { getEnv } from "@/lib/env";

const PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

/** A minimal DeepSeek (OpenAI-compatible) chat completions stream that answers with `text`. */
function deepseekStream(text: string): Response {
  const chunk = (delta: Record<string, unknown>, finish: string | null = null) => ({
    id: "chatcmpl-1",
    object: "chat.completion.chunk",
    created: 1_790_000_000,
    model: "deepseek-v4-flash",
    choices: [{ index: 0, delta, finish_reason: finish }],
  });
  const events = [
    chunk({ role: "assistant", content: "" }),
    chunk({ content: text }),
    { ...chunk({}, "stop"), usage: { prompt_tokens: 12, completion_tokens: 6, total_tokens: 18 } },
  ];
  const body = `${events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join("")}data: [DONE]\n\n`;
  return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}

interface CapturedRequest {
  url: string;
  headers: Headers;
  body: Record<string, unknown>;
}

function mockDeepSeek(answer: string): CapturedRequest[] {
  const calls: CapturedRequest[] = [];
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    calls.push({ url, headers: new Headers(init?.headers), body: JSON.parse(String(init?.body ?? "{}")) });
    return deepseekStream(answer);
  });
  return calls;
}

function useDeepSeek(extra: Record<string, string> = {}) {
  vi.stubEnv("LLM_PROVIDER", "auto");
  vi.stubEnv("DEEPSEEK_API_KEY", "sk-deepseek-test");
  vi.stubEnv("ANTHROPIC_API_KEY", "");
  vi.stubEnv("OPENAI_API_KEY", "");
  vi.stubEnv("OLLAMA_BASE_URL", "");
  vi.stubEnv("DEEPSEEK_MODEL", "");
  vi.stubEnv("DEEPSEEK_VISION_MODEL", "");
  for (const [key, value] of Object.entries(extra)) vi.stubEnv(key, value);
}

beforeEach(() => {
  resetSearchState();
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("DeepSeek provider selection", () => {
  it("picks DeepSeek V4 Flash when DEEPSEEK_API_KEY is set", () => {
    useDeepSeek();
    expect(getEnv().llm).toMatchObject({
      provider: "deepseek",
      model: "deepseek-v4-flash",
      visionModel: "deepseek-v4-flash-vision-exp",
    });
  });

  it("prefers DeepSeek over Claude and OpenAI in auto mode", () => {
    useDeepSeek({ ANTHROPIC_API_KEY: "sk-ant", OPENAI_API_KEY: "sk-openai" });
    expect(getEnv().llm.provider).toBe("deepseek");
  });

  it("honours an explicit LLM_PROVIDER and custom models", () => {
    useDeepSeek({ ANTHROPIC_API_KEY: "sk-ant", LLM_PROVIDER: "anthropic" });
    expect(getEnv().llm.provider).toBe("anthropic");

    useDeepSeek({ LLM_PROVIDER: "deepseek", DEEPSEEK_MODEL: "deepseek-v4-pro", DEEPSEEK_VISION_MODEL: "deepseek-vl-test" });
    expect(getEnv().llm).toMatchObject({ provider: "deepseek", model: "deepseek-v4-pro", visionModel: "deepseek-vl-test" });
  });

  it("stays offline when LLM_PROVIDER=deepseek but the key is missing or a placeholder", () => {
    useDeepSeek({ LLM_PROVIDER: "deepseek", DEEPSEEK_API_KEY: "your_deepseek_api_key" });
    expect(getEnv().llm.provider).toBe("none");
    expect(getLanguageModel("text")).toBeNull();
  });
});

describe("DeepSeek requests through the orchestrator", () => {
  it("streams a core answer from chat completions with tools and thinking off", async () => {
    useDeepSeek();
    const calls = mockDeepSeek("Hello from DeepSeek.");

    const result = await runOrchestratorToText(
      { messages: [{ role: "user", content: "Explain photosynthesis in one line" }] },
      { trusted: false },
    );

    expect(result).toMatchObject({ agent: "core", provider: "deepseek", text: "Hello from DeepSeek." });
    expect(calls).toHaveLength(1);
    const [call] = calls;
    expect(call.url).toBe("https://api.deepseek.com/chat/completions");
    expect(call.headers.get("authorization")).toBe("Bearer sk-deepseek-test");
    expect(call.body).toMatchObject({ model: "deepseek-v4-flash", stream: true, thinking: { type: "disabled" } });
    const tools = call.body.tools as Array<{ function: { name: string } }>;
    expect(tools.map((t) => t.function.name)).toContain("webSearch");
  });

  it("sends an attached image to the vision model", async () => {
    useDeepSeek();
    const calls = mockDeepSeek("A single pink pixel.");

    const result = await runOrchestratorToText(
      { messages: [{ role: "user", content: "What is in this picture?", image: PNG }] },
      { trusted: false },
    );

    expect(result).toMatchObject({ agent: "vision", provider: "deepseek", text: "A single pink pixel." });
    const body = calls[0].body as { model: string; messages: Array<{ content: unknown }> };
    expect(body.model).toBe("deepseek-v4-flash-vision-exp");
    expect(JSON.stringify(body.messages.at(-1)!.content)).toContain("data:image/png;base64,");
  });

  it("still answers smart-home commands without calling DeepSeek", async () => {
    useDeepSeek();
    const calls = mockDeepSeek("should not be used");

    const result = await runOrchestratorToText({ messages: [{ role: "user", content: "Turn on the lights" }] }, { trusted: false });

    expect(result).toMatchObject({ agent: "iot", provider: "none", text: "Yes, it is done." });
    expect(calls).toHaveLength(0);
  });
});

describe("/api/status with DeepSeek", () => {
  it("reports the DeepSeek models without exposing the key", async () => {
    useDeepSeek();
    const res = await statusGET();
    const status = (await res.json()) as { llm: unknown };

    expect(status.llm).toEqual({ provider: "deepseek", model: "deepseek-v4-flash", visionModel: "deepseek-v4-flash-vision-exp" });
    expect(JSON.stringify(status)).not.toContain("sk-deepseek-test");
  });
});
