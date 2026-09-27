// Jeannie's server voice: ElevenLabs (when configured) → Microsoft Edge neural
// voices → TtsUnavailableError (the HUD then falls back to browser speech).
// Node.js runtime only (Edge TTS uses `ws`).

import { getEnv } from "../env";
import { detectLanguage, stripMarkdownForSpeech } from "../utils";
import { EdgeTtsError, synthesizeEdgeTts } from "./edge-tts";

export type ServerTtsEngine = "elevenlabs" | "edge";

export interface SpeechResult {
  audio: Uint8Array<ArrayBuffer>;
  engine: ServerTtsEngine;
  contentType: "audio/mpeg";
}

export interface EngineFailure {
  engine: ServerTtsEngine;
  /** Short, secret-free reason ("not configured", "HTTP 401", "timeout"...). */
  reason: string;
}

/** Every server engine failed or is unconfigured. Message and failures never contain secrets. */
export class TtsUnavailableError extends Error {
  readonly failures: EngineFailure[];

  constructor(failures: EngineFailure[]) {
    const detail = failures.map((f) => `${f.engine}: ${f.reason}`).join("; ");
    super(`No server voice available (${detail}).`);
    this.name = "TtsUnavailableError";
    this.failures = failures;
  }
}

/** The text has nothing speakable once markdown, code and URLs are removed. */
export class TtsInputError extends Error {
  constructor(message = "Nothing to speak after removing markdown, code and links.") {
    super(message);
    this.name = "TtsInputError";
  }
}

export const ELEVENLABS_TIMEOUT_MS = 20_000;
// Stay inside the route's 30 s maxDuration even when ElevenLabs used its full timeout.
const TOTAL_BUDGET_MS = 27_000;
const EDGE_MAX_MS = 25_000;
const EDGE_MIN_MS = 2_000;

export const ELEVENLABS_VOICE_SETTINGS = {
  stability: 0.5,
  similarity_boost: 0.75,
  style: 0.25,
  use_speaker_boost: true,
} as const;

class EngineError extends Error {}

function withTimeout(ms: number, signal?: AbortSignal): AbortSignal {
  const timeout = AbortSignal.timeout(ms);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

async function synthesizeElevenLabs(
  text: string,
  config: { apiKey: string; voiceId: string; modelId: string },
  signal?: AbortSignal,
): Promise<Uint8Array<ArrayBuffer>> {
  const url =
    `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(config.voiceId)}` +
    "?output_format=mp3_44100_128";
  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: { "xi-api-key": config.apiKey, "Content-Type": "application/json", Accept: "audio/mpeg" },
      body: JSON.stringify({ text, model_id: config.modelId, voice_settings: ELEVENLABS_VOICE_SETTINGS }),
      signal: withTimeout(ELEVENLABS_TIMEOUT_MS, signal),
    });
  } catch (error) {
    const name = error instanceof Error ? error.name : "";
    throw new EngineError(name === "TimeoutError" ? "timeout" : name === "AbortError" ? "aborted" : "network error");
  }
  if (!res.ok) {
    await res.body?.cancel().catch(() => undefined);
    throw new EngineError(`HTTP ${res.status}`);
  }
  const audio = new Uint8Array(await res.arrayBuffer());
  if (audio.byteLength === 0) throw new EngineError("empty audio");
  return audio;
}

function reasonOf(error: unknown): string {
  if (error instanceof EngineError) return error.message;
  if (error instanceof EdgeTtsError) return error.status ? `${error.code} (HTTP ${error.status})` : error.code;
  return "unexpected error";
}

/**
 * Speak `text` as Jeannie. Markdown is stripped first; `lang` picks the Edge
 * voice and defaults to the detected language of the text.
 * Throws TtsInputError (nothing speakable) or TtsUnavailableError.
 */
export async function synthesizeSpeech(options: {
  text: string;
  lang?: "en" | "ko";
  signal?: AbortSignal;
}): Promise<SpeechResult> {
  const text = stripMarkdownForSpeech(options.text);
  if (!text) throw new TtsInputError();
  const lang = options.lang ?? detectLanguage(text);
  const { tts } = getEnv();
  const deadline = Date.now() + TOTAL_BUDGET_MS;
  const failures: EngineFailure[] = [];

  if (tts.elevenLabsApiKey && tts.elevenLabsVoiceId) {
    try {
      const audio = await synthesizeElevenLabs(
        text,
        { apiKey: tts.elevenLabsApiKey, voiceId: tts.elevenLabsVoiceId, modelId: tts.elevenLabsModelId },
        options.signal,
      );
      return { audio, engine: "elevenlabs", contentType: "audio/mpeg" };
    } catch (error) {
      failures.push({ engine: "elevenlabs", reason: reasonOf(error) });
    }
  } else {
    failures.push({ engine: "elevenlabs", reason: "not configured" });
  }

  if (!tts.edgeEnabled) {
    failures.push({ engine: "edge", reason: "disabled" });
  } else if (options.signal?.aborted) {
    failures.push({ engine: "edge", reason: "aborted" });
  } else {
    try {
      const audio = await synthesizeEdgeTts({
        text,
        voice: lang === "ko" ? tts.edgeVoiceKo : tts.edgeVoiceEn,
        signal: options.signal,
        timeoutMs: Math.min(EDGE_MAX_MS, Math.max(EDGE_MIN_MS, deadline - Date.now())),
      });
      return { audio, engine: "edge", contentType: "audio/mpeg" };
    } catch (error) {
      failures.push({ engine: "edge", reason: reasonOf(error) });
    }
  }

  throw new TtsUnavailableError(failures);
}
