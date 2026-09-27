// Typed fetch wrappers for the HUD. Every call carries the stored access key and
// a timeout, and every failure surfaces as an ApiRequestError so the UI can show
// a calm system line instead of crashing. User-initiated aborts are rethrown as
// the original AbortError so callers can tell "stopped" from "failed".

import {
  ACCESS_KEY_HEADER,
  CHAT_HEADERS,
  TTS_ENGINE_HEADER,
  type AgentId,
  type ApiError,
  type ChatRequestBody,
  type HangeulStatus,
  type LlmProvider,
  type ResolvedLang,
  type SourceLink,
  type SystemStatus,
  type TtsEngine,
  type TtsRequestBody,
} from "@/lib/types";
import { decodeHeaderJson } from "@/lib/utils";

const ACCESS_KEY_STORAGE = "jeannie.accessKey";

const STATUS_TIMEOUT_MS = 8_000;
const CHAT_TIMEOUT_MS = 180_000; // covers the whole streamed answer, not just the headers
const TTS_TIMEOUT_MS = 30_000;
const HANGEUL_TIMEOUT_MS = 15_000;

// ── Access key storage ───────────────────────────────────────────────────────
// Storage can throw (private mode, blocked site data), so every access is guarded.

export function readAccessKey(): string | null {
  try {
    const value = window.localStorage.getItem(ACCESS_KEY_STORAGE);
    return value && value.trim() ? value.trim() : null;
  } catch {
    return null;
  }
}

export function writeAccessKey(key: string | null): void {
  try {
    if (key && key.trim()) window.localStorage.setItem(ACCESS_KEY_STORAGE, key.trim());
    else window.localStorage.removeItem(ACCESS_KEY_STORAGE);
  } catch {
    // Not persisted; the key still works for requests made from memory this session.
  }
}

// ── Errors ──────────────────────────────────────────────────────────────────

export class ApiRequestError extends Error {
  /** HTTP status, or 0 for network failures and timeouts. */
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = "ApiRequestError";
    this.status = status;
    this.code = code;
  }

  get needsAccessKey(): boolean {
    return this.status === 401 && this.code === "access_key_required";
  }
}

export function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

function fallbackMessage(status: number): string {
  if (status === 404) return "Endpoint not deployed yet.";
  if (status === 401) return "Access key required.";
  if (status === 413) return "Payload too large.";
  if (status === 429) return "Rate limited. Try again in a moment.";
  if (status >= 500) return "Upstream service error.";
  return `Request failed (${status}).`;
}

async function errorFromResponse(res: Response): Promise<ApiRequestError> {
  let body: Partial<ApiError> | null = null;
  try {
    body = (await res.json()) as Partial<ApiError>;
  } catch {
    body = null;
  }
  const code = typeof body?.code === "string" ? body.code : `http_${res.status}`;
  const message = typeof body?.error === "string" && body.error ? body.error : fallbackMessage(res.status);
  return new ApiRequestError(res.status, code, message);
}

// ── Fetch core ──────────────────────────────────────────────────────────────

/** Combines the caller's signal with a timeout. AbortSignal.any is missing in older Safari. */
function withTimeout(ms: number, signal?: AbortSignal): AbortSignal {
  const timeout = AbortSignal.timeout(ms);
  if (!signal) return timeout;
  if (typeof AbortSignal.any === "function") return AbortSignal.any([signal, timeout]);
  const controller = new AbortController();
  const forward = (source: AbortSignal) => () => controller.abort(source.reason);
  for (const source of [signal, timeout]) {
    if (source.aborted) controller.abort(source.reason);
    else source.addEventListener("abort", forward(source), { once: true });
  }
  return controller.signal;
}

function authHeaders(extra?: Record<string, string>): Headers {
  const headers = new Headers(extra);
  const key = readAccessKey();
  if (key) headers.set(ACCESS_KEY_HEADER, key);
  return headers;
}

async function request(
  path: string,
  init: { method?: "GET" | "POST"; body?: unknown; signal?: AbortSignal; timeoutMs: number },
): Promise<Response> {
  const headers = authHeaders(init.body === undefined ? undefined : { "content-type": "application/json" });
  let res: Response;
  try {
    res = await fetch(path, {
      method: init.method ?? "GET",
      headers,
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
      signal: withTimeout(init.timeoutMs, init.signal),
      cache: "no-store",
    });
  } catch (error) {
    throw normalizeFetchError(error, init.signal);
  }
  if (!res.ok) throw await errorFromResponse(res);
  return res;
}

function normalizeFetchError(error: unknown, userSignal?: AbortSignal): unknown {
  if (userSignal?.aborted) return new DOMException("Aborted by user", "AbortError");
  if (error instanceof DOMException && (error.name === "TimeoutError" || error.name === "AbortError")) {
    return new ApiRequestError(0, "timeout", "The uplink timed out.");
  }
  if (error instanceof ApiRequestError) return error;
  return new ApiRequestError(0, "network_error", "Uplink unreachable. Check your connection.");
}

