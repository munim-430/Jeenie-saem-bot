// Orchestrator (Jeannie Core): routes each message to one specialist agent and
// returns its answer as a byte stream plus the metadata the HUD shows in
// headers. Routing order: IoT → Hangeul → vision → live search → core.
// The returned stream never errors: provider failures become a short line in
// the user's language. Runs on Edge and Node.js.

import { generateText, isStepCount, streamText, type LanguageModel, type ModelMessage, type ToolSet } from "ai";
import { getEnv } from "../env";
import type { AgentId, ChatMessage, LangMode, LlmProvider, ResolvedLang, SourceLink } from "../types";
import { resolveLanguage, truncate } from "../utils";
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
import {
  contextualSearchQuery,
  createSearchTool,
  formatSearchBriefing,
  isFollowUp,
  isSearchFollowUp,
  needsLiveSearch,
  toSourceLinks,
  webSearch,
  withTimeout,
} from "./search-agent";
import { toModelMessages } from "./vision-agent";

const HISTORY_LIMIT = 20;
// The routing heuristic can still fire on a chatty message, so let the model
// drop results that do not fit instead of forcing citations.
const SEARCH_RELEVANCE_NOTE =
  "If these results are not relevant to the user's latest message, ignore them and answer naturally without citations.";
const MAX_TOOL_STEPS = 3;
const MAX_SOURCES = 5;
// Edge responses must start within 25 s, and the search runs before the first
// byte, so the query rewrite and the provider chain share one budget.
const SEARCH_BUDGET_MS = 20_000;
const QUERY_REWRITE_TIMEOUT_MS = 4_000;
const QUERY_REWRITE_TURNS = 6;

// ─── Routing ────────────────────────────────────────────────────────────────

export interface RouteDecision {
  agent: AgentId;
  lang: ResolvedLang;
  reason: string;
}

// With an image attached, "summarize this daily report" or "이 보고서 번역해줘"
// is about the image. The portal wins only when the text names it and does
// not name a picture ("한글 포털 상태 확인해줘" + image is still a status check).
const NAMES_HANGEUL_PORTAL =
  /\bhangeul\b|\bportal\b|한글\s*(?:학원|포털|관리자|어드민|시스템|서버|사이트|대시보드|리포트|보고서|현황)|포털/i;
const NAMES_IMAGE =
  /\b(?:attached|attachment|screenshots?|screen\s+shots?|photos?|pictures?|images?|pics?|scans?|scanned)\b|사진|스크린샷|이미지|캡처|캡쳐|첨부/i;

function portalOverImage(text: string): boolean {
  return NAMES_HANGEUL_PORTAL.test(text) && !NAMES_IMAGE.test(text);
}

