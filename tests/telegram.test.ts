import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { POST as webhook } from "@/app/api/telegram/webhook/route";
import { resetSearchState } from "@/lib/agents/search-agent";
import {
  downloadFileAsDataUrl,
  handleTelegramUpdate,
  notifyAdmin,
  sendMessage,
  splitMessage,
  TELEGRAM_CHUNK_SIZE,
} from "@/lib/telegram";

const TOKEN = "123456:SECRET-bot-token";
const ADMIN = 42;
const STRANGER = 7;

interface ApiCall {
  method: string;
  payload: Record<string, unknown>;
}

/** Fake Telegram (and DuckDuckGo) backend; records Bot API calls. */
function fakeTelegram(options: { fileSize?: number; filePath?: string; fileBytes?: number } = {}) {
  const calls: ApiCall[] = [];
  const other: string[] = [];
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    const api = /^https:\/\/api\.telegram\.org\/bot([^/]+)\/(\w+)$/.exec(url);
    if (api) {
      expect(api[1]).toBe(TOKEN);
      const payload = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
      calls.push({ method: api[2], payload });
      if (api[2] === "getFile") {
        return Response.json({ ok: true, result: { file_path: options.filePath ?? "photos/file_9.jpg", file_size: options.fileSize ?? 2048 } });
      }
      return Response.json({ ok: true, result: api[2] === "sendMessage" ? { message_id: calls.length } : true });
    }
    if (url.startsWith(`https://api.telegram.org/file/bot${TOKEN}/`)) {
      return new Response(new Uint8Array(options.fileBytes ?? 16).fill(0xff), { status: 200 });
    }
    other.push(url);
    if (url.startsWith("https://api.duckduckgo.com/")) {
      return new Response(
        JSON.stringify({ Heading: "Seoul", AbstractText: "Capital of Korea.", AbstractURL: "https://en.wikipedia.org/wiki/Seoul", RelatedTopics: [] }),
        { status: 202 },
      );
    }
    return new Response("{}", { status: 500 });
  });
  vi.stubGlobal("fetch", fetchMock);
  const sent = () => calls.filter((c) => c.method === "sendMessage").map((c) => c.payload);
  return { calls, other, sent, fetchMock };
}

function textUpdate(chatId: number, text: string, extra: Record<string, unknown> = {}) {
  return {
    update_id: 1,
    message: { message_id: 10, chat: { id: chatId, type: "private" }, from: { id: chatId, is_bot: false }, text, ...extra },
  };
}

