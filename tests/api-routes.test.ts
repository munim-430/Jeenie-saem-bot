import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { POST as chat } from "@/app/api/chat/route";
import { GET as hangeulGet, POST as hangeulPost } from "@/app/api/hangeul/route";
import { GET as searchGet, POST as searchPost } from "@/app/api/search/route";
import { GET as status } from "@/app/api/status/route";
import type { ChatMessage, HangeulReport, SearchResponse, SourceLink, SystemStatus } from "@/lib/types";
import { decodeHeaderJson } from "@/lib/utils";

const PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

const SECRETS: Record<string, string> = {
  OPENAI_API_KEY: "sk-secret-openai",
  TAVILY_API_KEY: "tvly-secret",
  GOOGLE_CSE_API_KEY: "google-secret",
  GOOGLE_CSE_ID: "cse-id-secret",
  ELEVENLABS_API_KEY: "eleven-secret",
  ELEVENLABS_VOICE_ID: "voice-id-secret",
  TELEGRAM_BOT_TOKEN: "999:telegram-secret",
  TELEGRAM_ADMIN_CHAT_ID: "31337",
  TELEGRAM_WEBHOOK_SECRET: "webhook-secret",
  HANGEUL_BASE_URL: "https://portal-secret.example/admin",
  HANGEUL_USERNAME: "portal-user-secret",
  HANGEUL_PASSWORD: "portal-password-secret",
  JEANNIE_ACCESS_KEY: "access-key-secret",
  CRON_SECRET: "cron-secret-value",
};

const ENV_NAMES = [
  ...Object.keys(SECRETS),
  "LLM_PROVIDER",
  "OLLAMA_BASE_URL",
  "OPENAI_BASE_URL",
  "MOCK_MODE",
  "HANGEUL_REPORT_PATH",
  "HANGEUL_STATUS_PATH",
];

function request(path: string, init: { method?: string; body?: unknown; headers?: Record<string, string> } = {}): Request {
  const { method = "GET", body, headers = {} } = init;
  return new Request(`http://localhost${path}`, {
    method,
    headers: { "content-type": "application/json", ...headers },
    body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
  });
}

const chatRequest = (body: unknown, headers?: Record<string, string>) => request("/api/chat", { method: "POST", body, headers });
const user = (content: string, image?: string): ChatMessage => ({ role: "user", content, image });

const DDG_INSTANT = {
  Heading: "Seoul",
  AbstractText: "Seoul is the capital of South Korea.",
  AbstractURL: "https://en.wikipedia.org/wiki/Seoul",
  Results: [],
  RelatedTopics: [
    { FirstURL: "https://duckduckgo.com/Busan", Text: "Busan - Second city.", Result: '<a href="https://duckduckgo.com/Busan">Busan</a> - Second city.' },
  ],
};

function stubFetch() {
  const urls: string[] = [];
  const fetchMock = vi.fn<typeof fetch>(async (input) => {
    const url = String(input instanceof Request ? input.url : input);
    urls.push(url);
    if (url.startsWith("https://api.duckduckgo.com/")) return new Response(JSON.stringify(DDG_INSTANT), { status: 202 });
    if (url.startsWith("https://api.telegram.org/")) return Response.json({ ok: true, result: { message_id: 1 } });
    if (url.startsWith("https://portal-secret.example/")) {
      return Response.json({ title: "Live ops", metrics: [{ label: "Students", value: 250 }], highlights: ["All good"] });
    }
    return new Response("nope", { status: 500 });
  });
  vi.stubGlobal("fetch", fetchMock);
  return { fetchMock, urls };
}