export function routeQuery(input: {
  text: string;
  hasImage: boolean;
  lang?: LangMode;
  /** Earlier user messages, oldest first: language for image-only turns, context for follow-ups. */
  previous?: readonly string[];
}): RouteDecision {
  const iot = checkIoTQuery(input.text, input.lang);
  if (iot !== null) {
    return { agent: "iot", lang: iot === IOT_RESPONSE.ko ? "ko" : "en", reason: "smart-home command or query" };
  }
  const previous = input.previous ?? [];
  const lang = resolveLanguage(input.lang, input.text, previous);
  if (isHangeulQuery(input.text) && (!input.hasImage || portalOverImage(input.text))) {
    return { agent: "hangeul", lang, reason: "Hangeul admin portal request" };
  }
  if (input.hasImage) return { agent: "vision", lang, reason: "image attached" };
  if (needsLiveSearch(input.text)) return { agent: "search", lang, reason: "time-sensitive or verifiable facts" };
  if (isSearchFollowUp(input.text, previous)) return { agent: "search", lang, reason: "follow-up to a live search" };
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

/** No LLM and the live search came back empty: the generic offline line would claim search works. */
export function offlineSearchFailedMessage(lang: ResolvedLang): string {
  return localized(
    lang,
    "Live search came back empty just now (the keyless search fallback is probably rate-limiting me), and no language model is connected to answer from memory. Try again in a minute. For reliable answers, set TAVILY_API_KEY for search and OPENAI_API_KEY (or OLLAMA_BASE_URL) for the language model.",
    "방금 실시간 검색 결과를 받지 못했어요 (키 없이 쓰는 검색이 잠시 요청을 제한하고 있는 것 같아요). 기억만으로 답할 언어 모델도 연결되어 있지 않아요. 1분쯤 뒤에 다시 시도해 주세요. 안정적으로 쓰려면 검색용 TAVILY_API_KEY와 언어 모델용 OPENAI_API_KEY(또는 OLLAMA_BASE_URL)를 설정해 주세요.",
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

/** Blank line between the text of two tool-loop steps ("Let me check." / "Seoul is ..."). */
function stepSeparator(answer: string): string {
  if (answer.endsWith("\n\n")) return "";
  return answer.endsWith("\n") ? "\n" : "\n\n";
}

/**
 * Model parts → UTF-8 text stream that never errors. `textStream` in the AI SDK
 * silently drops provider errors, so this reads `fullStream` and turns error or
 * timeout parts into a graceful closing line. A client abort just closes.
 */
export function guardedTextStream(parts: AsyncIterable<StreamPart>, options: GuardOptions): ReadableStream<Uint8Array> {
  const iterator = parts[Symbol.asyncIterator]();
  let answer = "";
  let newStep = false;

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
            // Sources a tool call found are still worth showing when the model wrote nothing.
            if (!answer) tail = options.signal?.aborted ? "" : (options.fallbackText ?? emptyAnswerLine(options.lang)) + tail;
            if (tail) controller.enqueue(encoder.encode(tail));
            controller.close();
            return;
          }
          const part = step.value;
          if (part.type === "start-step") {
            newStep = answer !== "";
            continue;
          }
          if (part.type === "text-delta" && typeof part.text === "string" && part.text) {
            const text = newStep ? stepSeparator(answer) + part.text : part.text;
            newStep = false;
            answer += text;
            controller.enqueue(encoder.encode(text));
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
      // The last allowed step must answer from the results it has; another
      // tool call there would end the loop with no text. `toolChoice: "none"`
      // (not `activeTools: []`) keeps the tool declared next to the earlier
      // tool-call messages.
      prepareStep: options.tools
        ? ({ stepNumber }) => (stepNumber >= MAX_TOOL_STEPS - 1 ? { toolChoice: "none" } : undefined)
        : undefined,
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

// "What's the population there?" may lean on the conversation without being short.
const REFERS_BACK =
  /\b(?:it|its|that|those|these|they|them|their|there|then|he|him|his|she|her)\b|그거|그것|거기|그곳|그때|그분|걔|(?<![가-힯])그\s+(?:사람|회사|팀|영화|경기|제품|나라|도시)/i;

const QUERY_REWRITE_SYSTEM =
  "Rewrite the user's latest message as one standalone web search query. Use the earlier turns only to resolve what it refers to (places, dates, names, 'it', 'there', 그럼, 내일은?). Keep the user's language. Reply with the query only: no quotes, no explanation.";

function cleanRewrite(raw: string): string | null {
  const line = raw.split("\n").map((l) => l.trim()).find(Boolean) ?? "";
  const query = line
    .replace(/^(?:search\s+query|query|검색어)\s*[:：]\s*/i, "")
    .replace(/^["'“‘「]+|["'”’」]+$/g, "")
    .trim();
  return query && query.length <= 300 ? query : null;
}

/**
 * The query to search for. The latest message alone when it stands on its
 * own; for a follow-up the model rewrites it with the recent turns, and the
 * heuristic (earlier question + follow-up) covers no model or a failed call.
 */
async function searchQueryFor(turn: Turn, resolved: ResolvedModel | null, signal: AbortSignal): Promise<string> {
  const previous = earlierUserTexts(turn.history);
  const fallback = contextualSearchQuery(turn.text, previous);
  if (!resolved || previous.length === 0 || !(isFollowUp(turn.text) || REFERS_BACK.test(turn.text))) return fallback;

  const transcript = turn.history
    .slice(-QUERY_REWRITE_TURNS)
    .map((m) => `${m.role === "user" ? "User" : "Assistant"}: ${truncate(m.content.replace(/\s+/g, " ").trim(), 400)}`)
    .join("\n");
  try {
    const { text } = await generateText({
      model: resolved.model,
      system: QUERY_REWRITE_SYSTEM,
      prompt: `${transcript}\n\nStandalone search query:`,
      maxOutputTokens: 60,
      maxRetries: 0,
      abortSignal: withTimeout(QUERY_REWRITE_TIMEOUT_MS, signal),
    });
    return cleanRewrite(text) ?? fallback;
  } catch {
    return fallback;
  }
}

async function runSearch(turn: Turn): Promise<OrchestratorResult> {
  const resolved = resolveModel("text", turn.ctx);
  const budget = withTimeout(SEARCH_BUDGET_MS, turn.ctx.signal);
  const query = await searchQueryFor(turn, resolved, budget);
  const res = await webSearch(query, { maxResults: MAX_SOURCES, signal: budget });
  if (res.results.length === 0 && !res.answer) return runCore(turn, { searchFailed: true });

  const sources = toSourceLinks(res.results, MAX_SOURCES);
  const briefing = formatSearchBriefing(res);
  const plain = offlineSearchText(briefing, turn.lang);

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
  if (!resolved) {
    const text = options.searchFailed ? offlineSearchFailedMessage(turn.lang) : offlineMessage(turn.lang);
    return fixed("offline", turn.lang, text);
  }

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

/** Text of the user turns before the latest one, oldest first. */
function earlierUserTexts(history: ChatMessage[]): string[] {
  return history.slice(0, -1).flatMap((m) => (m.role === "user" ? [m.content] : []));
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
  const route = routeQuery({ text, hasImage: Boolean(image), lang: input.lang, previous: earlierUserTexts(history) });

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
