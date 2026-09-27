import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EdgeTtsError, synthesizeEdgeTts } from "@/lib/agents/edge-tts";
import { synthesizeSpeech, TtsInputError, TtsUnavailableError } from "@/lib/agents/tts-engine";
import { POST } from "@/app/api/tts/route";
import { TTS_ENGINE_HEADER } from "@/lib/types";

vi.mock("@/lib/agents/edge-tts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/agents/edge-tts")>();
  return { ...actual, synthesizeEdgeTts: vi.fn() };
});

const edgeMock = vi.mocked(synthesizeEdgeTts);
const EDGE_AUDIO = new Uint8Array([0xff, 0xf3, 0x44, 0xc4]);
const ELEVEN_AUDIO = new Uint8Array([0x49, 0x44, 0x33, 0x04, 0x00]);
const API_KEY = "sk_test_secret_key_123";

function setEnv(values: Record<string, string>) {
  const defaults: Record<string, string> = {
    ELEVENLABS_API_KEY: "",
    ELEVENLABS_VOICE_ID: "",
    ELEVENLABS_MODEL_ID: "",
    EDGE_TTS_VOICE_EN: "",
    EDGE_TTS_VOICE_KO: "",
    EDGE_TTS_ENABLED: "",
    JEANNIE_ACCESS_KEY: "",
  };
  for (const [name, value] of Object.entries({ ...defaults, ...values })) vi.stubEnv(name, value);
}

function withElevenLabs(extra: Record<string, string> = {}) {
  setEnv({ ELEVENLABS_API_KEY: API_KEY, ELEVENLABS_VOICE_ID: "voice/abc", ...extra });
}

function audioResponse(bytes: Uint8Array, status = 200) {
  return new Response(bytes, { status, headers: { "content-type": "audio/mpeg" } });
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  setEnv({});
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
  edgeMock.mockReset();
  edgeMock.mockResolvedValue(EDGE_AUDIO);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("synthesizeSpeech: ElevenLabs", () => {
  it("posts the documented request and returns its audio", async () => {
    withElevenLabs();
    fetchMock.mockResolvedValue(audioResponse(ELEVEN_AUDIO));

    const result = await synthesizeSpeech({ text: "**Good evening**, operator." });

    expect(result).toEqual({ audio: ELEVEN_AUDIO, engine: "elevenlabs", contentType: "audio/mpeg" });
    expect(edgeMock).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.elevenlabs.io/v1/text-to-speech/voice%2Fabc?output_format=mp3_44100_128");
    expect(init.method).toBe("POST");
    expect(init.headers).toEqual({
      "xi-api-key": API_KEY,
      "Content-Type": "application/json",
      Accept: "audio/mpeg",
    });
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(JSON.parse(init.body as string)).toEqual({
      text: "Good evening, operator.",
      model_id: "eleven_multilingual_v2",
      voice_settings: { stability: 0.5, similarity_boost: 0.75, style: 0.25, use_speaker_boost: true },
    });
  });

  it("uses ELEVENLABS_MODEL_ID when set", async () => {
    withElevenLabs({ ELEVENLABS_MODEL_ID: "eleven_turbo_v2_5" });
    fetchMock.mockResolvedValue(audioResponse(ELEVEN_AUDIO));
    await synthesizeSpeech({ text: "Hi." });
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(init.body as string).model_id).toBe("eleven_turbo_v2_5");
  });

  it("is skipped when the key or voice id is missing (placeholders count as unset)", async () => {
    setEnv({ ELEVENLABS_API_KEY: "your_elevenlabs_api_key", ELEVENLABS_VOICE_ID: "voice" });
    const result = await synthesizeSpeech({ text: "Hello." });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(result.engine).toBe("edge");
  });
});

describe("synthesizeSpeech: Edge fallback", () => {
  it("falls back to Edge when ElevenLabs fails", async () => {
    withElevenLabs();
    fetchMock.mockResolvedValue(new Response("quota exceeded", { status: 401 }));

    const result = await synthesizeSpeech({ text: "Status report, please." });

    expect(result).toEqual({ audio: EDGE_AUDIO, engine: "edge", contentType: "audio/mpeg" });
    expect(edgeMock).toHaveBeenCalledTimes(1);
    const options = edgeMock.mock.calls[0][0];
    expect(options.text).toBe("Status report, please.");
    expect(options.voice).toBe("en-US-JennyNeural");
    expect(options.timeoutMs).toBeGreaterThan(0);
    expect(options.timeoutMs).toBeLessThanOrEqual(25_000);
  });

  it("falls back when the ElevenLabs request throws", async () => {
    withElevenLabs();
    fetchMock.mockRejectedValue(new TypeError("fetch failed"));
    const result = await synthesizeSpeech({ text: "Hello." });
    expect(result.engine).toBe("edge");
  });

  it("picks the Korean voice for Korean text and honours an explicit lang", async () => {
    await synthesizeSpeech({ text: "안녕하세요, 지니예요." });
    expect(edgeMock.mock.calls[0][0].voice).toBe("ko-KR-SunHiNeural");

    await synthesizeSpeech({ text: "안녕하세요", lang: "en" });
    expect(edgeMock.mock.calls[1][0].voice).toBe("en-US-JennyNeural");

    await synthesizeSpeech({ text: "Hello", lang: "ko" });
    expect(edgeMock.mock.calls[2][0].voice).toBe("ko-KR-SunHiNeural");
  });

  it("uses the configured Edge voices", async () => {
    setEnv({ EDGE_TTS_VOICE_EN: "en-US-AriaNeural", EDGE_TTS_VOICE_KO: "ko-KR-JiMinNeural" });
    await synthesizeSpeech({ text: "Hello." });
    await synthesizeSpeech({ text: "안녕하세요." });
    expect(edgeMock.mock.calls.map((call) => call[0].voice)).toEqual(["en-US-AriaNeural", "ko-KR-JiMinNeural"]);
  });

  it("strips markdown, code and links before speaking", async () => {
    await synthesizeSpeech({ text: "## Result\n- See [the docs](https://example.com) and `npm test`.\n```\ncode\n```" });
    expect(edgeMock.mock.calls[0][0].text).toBe("Result See the docs and npm test.");
  });

  it("throws TtsInputError when nothing speakable remains", async () => {
    await expect(synthesizeSpeech({ text: "```\nconst x = 1;\n```" })).rejects.toBeInstanceOf(TtsInputError);
    expect(edgeMock).not.toHaveBeenCalled();
  });
});

