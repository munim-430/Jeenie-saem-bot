// Orchestrator (Jeannie Core): routes each message to one specialist agent and
// returns its answer as a byte stream plus the metadata the HUD shows in
// headers. Routing order: IoT → Hangeul → vision → live search → core.
// The returned stream never errors: provider failures become a short line in
// the user's language. Runs on Edge and Node.js.

import { isStepCount, streamText, type LanguageModel, type ModelMessage, type ToolSet } from "ai";
import { getEnv } from "../env";
import type { AgentId, ChatMessage, LangMode, LlmProvider, ResolvedLang, SourceLink } from "../types";
import { resolveLanguage } from "../utils";
import {
  formatHangeulReport,
  formatHangeulStatus,
  getHangeulReport,
  getHangeulStatus,
  isHangeulQuery,
  isHangeulStatusQuery,
} from "./hangeul-bridge";
import { checkIoTQuery, IOT_RESPONSE } from "./iot-interceptor";
import { getLanguageModel, type ResolvedModel } from "./llm";
import { buildSystemPrompt } from "./persona";
import { createSearchTool, formatSearchBriefing, needsLiveSearch, toSourceLinks, webSearch } from "./search-agent";
import { toModelMessages } from "./vision-agent";

const HISTORY_LIMIT = 20;
// The routing heuristic also fires on chatty messages ("rough day today"), so
// let the model drop results that do not fit instead of forcing citations.
const SEARCH_RELEVANCE_NOTE =
  "If these results are not relevant to the user's latest message, ignore them and answer naturally without citations.";
const MAX_TOOL_STEPS = 3;
const MAX_SOURCES = 5;

// ─── Routing ────────────────────────────────────────────────────────────────

export interface RouteDecision {
  agent: AgentId;
  lang: ResolvedLang;
  reason: string;
}

export function routeQuery(input: { text: string; hasImage: boolean; lang?: LangMode }): RouteDecision {
  const iot = checkIoTQuery(input.text, input.lang);
  if (iot !== null) {
    return { agent: "iot", lang: iot === IOT_RESPONSE.ko ? "ko" : "en", reason: "smart-home command or query" };
  }
  const lang = resolveLanguage(input.lang, input.text);
  if (isHangeulQuery(input.text)) return { agent: "hangeul", lang, reason: "Hangeul admin portal request" };
  if (input.hasImage) return { agent: "vision", lang, reason: "image attached" };
  if (needsLiveSearch(input.text)) return { agent: "search", lang, reason: "time-sensitive or verifiable facts" };
  return { agent: "core", lang, reason: "general request" };
}

// ─── Localized fixed lines ──────────────────────────────────────────────────

function localized(lang: ResolvedLang, en: string, ko: string, separator = "\n—\n"): string {
  if (lang === "ko") return ko;
  if (lang === "bilingual") return `${en}${separator}${ko}`;
  return en;
}

export function offlineMessage(lang: ResolvedLang, kind: "text" | "vision" = "text"): string {
  if (kind === "vision") {
    return localized(
      lang,
      "Image analysis needs a vision-capable model, and none is connected. Set OPENAI_API_KEY, or OLLAMA_BASE_URL with a vision model such as llava, and I'll take a look.",
      "이미지 분석에는 비전 모델이 필요한데 지금은 연결된 모델이 없어요. OPENAI_API_KEY를 설정하거나 OLLAMA_BASE_URL과 llava 같은 비전 모델을 설정해 주시면 바로 분석할게요.",
    );
  }
  return localized(
    lang,
    "I'm running in offline mode: no language model is connected. Set OPENAI_API_KEY (or OLLAMA_BASE_URL for a local model) and I'll be fully online. Smart-home commands, live search and Hangeul reports still work.",
    "지금은 오프라인 모드예요. 연결된 언어 모델이 없어요. OPENAI_API_KEY(로컬 모델은 OLLAMA_BASE_URL)를 설정해 주시면 바로 온라인으로 전환할게요. 스마트홈 명령, 실시간 검색, 한글 리포트는 계속 사용할 수 있어요.",
  );
}

function unreachableLine(lang: ResolvedLang): string {
  return localized(
    lang,
    "I couldn't reach my language model just now. Please try again in a moment.",
    "지금은 언어 모델에 연결할 수 없어요. 잠시 후 다시 시도해 주세요.",
  );
}

