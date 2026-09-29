// Shared contracts between the HUD (client), the API routes and the agents.
// Keep this file dependency-free so it can be imported from any runtime.

/** Language the user picked in the HUD. `auto` detects from the message text. */
export type LangMode = "auto" | "en" | "ko" | "bilingual";

/** Language Jeannie actually answers in, after resolving `auto`. */
export type ResolvedLang = "en" | "ko" | "bilingual";

/** Which specialist handled a message. */
export type AgentId =
  | "iot" // IoT Interceptor: deterministic smart-home confirmation
  | "search" // Live Search Agent
  | "vision" // Multimodal Vision & Korean/English Localization Agent
  | "hangeul" // Hangeul Admin & Reporting Bridge
  | "core" // General Cognitive Agent (LLM, may still call the search tool)
  | "offline"; // No LLM configured/reachable: canned or search-only answers

export type LlmProvider = "deepseek" | "anthropic" | "openai" | "ollama" | "none";

export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
  /** Optional image as a data URL (`data:image/jpeg;base64,...`). User messages only. */
  image?: string | null;
}

/** POST /api/chat body. */
export interface ChatRequestBody {
  messages: ChatMessage[];
  /** Image for the latest user message (data URL). Same as setting `image` on that message. */
  image?: string | null;
  lang?: LangMode;
}

/**
 * /api/chat response contract:
 *  - 200, `Content-Type: text/plain; charset=utf-8`, body = streamed answer text.
 *  - Metadata in headers (see CHAT_HEADERS). Sources are `encodeHeaderJson(SourceLink[])`.
 *  - Errors: JSON `ApiError` with 4xx/5xx.
 */
export const CHAT_HEADERS = {
  agent: "x-jeannie-agent",
  lang: "x-jeannie-lang",
  provider: "x-jeannie-provider",
  sources: "x-jeannie-sources",
} as const;

/** Header carrying the access key from the HUD (alternatively `Authorization: Bearer`). */
export const ACCESS_KEY_HEADER = "x-jeannie-key";

export interface SourceLink {
  title: string;
  url: string;
}

export interface ApiError {
  error: string;
  code: string;
}

export type SearchProvider = "tavily" | "google" | "duckduckgo";

export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
  source: SearchProvider;
  publishedDate?: string;
}

/** GET/POST /api/search response. */
export interface SearchResponse {
  query: string;
  provider: SearchProvider | "none";
  /** Short synthesized answer when the provider offers one (Tavily, DuckDuckGo instant answers). */
  answer?: string;
  results: SearchResult[];
  /** Human-readable note when every provider failed or none is configured. */
  error?: string;
}

/** POST /api/tts body. Response: `audio/mpeg` bytes, or JSON ApiError (503 = use browser voice). */
export interface TtsRequestBody {
  text: string;
  lang?: "en" | "ko";
}

export type TtsEngine = "elevenlabs" | "edge" | "browser";

/** Header on /api/tts audio responses naming the engine that produced it. */
export const TTS_ENGINE_HEADER = "x-jeannie-tts-engine";

export interface HangeulMetric {
  label: string;
  value: string | number;
}

export interface HangeulReport {
  /** "live" = fetched from the portal; "mock" = demo data; "mock-fallback" = live failed. */
  source: "live" | "mock" | "mock-fallback";
  generatedAt: string; // ISO timestamp
  title: string;
  metrics: HangeulMetric[];
  highlights: string[];
  /** Why live data was not used, when source !== "live". */
  note?: string;
}

export interface HangeulStatus {
  source: "live" | "mock" | "mock-fallback";
  online: boolean;
  checkedAt: string;
  latencyMs?: number;
  note?: string;
}

/** GET /api/status response: which capabilities are configured (never secrets). */
export interface SystemStatus {
  app: string;
  voiceName: string;
  accessKeyRequired: boolean;
  llm: { provider: LlmProvider; model: string | null; visionModel: string | null };
  search: { providers: SearchProvider[] };
  voice: { engines: TtsEngine[] };
  telegram: { configured: boolean };
  hangeul: { mode: "live" | "mock" };
  time: string;
}
