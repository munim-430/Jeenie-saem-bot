// Language model resolution. OpenAI and Ollama both go through the OpenAI
// provider's Chat Completions client (Ollama exposes an OpenAI-compatible
// `/v1` API), so one code path serves both. Runs on Edge and Node.js.

import { createOpenAI } from "@ai-sdk/openai";
import type { LanguageModel } from "ai";
import { getEnv } from "../env";

export interface ResolvedModel {
  model: LanguageModel;
  provider: "openai" | "ollama";
  modelId: string;
}

/** `http://host:11434/`, `http://host:11434/v1` → `http://host:11434/v1`. */
export function ollamaApiBase(baseUrl: string): string {
  const trimmed = baseUrl.trim();
  let end = trimmed.length;
  while (end > 0 && trimmed[end - 1] === "/") end--; // linear, unlike /\/+$/ on long input
  return `${trimmed.slice(0, end).replace(/\/v1$/i, "")}/v1`;
}

/** The configured model for plain text or image analysis, or null when no LLM is configured. */
export function getLanguageModel(kind: "text" | "vision"): ResolvedModel | null {
  const { llm } = getEnv();
  const modelId = kind === "vision" ? llm.visionModel : llm.model;

  if (llm.provider === "openai" && llm.openaiApiKey) {
    // Always pass a base URL: left undefined, the SDK reads OPENAI_BASE_URL raw, and the
    // blank value shipped in .env.example would then break every request.
    const openai = createOpenAI({ apiKey: llm.openaiApiKey, baseURL: llm.openaiBaseUrl ?? "https://api.openai.com/v1" });
    return { model: openai.chat(modelId), provider: "openai", modelId };
  }

  if (llm.provider === "ollama") {
    // Ollama ignores the key, but the OpenAI client refuses to run without one.
    const ollama = createOpenAI({ baseURL: ollamaApiBase(llm.ollamaBaseUrl), apiKey: "ollama", name: "ollama" });
    return { model: ollama.chat(modelId), provider: "ollama", modelId };
  }

  return null;
}