function droppedLine(lang: ResolvedLang): string {
  return `\n\n[${localized(
    lang,
    "Connection to the language model dropped mid-answer. Ask again and I'll pick it up.",
    "언어 모델 연결이 중간에 끊겼어요. 다시 요청해 주시면 이어서 답할게요.",
    " / ",
  )}]`;
}

function emptyAnswerLine(lang: ResolvedLang): string {
  return localized(
    lang,
    "I came up empty on that one. Could you rephrase or add a little more detail?",
    "이번에는 답을 찾지 못했어요. 조금 더 자세히 말씀해 주시겠어요?",
  );
}

function offlineSearchText(briefing: string, lang: ResolvedLang): string {
  const header = localized(
    lang,
    "Here's what the live web says (no language model is connected, so these are the raw results):",
    "실시간 웹 검색 결과예요 (언어 모델이 연결되어 있지 않아 원문 결과를 보여드려요):",
    " / ",
  );
  return `${header}\n\n${briefing}`;
}

function sourcesFooter(sources: SourceLink[], answer: string, lang: ResolvedLang): string {
  const unique = sources.filter((s, i) => sources.findIndex((o) => o.url === s.url) === i).slice(0, MAX_SOURCES);
  if (unique.length === 0 || unique.some((s) => answer.includes(s.url))) return "";
  const label = localized(lang, "Sources", "출처", " / ");
  return `\n\n${label}:\n${unique.map((s, i) => `[${i + 1}] ${s.title} — ${s.url}`).join("\n")}`;
}

// ─── Streams ────────────────────────────────────────────────────────────────

const encoder = new TextEncoder();

function textStreamOf(text: string): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(text));
      controller.close();
    },
  });
}

/** Structural view of AI SDK `fullStream` parts; only these fields are read. */
interface StreamPart {
  type: string;
  text?: unknown;
}

interface GuardOptions {
  lang: ResolvedLang;
  signal?: AbortSignal | null;
  /** Shown instead of the generic error when the model fails before any text (e.g. raw search results). */
  fallbackText?: string;
  /** Appended after a successful answer. */
  footer?: (answer: string) => string;
}

/**
 * Model parts → UTF-8 text stream that never errors. `textStream` in the AI SDK
 * silently drops provider errors, so this reads `fullStream` and turns error or
 * timeout parts into a graceful closing line. A client abort just closes.
 */
export function guardedTextStream(parts: AsyncIterable<StreamPart>, options: GuardOptions): ReadableStream<Uint8Array> {
  const iterator = parts[Symbol.asyncIterator]();
  let answer = "";

  const failureTail = () => {
    if (options.signal?.aborted) return "";
    if (answer) return droppedLine(options.lang);
    return options.fallbackText ?? unreachableLine(options.lang);
  };
  const close = (controller: ReadableStreamDefaultController<Uint8Array>, tail: string) => {
    if (tail) controller.enqueue(encoder.encode(tail));
    controller.close();
    void Promise.resolve(iterator.return?.()).catch(() => undefined);
  };

  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        for (;;) {
          const step = await iterator.next();
          if (step.done) {
            let tail = options.footer?.(answer) ?? "";
            if (!answer) tail = options.signal?.aborted ? "" : (options.fallbackText ?? emptyAnswerLine(options.lang));
            if (tail) controller.enqueue(encoder.encode(tail));
            controller.close();
            return;
          }
          const part = step.value;
          if (part.type === "text-delta" && typeof part.text === "string" && part.text) {
            answer += part.text;
            controller.enqueue(encoder.encode(part.text));
            return;
          }
          if (part.type === "error" || part.type === "abort") {
            close(controller, failureTail());
            return;
          }
        }
      } catch {
        close(controller, failureTail());
      }
    },
    async cancel() {
      await Promise.resolve(iterator.return?.()).catch(() => undefined);
    },
  });
}

function errorSummary(error: unknown): string {
  if (error && typeof error === "object") {
    const e = error as { name?: unknown; statusCode?: unknown };
    const name = typeof e.name === "string" ? e.name : "Error";
    return typeof e.statusCode === "number" ? `${name} (HTTP ${e.statusCode})` : name;
  }
  return "Error";
}