// ── Status ──────────────────────────────────────────────────────────────────

export async function fetchSystemStatus(signal?: AbortSignal): Promise<SystemStatus> {
  const res = await request("/api/status", { signal, timeoutMs: STATUS_TIMEOUT_MS });
  try {
    return (await res.json()) as SystemStatus;
  } catch {
    throw new ApiRequestError(res.status, "invalid_response", "Status feed returned malformed data.");
  }
}

// ── Chat ────────────────────────────────────────────────────────────────────

export interface ChatStreamMeta {
  agent: AgentId | null;
  lang: ResolvedLang | null;
  provider: LlmProvider | null;
  sources: SourceLink[];
}

const AGENTS: readonly AgentId[] = ["iot", "search", "vision", "hangeul", "core", "offline"];
const LANGS: readonly ResolvedLang[] = ["en", "ko", "bilingual"];
const PROVIDERS: readonly LlmProvider[] = ["openai", "ollama", "none"];

function pick<T extends string>(value: string | null, allowed: readonly T[]): T | null {
  const normalized = value?.trim().toLowerCase();
  return normalized && (allowed as readonly string[]).includes(normalized) ? (normalized as T) : null;
}

function safeSources(value: unknown): SourceLink[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter(
      (item): item is SourceLink =>
        typeof item === "object" &&
        item !== null &&
        typeof (item as SourceLink).url === "string" &&
        /^https?:\/\//i.test((item as SourceLink).url),
    )
    .map((item) => ({ url: item.url, title: typeof item.title === "string" && item.title ? item.title : item.url }))
    .slice(0, 5);
}

export function readChatMeta(headers: Headers): ChatStreamMeta {
  return {
    agent: pick(headers.get(CHAT_HEADERS.agent), AGENTS),
    lang: pick(headers.get(CHAT_HEADERS.lang), LANGS),
    provider: pick(headers.get(CHAT_HEADERS.provider), PROVIDERS),
    sources: safeSources(decodeHeaderJson<unknown>(headers.get(CHAT_HEADERS.sources))),
  };
}

export interface ChatStream {
  meta: ChatStreamMeta;
  /** Decoded text chunks as they arrive. */
  chunks: AsyncGenerator<string, void, undefined>;
}

/** POST /api/chat. Resolves once headers arrive; iterate `chunks` for the streamed answer. */
export async function openChatStream(body: ChatRequestBody, signal?: AbortSignal): Promise<ChatStream> {
  const res = await request("/api/chat", { method: "POST", body, signal, timeoutMs: CHAT_TIMEOUT_MS });
  if (!res.body) throw new ApiRequestError(res.status, "empty_response", "The reply stream was empty.");
  return { meta: readChatMeta(res.headers), chunks: readTextStream(res.body, signal) };
}

async function* readTextStream(stream: ReadableStream<Uint8Array>, signal?: AbortSignal) {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  try {
    while (true) {
      let result: ReadableStreamReadResult<Uint8Array>;
      try {
        result = await reader.read();
      } catch (error) {
        throw normalizeFetchError(error, signal);
      }
      if (result.done) break;
      const text = decoder.decode(result.value, { stream: true });
      if (text) yield text;
    }
    const tail = decoder.decode();
    if (tail) yield tail;
  } finally {
    reader.releaseLock();
  }
}

// ── Voice ───────────────────────────────────────────────────────────────────

export interface SpeechAudio {
  audio: Blob;
  engine: TtsEngine;
}

/** POST /api/tts. A 503 (`tts_unavailable`) means "use the browser voice". */
export async function requestSpeech(payload: TtsRequestBody, signal?: AbortSignal): Promise<SpeechAudio> {
  const res = await request("/api/tts", { method: "POST", body: payload, signal, timeoutMs: TTS_TIMEOUT_MS });
  const type = res.headers.get("content-type") ?? "";
  if (!type.startsWith("audio/"))
    throw new ApiRequestError(res.status, "invalid_response", "Voice engine sent no audio.");
  let audio: Blob;
  try {
    audio = await res.blob();
  } catch (error) {
    throw normalizeFetchError(error, signal);
  }
  const engine = res.headers.get(TTS_ENGINE_HEADER) === "elevenlabs" ? "elevenlabs" : "edge";
  return { audio, engine };
}

// ── Hangeul bridge ─────────────────────────────────────────────────────────

export async function fetchHangeulStatus(signal?: AbortSignal): Promise<HangeulStatus> {
  const res = await request("/api/hangeul?action=status", { signal, timeoutMs: HANGEUL_TIMEOUT_MS });
  try {
    const data = (await res.json()) as { status?: HangeulStatus };
    if (!data.status) throw new Error("missing status");
    return data.status;
  } catch {
    throw new ApiRequestError(res.status, "invalid_response", "Hangeul bridge returned malformed data.");
  }
}