describe("synthesizeSpeech: all engines down", () => {
  it("throws TtsUnavailableError listing each failure without secrets", async () => {
    withElevenLabs();
    fetchMock.mockResolvedValue(new Response(`bad key ${API_KEY}`, { status: 401 }));
    edgeMock.mockRejectedValue(new EdgeTtsError("forbidden", "Edge TTS handshake rejected with HTTP 403.", { status: 403 }));

    const error = await synthesizeSpeech({ text: "Hello." }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(TtsUnavailableError);
    const unavailable = error as TtsUnavailableError;
    expect(unavailable.failures).toEqual([
      { engine: "elevenlabs", reason: "HTTP 401" },
      { engine: "edge", reason: "forbidden (HTTP 403)" },
    ]);
    expect(unavailable.message).toContain("elevenlabs: HTTP 401");
    expect(unavailable.message).not.toContain(API_KEY);
  });

  it("reports unconfigured and disabled engines", async () => {
    setEnv({ EDGE_TTS_ENABLED: "false" });
    const error = await synthesizeSpeech({ text: "Hello." }).catch((e: unknown) => e);
    expect((error as TtsUnavailableError).failures).toEqual([
      { engine: "elevenlabs", reason: "not configured" },
      { engine: "edge", reason: "disabled" },
    ]);
    expect(edgeMock).not.toHaveBeenCalled();
  });

  it("maps an Edge timeout to a short reason", async () => {
    edgeMock.mockRejectedValue(new EdgeTtsError("timeout", "Edge TTS timed out after 25000 ms."));
    const error = await synthesizeSpeech({ text: "Hello." }).catch((e: unknown) => e);
    expect((error as TtsUnavailableError).failures[1]).toEqual({ engine: "edge", reason: "timeout" });
  });
});

describe("POST /api/tts", () => {
  function ttsRequest(body: unknown, headers: Record<string, string> = {}) {
    return new Request("http://localhost/api/tts", {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: typeof body === "string" ? body : JSON.stringify(body),
    });
  }

  it("returns audio/mpeg with the engine header", async () => {
    const res = await POST(ttsRequest({ text: "  Hello there.  " }));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("audio/mpeg");
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get(TTS_ENGINE_HEADER)).toBe("edge");
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(EDGE_AUDIO);
    expect(edgeMock.mock.calls[0][0].text).toBe("Hello there.");
  });

  it("passes lang through", async () => {
    await POST(ttsRequest({ text: "Hello", lang: "ko" }));
    expect(edgeMock.mock.calls[0][0].voice).toBe("ko-KR-SunHiNeural");
  });

  it.each([
    ["invalid JSON", "{not json", "invalid_json"],
    ["missing text", {}, "invalid_request"],
    ["blank text", { text: "   " }, "invalid_request"],
    ["too long", { text: "a".repeat(2001) }, "invalid_request"],
    ["bad lang", { text: "Hello", lang: "fr" }, "invalid_request"],
    ["wrong type", { text: 42 }, "invalid_request"],
  ])("400 on %s", async (_name, body, code) => {
    const res = await POST(ttsRequest(body));
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ code });
    expect(edgeMock).not.toHaveBeenCalled();
  });

  it("accepts exactly 2000 characters", async () => {
    const res = await POST(ttsRequest({ text: "a".repeat(2000) }));
    expect(res.status).toBe(200);
  });

  it("400 when nothing speakable remains", async () => {
    const res = await POST(ttsRequest({ text: "https://example.com" }));
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ code: "nothing_to_speak" });
  });

  it("401 without the access key, 200 with it", async () => {
    setEnv({ JEANNIE_ACCESS_KEY: "open-sesame" });
    const denied = await POST(ttsRequest({ text: "Hello" }));
    expect(denied.status).toBe(401);
    expect(edgeMock).not.toHaveBeenCalled();

    const allowed = await POST(ttsRequest({ text: "Hello" }, { "x-jeannie-key": "open-sesame" }));
    expect(allowed.status).toBe(200);
  });

  it("503 tts_unavailable when every engine fails", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    edgeMock.mockRejectedValue(new EdgeTtsError("socket", "Edge TTS socket error: ECONNRESET"));
    const res = await POST(ttsRequest({ text: "Hello" }));
    expect(res.status).toBe(503);
    expect(res.headers.get("content-type")).toContain("application/json");
    const body = await res.json();
    expect(body.code).toBe("tts_unavailable");
    expect(body.error).toContain("edge: socket");
  });

  it("503 on unexpected engine errors instead of crashing", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    edgeMock.mockImplementation(() => {
      throw new RangeError("boom");
    });
    const res = await POST(ttsRequest({ text: "Hello" }));
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ code: "tts_unavailable" });
  });
});