function llmStream(options: {
  resolved: ResolvedModel;
  system: string;
  messages: ModelMessage[];
  lang: ResolvedLang;
  signal?: AbortSignal | null;
  tools?: ToolSet;
  fallbackText?: string;
  footer?: (answer: string) => string;
}): ReadableStream<Uint8Array> {
  const guard: GuardOptions = {
    lang: options.lang,
    signal: options.signal,
    fallbackText: options.fallbackText,
    footer: options.footer,
  };
  try {
    const result = streamText({
      model: options.resolved.model,
      system: options.system,
      messages: options.messages,
      tools: options.tools,
      stopWhen: options.tools ? isStepCount(MAX_TOOL_STEPS) : undefined,
      abortSignal: options.signal ?? undefined,
      maxRetries: 1,
      timeout: { firstChunkMs: 45_000, chunkMs: 30_000 },
      // Log a short reason only: SDK errors carry request bodies (the user's messages).
      onError: ({ error }) => console.error(`[jeannie] ${options.resolved.provider} stream error: ${errorSummary(error)}`),
    });
    return guardedTextStream(result.fullStream, guard);
  } catch (error) {
    console.error(`[jeannie] ${options.resolved.provider} call failed: ${errorSummary(error)}`);
    return textStreamOf(options.fallbackText ?? unreachableLine(options.lang));
  }
}

// ─── Agents ─────────────────────────────────────────────────────────────────

export interface OrchestratorInput {
  messages: ChatMessage[];
  image?: string | null;
  lang?: LangMode;
}

export interface OrchestratorContext {
  /** Caller proved a configured secret; unlocks live Hangeul data. */
  trusted: boolean;
  signal?: AbortSignal | null;
  /** Test override for the language model (used for every LLM agent). */
  model?: LanguageModel;
  /** Provider label for `model`; defaults to the configured provider, else "openai". */
  provider?: "openai" | "ollama";
}

export interface OrchestratorResult {
  agent: AgentId;
  lang: ResolvedLang;
  provider: LlmProvider;
  sources: SourceLink[];
  stream: ReadableStream<Uint8Array>;
}

interface Turn {
  text: string;
  image: string | null;
  history: ChatMessage[];
  lang: ResolvedLang;
  ctx: OrchestratorContext;
}

function resolveModel(kind: "text" | "vision", ctx: OrchestratorContext): ResolvedModel | null {
  if (ctx.model) {
    const configured = getEnv().llm.provider;
    const provider = ctx.provider ?? (configured === "none" ? "openai" : configured);
    return { model: ctx.model, provider, modelId: "override" };
  }
  return getLanguageModel(kind);
}

function fixed(
  agent: AgentId,
  lang: ResolvedLang,
  text: string,
  sources: SourceLink[] = [],
): OrchestratorResult {
  return { agent, lang, provider: "none", sources, stream: textStreamOf(text) };
}

async function runHangeul(turn: Turn): Promise<OrchestratorResult> {
  const bridge = { trusted: turn.ctx.trusted, signal: turn.ctx.signal };
  const wantsStatus = isHangeulStatusQuery(turn.text);
  const data = wantsStatus ? await getHangeulStatus(bridge) : await getHangeulReport(bridge);
  const plain = "metrics" in data ? formatHangeulReport(data, turn.lang) : formatHangeulStatus(data, turn.lang);

  const resolved = resolveModel("text", turn.ctx);
  if (!resolved) return fixed("hangeul", turn.lang, plain);

  const context = `Hangeul portal ${wantsStatus ? "status check" : "report"} (JSON):\n${JSON.stringify(data, null, 2)}`;
  const stream = llmStream({
    resolved,
    system: buildSystemPrompt({ agent: "hangeul", lang: turn.lang, context }),
    messages: toModelMessages(turn.history, { lang: turn.lang }),
    lang: turn.lang,
    signal: turn.ctx.signal,
    fallbackText: plain,
  });
  return { agent: "hangeul", lang: turn.lang, provider: resolved.provider, sources: [], stream };
}

async function runSearch(turn: Turn): Promise<OrchestratorResult> {
  const res = await webSearch(turn.text, { maxResults: MAX_SOURCES, signal: turn.ctx.signal });
  if (res.results.length === 0 && !res.answer) return runCore(turn, { searchFailed: true });

  const sources = toSourceLinks(res.results, MAX_SOURCES);
  const briefing = formatSearchBriefing(res);
  const plain = offlineSearchText(briefing, turn.lang);

  const resolved = resolveModel("text", turn.ctx);
  if (!resolved) return fixed("search", turn.lang, plain, sources);

  const stream = llmStream({
    resolved,
    system: buildSystemPrompt({ agent: "search", lang: turn.lang, context: `${briefing}\n\n${SEARCH_RELEVANCE_NOTE}` }),
    messages: toModelMessages(turn.history, { lang: turn.lang }),
    lang: turn.lang,
    signal: turn.ctx.signal,
    fallbackText: plain,
  });
  return { agent: "search", lang: turn.lang, provider: resolved.provider, sources, stream };
}