beforeEach(() => {
  for (const name of ENV_NAMES) vi.stubEnv(name, "");
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("POST /api/chat", () => {
  it("answers IoT commands with the exact sentence and metadata headers", async () => {
    const { fetchMock } = stubFetch();
    const res = await chat(chatRequest({ messages: [user("Turn off the bedroom lights")] }));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/plain; charset=utf-8");
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("x-jeannie-agent")).toBe("iot");
    expect(res.headers.get("x-jeannie-provider")).toBe("none");
    expect(res.headers.get("x-jeannie-lang")).toBe("en");
    expect(res.headers.has("x-jeannie-sources")).toBe(false);
    expect(await res.text()).toBe("Yes, it is done.");

    const ko = await chat(chatRequest({ messages: [user("에어컨 꺼줘")], lang: "auto" }));
    expect(ko.headers.get("x-jeannie-lang")).toBe("ko");
    expect(await ko.text()).toBe("네, 처리되었습니다.");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("streams offline answers when no model is configured", async () => {
    const res = await chat(chatRequest({ messages: [user("Write a poem about neon")] }));
    expect(res.headers.get("x-jeannie-agent")).toBe("offline");
    expect(await res.text()).toContain("OPENAI_API_KEY");
  });

  it("sends search sources as base64 JSON in a header", async () => {
    stubFetch();
    const res = await chat(chatRequest({ messages: [user("latest news about Seoul")] }));
    expect(res.headers.get("x-jeannie-agent")).toBe("search");
    const sources = decodeHeaderJson<SourceLink[]>(res.headers.get("x-jeannie-sources"));
    expect(sources).toEqual([
      { title: "Seoul", url: "https://en.wikipedia.org/wiki/Seoul" },
      { title: "Busan", url: "https://duckduckgo.com/Busan" },
    ]);
    expect(await res.text()).toContain("[1] Seoul");
  });

  it.each([
    ["invalid JSON", "{nope", "invalid_json"],
    ["no messages", { messages: [] }, "invalid_request"],
    ["last message from the assistant", { messages: [user("hi"), { role: "assistant", content: "hello" }] }, "invalid_request"],
    ["an empty last message", { messages: [user("   ")] }, "invalid_request"],
    ["a non-image data URL", { messages: [user("look")], image: "data:text/plain;base64,aGVsbG8=" }, "invalid_request"],
    ["a remote image URL", { messages: [user("look", "https://example.com/cat.png")] }, "invalid_request"],
    ["an image over 3 MB", { messages: [user("look")], image: `data:image/png;base64,${"A".repeat(4_200_000)}` }, "invalid_request"],
    ["more than 50 messages", { messages: Array.from({ length: 51 }, () => user("hi")) }, "invalid_request"],
    ["a message over 20k characters", { messages: [user("x".repeat(20_001))] }, "invalid_request"],
    ["an unknown language", { messages: [user("hi")], lang: "fr" }, "invalid_request"],
  ])("400 on %s", async (_label, body, code) => {
    const res = await chat(chatRequest(body));
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe(code);
  });

  it("accepts an image-only message", async () => {
    const res = await chat(chatRequest({ messages: [user("")], image: PNG }));
    expect(res.status).toBe(200);
    expect(res.headers.get("x-jeannie-agent")).toBe("offline"); // vision needs a model
  });

  it("401 when JEANNIE_ACCESS_KEY is set and missing or wrong", async () => {
    vi.stubEnv("JEANNIE_ACCESS_KEY", SECRETS.JEANNIE_ACCESS_KEY);
    const body = { messages: [user("turn on the lights")] };
    expect((await chat(chatRequest(body))).status).toBe(401);
    expect((await chat(chatRequest(body, { "x-jeannie-key": "wrong" }))).status).toBe(401);
    const ok = await chat(chatRequest(body, { "x-jeannie-key": SECRETS.JEANNIE_ACCESS_KEY }));
    expect(ok.status).toBe(200);
    expect(await ok.text()).toBe("Yes, it is done.");
  });
});

describe("GET /api/status", () => {
  it("reports capabilities without secrets and without requiring the access key", async () => {
    for (const [name, value] of Object.entries(SECRETS)) vi.stubEnv(name, value);
    const res = status();
    expect(res.status).toBe(200);
    const raw = await res.text();
    for (const secret of Object.values(SECRETS)) expect(raw).not.toContain(secret);
    const body = JSON.parse(raw) as SystemStatus;
    expect(body).toMatchObject({
      app: "Jeannie AI",
      accessKeyRequired: true,
      llm: { provider: "openai", model: "gpt-4o", visionModel: "gpt-4o" },
      search: { providers: ["tavily", "google", "duckduckgo"] },
      voice: { engines: ["elevenlabs", "edge", "browser"] },
      telegram: { configured: true },
      hangeul: { mode: "live" },
    });
  });

  it("shows an offline LLM and mock Hangeul when nothing is configured", async () => {
    const body = (await status().json()) as SystemStatus;
    expect(body.accessKeyRequired).toBe(false);
    expect(body.llm).toEqual({ provider: "none", model: null, visionModel: null });
    expect(body.search.providers).toEqual(["duckduckgo"]);
    expect(body.hangeul.mode).toBe("mock");
    expect(body.telegram.configured).toBe(false);
  });
});

describe("/api/search", () => {
  it("GET ?q= returns a SearchResponse", async () => {
    stubFetch();
    const res = await searchGet(request("/api/search?q=Seoul"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as SearchResponse;
    expect(body.provider).toBe("duckduckgo");
    expect(body.results[0].url).toBe("https://en.wikipedia.org/wiki/Seoul");
  });

  it("POST honours maxResults and validates input", async () => {
    stubFetch();
    const res = await searchPost(request("/api/search", { method: "POST", body: { query: "Seoul", maxResults: 1 } }));
    expect(((await res.json()) as SearchResponse).results).toHaveLength(1);
    expect((await searchPost(request("/api/search", { method: "POST", body: { query: "Seoul", maxResults: 11 } }))).status).toBe(400);
    expect((await searchPost(request("/api/search", { method: "POST", body: { query: "  " } }))).status).toBe(400);
    expect((await searchGet(request("/api/search"))).status).toBe(400);
  });

  it("requires the access key when configured", async () => {
    vi.stubEnv("JEANNIE_ACCESS_KEY", SECRETS.JEANNIE_ACCESS_KEY);
    stubFetch();
    expect((await searchGet(request("/api/search?q=Seoul"))).status).toBe(401);
    const ok = await searchGet(request("/api/search?q=Seoul", { headers: { authorization: `Bearer ${SECRETS.JEANNIE_ACCESS_KEY}` } }));
    expect(ok.status).toBe(200);
  });
});

describe("/api/hangeul", () => {
  function configurePortal() {
    for (const name of ["HANGEUL_BASE_URL", "HANGEUL_USERNAME", "HANGEUL_PASSWORD"]) vi.stubEnv(name, SECRETS[name]);
  }

  it("serves mock data to an open (untrusted) API even with the portal configured", async () => {
    configurePortal();
    const { urls } = stubFetch();
    const report = (await (await hangeulGet(request("/api/hangeul?action=report"))).json()) as { report: HangeulReport };
    expect(report.report.source).toBe("mock");
    expect(report.report.note).toMatch(/trusted/);
    const statusBody = (await (await hangeulGet(request("/api/hangeul?action=status"))).json()) as { status: { source: string } };
    expect(statusBody.status.source).toBe("mock");
    expect(urls).toEqual([]);
    expect((await hangeulGet(request("/api/hangeul?action=delete"))).status).toBe(400);
  });

  it("serves live data to callers with the access key", async () => {
    configurePortal();
    vi.stubEnv("JEANNIE_ACCESS_KEY", SECRETS.JEANNIE_ACCESS_KEY);
    stubFetch();
    expect((await hangeulGet(request("/api/hangeul?action=report"))).status).toBe(401);
    const res = await hangeulPost(
      request("/api/hangeul", { method: "POST", body: { action: "report" }, headers: { "x-jeannie-key": SECRETS.JEANNIE_ACCESS_KEY } }),
    );
    const body = (await res.json()) as { report: HangeulReport };
    expect(body.report).toMatchObject({ source: "live", title: "Live ops", metrics: [{ label: "Students", value: 250 }] });
  });

  it("cron GET without action builds the daily report and pushes it to Telegram", async () => {
    vi.stubEnv("CRON_SECRET", SECRETS.CRON_SECRET);
    vi.stubEnv("JEANNIE_ACCESS_KEY", SECRETS.JEANNIE_ACCESS_KEY);
    vi.stubEnv("TELEGRAM_BOT_TOKEN", SECRETS.TELEGRAM_BOT_TOKEN);
    vi.stubEnv("TELEGRAM_ADMIN_CHAT_ID", SECRETS.TELEGRAM_ADMIN_CHAT_ID);
    const { fetchMock } = stubFetch();

    const res = await hangeulGet(request("/api/hangeul", { headers: { authorization: `Bearer ${SECRETS.CRON_SECRET}` } }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { report: HangeulReport; delivered: boolean };
    expect(body.delivered).toBe(true);
    expect(body.report.source).toBe("mock"); // portal not configured
    const telegramCall = fetchMock.mock.calls.find(([url]) => String(url).includes("/sendMessage"));
    const payload = JSON.parse(String((telegramCall?.[1] as RequestInit).body)) as { chat_id: string; text: string };
    expect(payload.chat_id).toBe(SECRETS.TELEGRAM_ADMIN_CHAT_ID);
    expect(payload.text).toContain("Hangeul daily operations report (demo data)");
    expect(payload.text).toContain("한글 학원 일일 운영 보고서");
  });

  it("cron without Telegram reports delivered: false; a bare GET without cron needs the access key", async () => {
    vi.stubEnv("CRON_SECRET", SECRETS.CRON_SECRET);
    vi.stubEnv("JEANNIE_ACCESS_KEY", SECRETS.JEANNIE_ACCESS_KEY);
    stubFetch();
    const cron = await hangeulGet(request("/api/hangeul", { headers: { authorization: `Bearer ${SECRETS.CRON_SECRET}` } }));
    expect(((await cron.json()) as { delivered: boolean }).delivered).toBe(false);
    expect((await hangeulGet(request("/api/hangeul", { headers: { authorization: "Bearer wrong" } }))).status).toBe(401);
  });

  it("POST notify requires a trusted caller", async () => {
    stubFetch();
    const open = await hangeulPost(request("/api/hangeul", { method: "POST", body: { action: "notify" } }));
    expect(open.status).toBe(403);
    expect((await hangeulPost(request("/api/hangeul", { method: "POST", body: { action: "explode" } }))).status).toBe(400);

    vi.stubEnv("JEANNIE_ACCESS_KEY", SECRETS.JEANNIE_ACCESS_KEY);
    const trusted = await hangeulPost(
      request("/api/hangeul", { method: "POST", body: { action: "notify" }, headers: { "x-jeannie-key": SECRETS.JEANNIE_ACCESS_KEY } }),
    );
    expect(trusted.status).toBe(200);
    expect(((await trusted.json()) as { delivered: boolean }).delivered).toBe(false); // Telegram not configured
  });
});
