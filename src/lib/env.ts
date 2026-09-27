// Server-side configuration. Reads process.env lazily on every call so tests can
// stub variables, and so nothing is inlined into client bundles.
// Works on both the Edge and Node.js runtimes.

import type { LlmProvider, SearchProvider, TtsEngine } from "./types";

function read(name: string): string | undefined {
  const value = process.env[name];
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  // Treat the placeholders shipped in .env.example as "not configured".
  if (trimmed === "" || /^your_[a-z0-9_]+$/i.test(trimmed)) return undefined;
  return trimmed;
}

function readBool(name: string, fallback: boolean): boolean {
  const value = read(name);
  if (value === undefined) return fallback;
  return /^(1|true|yes|on)$/i.test(value);
}

/** A loopback Ollama URL can never be reached from a Vercel function. */
function reachableOllamaUrl(): string | undefined {
  const url = read("OLLAMA_BASE_URL");
  if (!url || !process.env.VERCEL) return url;
  try {
    const host = new URL(url).hostname;
    return /^(localhost|127\.\d+\.\d+\.\d+|\[::1\]|0\.0\.0\.0)$/i.test(host) ? undefined : url;
  } catch {
    return undefined;
  }
}

export function getEnv() {
  const openaiKey = read("OPENAI_API_KEY");
  const requestedProvider = (read("LLM_PROVIDER") ?? "auto").toLowerCase();
  const ollamaBaseUrl = reachableOllamaUrl();

  let llmProvider: LlmProvider = "none";
  if (requestedProvider === "openai") llmProvider = openaiKey ? "openai" : "none";
  else if (requestedProvider === "ollama") llmProvider = ollamaBaseUrl ? "ollama" : "none";
  else llmProvider = openaiKey ? "openai" : ollamaBaseUrl ? "ollama" : "none";

  const defaultModel = read("DEFAULT_MODEL") ?? "gpt-4o";
  const ollamaModel = read("OLLAMA_MODEL") ?? "llama3.1";

  return {
    appName: read("NEXT_PUBLIC_APP_NAME") ?? "Jeannie AI",
    voiceName: read("NEXT_PUBLIC_VOICE_NAME") ?? "Jeannie",
    accessKey: read("JEANNIE_ACCESS_KEY"),
    cronSecret: read("CRON_SECRET"),

    llm: {
      provider: llmProvider,
      openaiApiKey: openaiKey,
      openaiBaseUrl: read("OPENAI_BASE_URL"),
      ollamaBaseUrl: ollamaBaseUrl ?? "http://localhost:11434",
      model: llmProvider === "ollama" ? ollamaModel : defaultModel,
      visionModel:
        llmProvider === "ollama"
          ? (read("OLLAMA_VISION_MODEL") ?? "llava")
          : (read("VISION_MODEL") ?? defaultModel),
    },

    search: {
      tavilyApiKey: read("TAVILY_API_KEY"),
      googleApiKey: read("GOOGLE_CSE_API_KEY"),
      googleCseId: read("GOOGLE_CSE_ID"),
    },

    tts: {
      elevenLabsApiKey: read("ELEVENLABS_API_KEY"),
      elevenLabsVoiceId: read("ELEVENLABS_VOICE_ID"),
      elevenLabsModelId: read("ELEVENLABS_MODEL_ID") ?? "eleven_multilingual_v2",
      edgeVoiceEn: read("EDGE_TTS_VOICE_EN") ?? "en-US-JennyNeural",
      edgeVoiceKo: read("EDGE_TTS_VOICE_KO") ?? "ko-KR-SunHiNeural",
      edgeEnabled: readBool("EDGE_TTS_ENABLED", true),
    },

    telegram: {
      botToken: read("TELEGRAM_BOT_TOKEN"),
      adminChatId: read("TELEGRAM_ADMIN_CHAT_ID"),
      webhookSecret: read("TELEGRAM_WEBHOOK_SECRET"),
    },

    hangeul: {
      baseUrl: read("HANGEUL_BASE_URL"),
      username: read("HANGEUL_USERNAME"),
      password: read("HANGEUL_PASSWORD"),
      reportPath: read("HANGEUL_REPORT_PATH") ?? "/api/reports/daily",
      statusPath: read("HANGEUL_STATUS_PATH") ?? "/api/status",
      mockMode: readBool("MOCK_MODE", false),
    },
  };
}

export type JeannieEnv = ReturnType<typeof getEnv>;

export function configuredSearchProviders(env: JeannieEnv = getEnv()): SearchProvider[] {
  const providers: SearchProvider[] = [];
  if (env.search.tavilyApiKey) providers.push("tavily");
  if (env.search.googleApiKey && env.search.googleCseId) providers.push("google");
  providers.push("duckduckgo"); // keyless fallback, always available
  return providers;
}

export function configuredTtsEngines(env: JeannieEnv = getEnv()): TtsEngine[] {
  const engines: TtsEngine[] = [];
  if (env.tts.elevenLabsApiKey && env.tts.elevenLabsVoiceId) engines.push("elevenlabs");
  if (env.tts.edgeEnabled) engines.push("edge");
  engines.push("browser"); // client-side speechSynthesis, always available
  return engines;
}

/** Live Hangeul access needs credentials and MOCK_MODE off. */
export function hangeulLiveConfigured(env: JeannieEnv = getEnv()): boolean {
  const h = env.hangeul;
  return !h.mockMode && Boolean(h.baseUrl && h.username && h.password);
}