function runVision(turn: Turn): OrchestratorResult {
  const resolved = resolveModel("vision", turn.ctx);
  if (!resolved) return fixed("offline", turn.lang, offlineMessage(turn.lang, "vision"));
  const stream = llmStream({
    resolved,
    system: buildSystemPrompt({ agent: "vision", lang: turn.lang }),
    messages: toModelMessages(turn.history, { latestImage: turn.image, lang: turn.lang }),
    lang: turn.lang,
    signal: turn.ctx.signal,
  });
  return { agent: "vision", lang: turn.lang, provider: resolved.provider, sources: [], stream };
}

function runCore(turn: Turn, options: { searchFailed?: boolean } = {}): OrchestratorResult {
  const resolved = resolveModel("text", turn.ctx);
  if (!resolved) return fixed("offline", turn.lang, offlineMessage(turn.lang));

  // Tool calling is reliable on OpenAI; many Ollama models ignore or garble tools.
  const useTools = resolved.provider === "openai" && !options.searchFailed;
  const found: SourceLink[] = [];
  let context: string | undefined;
  if (options.searchFailed) {
    context = "Live web search returned nothing for this message. Answer from your own knowledge and say briefly that live data was unavailable.";
  } else if (!useTools) {
    context = "The webSearch tool is not available with this model. If an answer needs live data, say so briefly.";
  }

  const stream = llmStream({
    resolved,
    system: buildSystemPrompt({ agent: "core", lang: turn.lang, context }),
    messages: toModelMessages(turn.history, { lang: turn.lang }),
    lang: turn.lang,
    signal: turn.ctx.signal,
    tools: useTools ? { webSearch: createSearchTool((sources) => found.push(...sources)) } : undefined,
    footer: (answer) => sourcesFooter(found, answer, turn.lang),
  });
  return { agent: "core", lang: turn.lang, provider: resolved.provider, sources: [], stream };
}

/** History up to the latest user turn, capped, without empty turns. */
function prepareHistory(messages: ChatMessage[]): ChatMessage[] {
  let lastUser = messages.length - 1;
  while (lastUser >= 0 && messages[lastUser].role !== "user") lastUser--;
  const window = messages.slice(0, lastUser + 1).slice(-HISTORY_LIMIT);
  return window.filter((m, i) => i === window.length - 1 || m.content.trim() !== "" || Boolean(m.image));
}

export async function runOrchestrator(input: OrchestratorInput, ctx: OrchestratorContext): Promise<OrchestratorResult> {
  const history = prepareHistory(input.messages);
  const last = history.at(-1);
  const text = last?.role === "user" ? last.content : "";
  const image = input.image ?? (last?.role === "user" ? last.image : null) ?? null;
  const route = routeQuery({ text, hasImage: Boolean(image), lang: input.lang });

  if (route.agent === "iot") {
    // Hard rule: fixed sentence, no network, no LLM.
    return fixed("iot", route.lang, checkIoTQuery(text, input.lang) ?? IOT_RESPONSE.en);
  }

  const turn: Turn = { text, image, history, lang: route.lang, ctx };
  try {
    switch (route.agent) {
      case "hangeul":
        return await runHangeul(turn);
      case "search":
        return await runSearch(turn);
      case "vision":
        return runVision(turn);
      default:
        return runCore(turn);
    }
  } catch (error) {
    console.error(`[jeannie] ${route.agent} agent failed: ${errorSummary(error)}`);
    return fixed(route.agent, route.lang, unreachableLine(route.lang));
  }
}

export interface OrchestratorTextResult extends Omit<OrchestratorResult, "stream"> {
  text: string;
}

/** Same as runOrchestrator, with the stream collected (Telegram, cron). */
export async function runOrchestratorToText(
  input: OrchestratorInput,
  ctx: OrchestratorContext,
): Promise<OrchestratorTextResult> {
  const { stream, ...meta } = await runOrchestrator(input, ctx);
  const text = await new Response(stream).text();
  return { ...meta, text };
}