beforeEach(() => {
  resetSearchState();
  vi.stubEnv("TELEGRAM_BOT_TOKEN", TOKEN);
  vi.stubEnv("TELEGRAM_ADMIN_CHAT_ID", String(ADMIN));
  vi.stubEnv("TELEGRAM_WEBHOOK_SECRET", "");
  for (const name of ["OPENAI_API_KEY", "OLLAMA_BASE_URL", "LLM_PROVIDER", "TAVILY_API_KEY", "GOOGLE_CSE_API_KEY", "GOOGLE_CSE_ID"]) {
    vi.stubEnv(name, "");
  }
  for (const name of ["HANGEUL_BASE_URL", "HANGEUL_USERNAME", "HANGEUL_PASSWORD", "MOCK_MODE", "JEANNIE_ACCESS_KEY"]) vi.stubEnv(name, "");
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("splitMessage", () => {
  it("keeps short text whole and splits long text at line breaks under the limit", () => {
    expect(splitMessage("hello")).toEqual(["hello"]);
    const paragraph = `${"word ".repeat(700).trim()}\n`;
    const chunks = splitMessage(paragraph.repeat(4));
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) expect(chunk.length).toBeLessThanOrEqual(TELEGRAM_CHUNK_SIZE);
    const same = chunks.join(" ").replace(/\s+/g, " ") === paragraph.repeat(4).replace(/\s+/g, " ").trim();
    expect(same).toBe(true);
  });

  it("hard-splits text without spaces and never breaks a surrogate pair", () => {
    const text = `${"a".repeat(TELEGRAM_CHUNK_SIZE - 1)}😀${"b".repeat(10)}`;
    const chunks = splitMessage(text);
    expect(chunks[0]).toBe("a".repeat(TELEGRAM_CHUNK_SIZE - 1));
    expect(chunks[1].startsWith("😀")).toBe(true);
  });
});

describe("Bot API client", () => {
  it("sends plain text (no parse_mode) in 4000-character chunks", async () => {
    const tg = fakeTelegram();
    expect(await sendMessage(ADMIN, "x".repeat(9000))).toBe(true);
    const sent = tg.sent();
    expect(sent).toHaveLength(3);
    for (const payload of sent) {
      expect(payload.chat_id).toBe(ADMIN);
      expect(payload).not.toHaveProperty("parse_mode");
      expect(String(payload.text).length).toBeLessThanOrEqual(4000);
    }
  });

  it("notifyAdmin is false without an admin chat and true when delivered", async () => {
    const tg = fakeTelegram();
    expect(await notifyAdmin("daily report")).toBe(true);
    expect(tg.sent()[0]).toMatchObject({ chat_id: String(ADMIN), text: "daily report" });

    vi.stubEnv("TELEGRAM_ADMIN_CHAT_ID", "");
    expect(await notifyAdmin("daily report")).toBe(false);
  });

  it("downloads images as data URLs and rejects files over 4 MB", async () => {
    fakeTelegram();
    expect(await downloadFileAsDataUrl("file-1")).toMatch(/^data:image\/jpeg;base64,\/\/\/\//);

    fakeTelegram({ fileSize: 5 * 1024 * 1024 });
    expect(await downloadFileAsDataUrl("file-2")).toBeNull();

    fakeTelegram({ fileSize: 0, fileBytes: 4 * 1024 * 1024 + 1 });
    expect(await downloadFileAsDataUrl("file-3")).toBeNull();

    fakeTelegram({ filePath: "documents/file.pdf" });
    expect(await downloadFileAsDataUrl("file-4")).toBeNull();
  });
});

describe("handleTelegramUpdate", () => {
  it("answers IoT commands with exactly the fixed sentence", async () => {
    const tg = fakeTelegram();
    await handleTelegramUpdate(textUpdate(ADMIN, "Turn on the kitchen lights"));
    await handleTelegramUpdate(textUpdate(ADMIN, "거실 불 꺼줘"));
    expect(tg.sent().map((p) => p.text)).toEqual(["Yes, it is done.", "네, 처리되었습니다."]);
    expect(tg.other).toEqual([]);
  });

  it("keeps a private instance private but still answers /whoami", async () => {
    const tg = fakeTelegram();
    await handleTelegramUpdate(textUpdate(STRANGER, "Tell me a joke"));
    await handleTelegramUpdate(textUpdate(STRANGER, "/whoami"));
    const [privateReply, whoami] = tg.sent().map((p) => String(p.text));
    expect(privateReply).toContain("This Jeannie instance is private.");
    expect(whoami).toContain(`Your chat id is ${STRANGER}.`);
    expect(tg.calls.every((c) => c.payload.chat_id === STRANGER)).toBe(true);
  });

  it("/whoami suggests TELEGRAM_ADMIN_CHAT_ID when none is set, and everyone is answered", async () => {
    vi.stubEnv("TELEGRAM_ADMIN_CHAT_ID", "");
    const tg = fakeTelegram();
    await handleTelegramUpdate(textUpdate(STRANGER, "/whoami@JeannieBot"));
    await handleTelegramUpdate(textUpdate(STRANGER, "switch off the fan"));
    const [whoami, iot] = tg.sent().map((p) => String(p.text));
    expect(whoami).toContain(`TELEGRAM_ADMIN_CHAT_ID=${STRANGER}`);
    expect(iot).toBe("Yes, it is done.");
  });

  it("handles /start, /help, /status (no secrets) and unknown commands", async () => {
    vi.stubEnv("OPENAI_API_KEY", "sk-live-secret");
    vi.stubEnv("JEANNIE_ACCESS_KEY", "access-secret");
    const tg = fakeTelegram();
    for (const text of ["/start", "/help", "/status", "/frobnicate"]) await handleTelegramUpdate(textUpdate(ADMIN, text));
    const [start, help, status, unknown] = tg.sent().map((p) => String(p.text));
    expect(start).toContain("I'm Jeannie");
    expect(start).toContain("안녕하세요");
    expect(help).toContain("/report");
    expect(status).toContain("Language model: openai");
    expect(status).toContain("Admin chat: this chat");
    for (const secret of [TOKEN, "sk-live-secret", "access-secret"]) expect(status).not.toContain(secret);
    expect(unknown).toContain("/help");
  });

  it("/report is live only for the admin chat", async () => {
    vi.stubEnv("HANGEUL_BASE_URL", "https://portal.example");
    vi.stubEnv("HANGEUL_USERNAME", "u");
    vi.stubEnv("HANGEUL_PASSWORD", "p");
    const tg = fakeTelegram();
    await handleTelegramUpdate(textUpdate(ADMIN, "/report"));
    expect(tg.other).toEqual(["https://portal.example/api/reports/daily"]);
    // The portal mock answers 500, so the admin sees the labelled fallback.
    expect(String(tg.sent()[0].text)).toContain("Live portal request failed (portal answered HTTP 500)");

    vi.stubEnv("TELEGRAM_ADMIN_CHAT_ID", "");
    const open = fakeTelegram();
    await handleTelegramUpdate(textUpdate(STRANGER, "/report"));
    expect(open.other).toEqual([]);
    expect(String(open.sent()[0].text)).toContain("only shared with trusted callers");
  });

  it("/search returns numbered results and asks for a query when empty", async () => {
    const tg = fakeTelegram();
    await handleTelegramUpdate(textUpdate(ADMIN, "/search Seoul"));
    await handleTelegramUpdate(textUpdate(ADMIN, "/search"));
    const [results, usage] = tg.sent().map((p) => String(p.text));
    expect(results).toContain("[1] Seoul — Capital of Korea. — https://en.wikipedia.org/wiki/Seoul");
    expect(usage).toContain("Usage: /search");
  });

  it("routes other text through the orchestrator and appends sources", async () => {
    const tg = fakeTelegram();
    await handleTelegramUpdate(textUpdate(ADMIN, "latest news about Seoul"));
    const reply = String(tg.sent()[0].text);
    expect(reply).toContain("Here's what the live web says");
    expect(reply).toContain("https://en.wikipedia.org/wiki/Seoul");
    expect(tg.calls.some((c) => c.method === "sendChatAction")).toBe(true);
  });

  it("sends the largest photo to the vision agent", async () => {
    const tg = fakeTelegram();
    await handleTelegramUpdate(
      textUpdate(ADMIN, "", {
        text: undefined,
        caption: "What does this say?",
        photo: [
          { file_id: "small", width: 90, height: 90, file_size: 1000 },
          { file_id: "large", width: 1280, height: 960, file_size: 200_000 },
          { file_id: "medium", width: 320, height: 240, file_size: 20_000 },
        ],
      }),
    );
    expect(tg.calls.find((c) => c.method === "getFile")?.payload.file_id).toBe("large");
    // No LLM configured, so the vision agent explains how to enable it.
    expect(String(tg.sent()[0].text)).toMatch(/vision-capable model/);
  });

  it("rejects photos over 4 MB without downloading", async () => {
    const tg = fakeTelegram();
    await handleTelegramUpdate(
      textUpdate(ADMIN, "", { text: undefined, photo: [{ file_id: "huge", width: 5000, height: 5000, file_size: 6_000_000 }] }),
    );
    expect(tg.calls.some((c) => c.method === "getFile")).toBe(false);
    expect(String(tg.sent()[0].text)).toContain("larger than 4 MB");
  });

  it("ignores non-message updates and bot authors", async () => {
    const tg = fakeTelegram();
    await handleTelegramUpdate({ update_id: 5, edited_message: textUpdate(ADMIN, "turn on the tv").message });
    await handleTelegramUpdate({ update_id: 6, callback_query: { id: "x" } });
    await handleTelegramUpdate(textUpdate(ADMIN, "hi", { from: { id: 99, is_bot: true } }));
    await handleTelegramUpdate(null);
    expect(tg.fetchMock).not.toHaveBeenCalled();
  });
});

describe("webhook route", () => {
  const post = (body: unknown, headers: Record<string, string> = {}) =>
    webhook(
      new Request("http://localhost/api/telegram/webhook", {
        method: "POST",
        headers: { "content-type": "application/json", ...headers },
        body: typeof body === "string" ? body : JSON.stringify(body),
      }),
    );

  it("checks the secret token when configured", async () => {
    vi.stubEnv("TELEGRAM_WEBHOOK_SECRET", "hook-secret");
    const tg = fakeTelegram();
    expect((await post(textUpdate(ADMIN, "turn on the lights"))).status).toBe(401);
    expect((await post(textUpdate(ADMIN, "turn on the lights"), { "x-telegram-bot-api-secret-token": "wrong" })).status).toBe(401);
    expect(tg.fetchMock).not.toHaveBeenCalled();

    const ok = await post(textUpdate(ADMIN, "turn on the lights"), { "x-telegram-bot-api-secret-token": "hook-secret" });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ ok: true });
    expect(tg.sent()[0].text).toBe("Yes, it is done.");
  });

  it("503 without a bot token, 400 on bad JSON, 200 even when handling fails", async () => {
    vi.stubEnv("TELEGRAM_BOT_TOKEN", "");
    expect((await post(textUpdate(ADMIN, "hi"))).status).toBe(503);

    vi.stubEnv("TELEGRAM_BOT_TOKEN", TOKEN);
    fakeTelegram();
    expect((await post("{not json")).status).toBe(400);

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("telegram down");
      }),
    );
    const res = await post(textUpdate(ADMIN, "turn on the lights"));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });
});
