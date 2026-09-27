// Live Search Agent: decides when a message needs fresh web data and fetches
// it through a Tavily → Google Custom Search → DuckDuckGo fallback chain.
// Everything here is fetch + regex so it runs on the Edge runtime (no DOM).

import { tool } from "ai";
import { z } from "zod";
import { getEnv, type JeannieEnv } from "../env";
import type { SearchProvider, SearchResponse, SearchResult, SourceLink } from "../types";
import { truncate } from "../utils";

const PROVIDER_TIMEOUT_MS = 8_000;
const MAX_QUERY_CHARS = 400;
const MAX_SNIPPET_CHARS = 500;

/** DuckDuckGo serves a bot challenge to obviously scripted clients. */
export const BROWSER_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

/** Signal that fires after `ms` or when `parent` aborts (AbortSignal.any is missing on some runtimes). */
export function withTimeout(ms: number, parent?: AbortSignal | null): AbortSignal {
  const timeout = AbortSignal.timeout(ms);
  if (!parent) return timeout;
  if (typeof AbortSignal.any === "function") return AbortSignal.any([parent, timeout]);
  const controller = new AbortController();
  const forward = (source: AbortSignal) => () => controller.abort(source.reason);
  if (parent.aborted) controller.abort(parent.reason);
  parent.addEventListener("abort", forward(parent), { once: true });
  timeout.addEventListener("abort", forward(timeout), { once: true });
  return controller.signal;
}

// ─── Routing heuristic ──────────────────────────────────────────────────────
// Cues are deliberately scoped: bare "now", "schedule", "search" or 결과 show up
// in ordinary follow-ups ("now make it shorter", "binary search", "결과를 요약해줘")
// that must stay with the core agent and its conversation context.

const EN_LIVE_CUES: RegExp[] = [
  /\b(?:today|tonight|tomorrow|yesterday)\b/i,
  /\bright now\b|\bas of (?:now|today)\b|\bat the moment\b|\bnow\s*\?/i,
  /\bcurrent(?:ly)?\b/i,
  /\b(?:latest|newest|recent(?:ly)?|up[- ]to[- ]date|breaking|trending)\b/i,
  /\bnews\b|\bheadlines?\b/i,
  /\bthis (?:week|weekend|month|year|season)\b|\b(?:last|next) (?:week|weekend|month|year|night)\b/i,
  /\b(?:scores?|standings|who won|who is winning|winner of|final result)\b/i,
  /\b(?:weather|forecast)\b/i,
  /\b(?:prices?|pricing|stock (?:price|market|quote)s?|stocks|share price|market cap|exchange rates?|crypto(?:currency|currencies)?|bitcoin|ethereum)\b/i,
  /\b(?:elections?|release date|launch date|box office)\b/i,
  /\b(?:game|match|fixture|tour|concert|release|flight|train|bus|exam|topik|tv|broadcast)\s+(?:schedule|timetable)s?\b/i,
  /\b(?:schedule|timetable)s?\s+(?:for|of)\s+(?:the\s+)?(?:next|upcoming|game|match|tour|concert|flight|train|bus|exam|topik)\b/i,
  /^\s*search\b|\bsearch\s+(?:for|the web|online|the internet|up|about|news)\b|\b(?:web|online|internet)\s+search\b|\b(?:can you|please|could you)\s+search\b/i,
  /\blook(?:\s+|-)?up\b|\bgoogle\s+(?:it|that|this|for)\b|\bfind out\b/i,
  /\bverify\b|\bfact[- ]?check\b|\b(?:is|was) (?:it|that|this) true\b|\btrue or false\b|\bdebunk\b|\brumou?rs?\b/i,
  /\b20(?:2[4-9]|3[0-5])\b/,
];

const KO_LIVE_CUES: RegExp[] = [
  /오늘|어제|내일|모레|올해|이번\s?(?:주|달|시즌)|요즘\s*(?:유행|인기|뜨는|핫한|화제)/,
  /지금\s*(?:몇\s*시|상황|어떻게|진행)|현재|최신|최근/,
  /뉴스|속보|헤드라인/,
  /날씨|기온|일기\s?예보|예보/,
  /가격|시세|주가|주식|환율|비트코인|코인|암호화폐/,
  /검색|찾아\s?봐|알아\s?봐|인터넷에서\s*찾|웹에서\s*찾/,
  /(?:경기|선거|시합|투표|개표|시험|추첨|발표)\s?결과|결과\s?발표|누가\s?(?:이겼|우승|당선)|선거|스코어/,
  /(?:경기|공연|콘서트|투어|개봉|발매|시험|토픽)\s?일정|개봉일|출시일|발매일/,
  /사실(?:이야|인가|이에요|인지|여부)|진짜야|팩트\s?체크|확인해\s?(?:줘|봐|주세요)/,
];

/** True when a message asks for time-sensitive or verifiable facts. */
export function needsLiveSearch(text: string): boolean {
  const normalized = text.normalize("NFC");
  if (!normalized.trim()) return false;
  return EN_LIVE_CUES.some((re) => re.test(normalized)) || KO_LIVE_CUES.some((re) => re.test(normalized));
}

// ─── Result normalization ───────────────────────────────────────────────────

const NAMED_ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };

export function decodeHtmlEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, entity: string) => {
    if (entity[0] === "#") {
      const code = entity[1] === "x" || entity[1] === "X" ? parseInt(entity.slice(2), 16) : parseInt(entity.slice(1), 10);
      return Number.isInteger(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : match;
    }
    return NAMED_ENTITIES[entity.toLowerCase()] ?? match;
  });
}

function htmlToText(fragment: string): string {
  return decodeHtmlEntities(fragment.replace(/<[^>]*>/g, " ")).replace(/\s+/g, " ").trim();
}

function httpUrl(raw: string | undefined | null): URL | null {
  if (!raw) return null;
  try {
    const url = new URL(raw);
    return url.protocol === "http:" || url.protocol === "https:" ? url : null;
  } catch {
    return null;
  }
}

function normalizeResult(
  raw: { title?: unknown; url?: unknown; snippet?: unknown; publishedDate?: unknown },
  source: SearchProvider,
): SearchResult | null {
  const url = httpUrl(typeof raw.url === "string" ? raw.url.trim() : null);
  if (!url) return null;
  const title = typeof raw.title === "string" ? raw.title.replace(/\s+/g, " ").trim() : "";
  const snippet = typeof raw.snippet === "string" ? raw.snippet.replace(/\s+/g, " ").trim() : "";
  const result: SearchResult = {
    title: title || url.hostname,
    url: url.toString(),
    snippet: truncate(snippet, MAX_SNIPPET_CHARS),
    source,
  };
  if (typeof raw.publishedDate === "string" && raw.publishedDate.trim()) result.publishedDate = raw.publishedDate.trim();
  return result;
}

function urlKey(value: string): string {
  const url = new URL(value);
  const path = url.pathname.replace(/\/+$/, "");
  return `${url.hostname.replace(/^www\./, "").toLowerCase()}${path}${url.search}`;
}

export function dedupeResults(results: SearchResult[]): SearchResult[] {
  const seen = new Set<string>();
  return results.filter((result) => {
    const key = urlKey(result.url);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function toSourceLinks(results: SearchResult[], max = 5): SourceLink[] {
  return results.slice(0, max).map((r) => ({ title: truncate(r.title, 80), url: r.url }));
}

// ─── Providers ──────────────────────────────────────────────────────────────

class ProviderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProviderError";
  }
}

interface ProviderOutcome {
  results: SearchResult[];
  answer?: string;
}

type ProviderRun = (query: string, maxResults: number, signal: AbortSignal) => Promise<ProviderOutcome>;

async function ensureOk(res: Response): Promise<void> {
  if (res.ok) return;
  await res.body?.cancel().catch(() => undefined);
  throw new ProviderError(`HTTP ${res.status}`);
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

interface TavilyResponse {
  answer?: unknown;
  results?: Array<{ title?: unknown; url?: unknown; content?: unknown; published_date?: unknown }>;
}

function tavily(apiKey: string): ProviderRun {
  return async (query, maxResults, signal) => {
    const res = await fetch("https://api.tavily.com/search", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ query, max_results: maxResults, search_depth: "basic", include_answer: true }),
      signal,
    });
    await ensureOk(res);
    const data = (await res.json()) as TavilyResponse;
    const results = (data.results ?? [])
      .map((r) => normalizeResult({ title: r.title, url: r.url, snippet: r.content, publishedDate: r.published_date }, "tavily"))
      .filter((r): r is SearchResult => r !== null);
    return { results, answer: nonEmptyString(data.answer) };
  };
}

interface GoogleResponse {
  items?: Array<{
    title?: unknown;
    link?: unknown;
    snippet?: unknown;
    pagemap?: { metatags?: Array<Record<string, unknown>> };
  }>;
}

function google(apiKey: string, cseId: string): ProviderRun {
  return async (query, maxResults, signal) => {
    const url = new URL("https://www.googleapis.com/customsearch/v1");
    url.searchParams.set("key", apiKey);
    url.searchParams.set("cx", cseId);
    url.searchParams.set("q", query);
    url.searchParams.set("num", String(Math.min(maxResults, 10)));
    const res = await fetch(url, { headers: { accept: "application/json" }, signal });
    await ensureOk(res);
    const data = (await res.json()) as GoogleResponse;
    const results = (data.items ?? [])
      .map((item) => {
        const meta = item.pagemap?.metatags?.[0];
        const published = meta?.["article:published_time"] ?? meta?.["og:updated_time"];
        return normalizeResult({ title: item.title, url: item.link, snippet: item.snippet, publishedDate: published }, "google");
      })
      .filter((r): r is SearchResult => r !== null);
    return { results };
  };
}

interface DdgTopic {
  FirstURL?: unknown;
  Text?: unknown;
  Result?: unknown;
  Topics?: DdgTopic[];
}

interface DdgInstantAnswer {
  Heading?: unknown;
  Answer?: unknown;
  Definition?: unknown;
  AbstractText?: unknown;
  AbstractURL?: unknown;
  AbstractSource?: unknown;
  Results?: DdgTopic[];
  RelatedTopics?: DdgTopic[];
}

function flattenTopics(topics: DdgTopic[] | undefined): DdgTopic[] {
  return (topics ?? []).flatMap((t) => (Array.isArray(t.Topics) ? flattenTopics(t.Topics) : [t]));
}

function topicToResult(topic: DdgTopic, fallbackHeading?: string): SearchResult | null {
  const url = nonEmptyString(topic.FirstURL);
  const text = nonEmptyString(topic.Text);
  if (!url || !text || /duckduckgo\.com\/c\//.test(url)) return null; // category pages have no content
  const anchor = typeof topic.Result === "string" ? /<a\b[^>]*>([\s\S]*?)<\/a>/i.exec(topic.Result) : null;
  const title = anchor ? htmlToText(anchor[1]) : text.split(" - ")[0];
  let snippet = text.startsWith(title) ? text.slice(title.length).replace(/^[\s\-–—:]+/, "") : text;
  if (!snippet && fallbackHeading) snippet = `${fallbackHeading}: ${title}`;
  return normalizeResult({ title, url, snippet }, "duckduckgo");
}

/** DuckDuckGo Instant Answer JSON → results. Exported for tests. */
export function parseDuckDuckGoInstantAnswer(data: DdgInstantAnswer, query: string): ProviderOutcome {
  const heading = nonEmptyString(data.Heading);
  const results: SearchResult[] = [];
  const abstractUrl = nonEmptyString(data.AbstractURL);
  const abstractText = nonEmptyString(data.AbstractText);
  if (abstractUrl && abstractText) {
    const abstract = normalizeResult({ title: heading ?? nonEmptyString(data.AbstractSource) ?? query, url: abstractUrl, snippet: abstractText }, "duckduckgo");
    if (abstract) results.push(abstract);
  }
  for (const topic of [...flattenTopics(data.Results), ...flattenTopics(data.RelatedTopics)]) {
    const result = topicToResult(topic, heading);
    if (result) results.push(result);
  }
  return { results, answer: nonEmptyString(data.Answer) ?? nonEmptyString(data.Definition) };
}

function resolveDuckDuckGoHref(rawHref: string): string | null {
  let href = decodeHtmlEntities(rawHref.trim());
  if (href.startsWith("//")) href = `https:${href}`;
  else if (href.startsWith("/")) href = `https://duckduckgo.com${href}`;
  const url = httpUrl(href);
  if (!url) return null;
  if (url.hostname === "duckduckgo.com" || url.hostname.endsWith(".duckduckgo.com")) {
    // Organic results may be wrapped in /l/?uddg=<target>; anything else on
    // duckduckgo.com (ads via y.js, internal pages) is not a real result.
    const target = url.searchParams.get("uddg");
    return target && httpUrl(target) ? target : null;
  }
  return url.toString();
}

const DDG_TITLE = /<a\b([^>]*\bclass="[^"]*\bresult__a\b[^"]*"[^>]*)>([\s\S]*?)<\/a>/gi;
const DDG_SNIPPET = /<(a|div|td|span)\b[^>]*\bclass="[^"]*\bresult__snippet\b[^"]*"[^>]*>([\s\S]*?)<\/\1>/gi;

/** html.duckduckgo.com result page → results (regex only; Edge has no DOM). Exported for tests. */
export function parseDuckDuckGoHtml(html: string): SearchResult[] {
  const titles = Array.from(html.matchAll(DDG_TITLE), (m) => ({
    index: m.index ?? 0,
    end: (m.index ?? 0) + m[0].length,
    href: /\bhref="([^"]*)"/i.exec(m[1])?.[1] ?? "",
    title: htmlToText(m[2]),
  }));
  const snippets = Array.from(html.matchAll(DDG_SNIPPET), (m) => ({ index: m.index ?? 0, text: htmlToText(m[2]) }));

  const results: SearchResult[] = [];
  titles.forEach((t, i) => {
    const blockStart = i === 0 ? Math.max(0, t.index - 600) : titles[i - 1].end;
    if (/\bresult--ad\b/.test(html.slice(blockStart, t.index))) return;
    const nextIndex = titles[i + 1]?.index ?? Number.POSITIVE_INFINITY;
    const snippet = snippets.find((s) => s.index > t.index && s.index < nextIndex)?.text ?? "";
    const result = normalizeResult({ title: t.title, url: resolveDuckDuckGoHref(t.href), snippet }, "duckduckgo");
    if (result) results.push(result);
  });
  return results;
}

async function duckDuckGoInstant(query: string, signal: AbortSignal): Promise<ProviderOutcome> {
  const url = new URL("https://api.duckduckgo.com/");
  url.searchParams.set("q", query);
  url.searchParams.set("format", "json");
  url.searchParams.set("no_html", "1");
  url.searchParams.set("skip_disambig", "1");
  url.searchParams.set("no_redirect", "1");
  const res = await fetch(url, { headers: { accept: "application/json", "user-agent": BROWSER_USER_AGENT }, signal });
  await ensureOk(res);
  // Served as application/x-javascript with status 202, so parse the text ourselves.
  const data = JSON.parse(await res.text()) as DdgInstantAnswer;
  return parseDuckDuckGoInstantAnswer(data, query);
}

async function duckDuckGoHtml(query: string, signal: AbortSignal): Promise<ProviderOutcome> {
  try {
    return await duckDuckGoHtmlOnce(query, signal);
  } catch (error) {
    // The challenge is served to a random share of requests; one retry usually gets through.
    if (!(error instanceof ProviderError && error.message === "bot challenge") || signal.aborted) throw error;
    await new Promise((resolve) => setTimeout(resolve, 250));
    return duckDuckGoHtmlOnce(query, signal);
  }
}

async function duckDuckGoHtmlOnce(query: string, signal: AbortSignal): Promise<ProviderOutcome> {
  // POST: the GET form of this endpoint is answered with a bot challenge far more often.
  const res = await fetch("https://html.duckduckgo.com/html/", {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      accept: "text/html,application/xhtml+xml",
      "accept-language": "en-US,en;q=0.9,ko;q=0.8",
      "user-agent": BROWSER_USER_AGENT,
      referer: "https://html.duckduckgo.com/",
    },
    body: new URLSearchParams({ q: query, b: "" }).toString(),
    signal,
  });
  await ensureOk(res);
  const html = await res.text();
  const results = parseDuckDuckGoHtml(html);
  if (results.length === 0 && /anomaly-modal|bots use DuckDuckGo/i.test(html)) {
    throw new ProviderError("bot challenge");
  }
  return { results };
}

function duckDuckGo(): ProviderRun {
  return async (query, _maxResults, signal) => {
    let instantError: unknown = null;
    try {
      const instant = await duckDuckGoInstant(query, signal);
      if (instant.results.length > 0 || instant.answer) return instant;
    } catch (error) {
      if (signal.aborted) throw error;
      instantError = error;
    }
    try {
      return await duckDuckGoHtml(query, signal);
    } catch (error) {
      if (instantError && !signal.aborted) throw new ProviderError(`${describeError(instantError)}; html ${describeError(error)}`);
      throw error;
    }
  };
}

function providerChain(env: JeannieEnv): Array<{ id: SearchProvider; run: ProviderRun }> {
  const chain: Array<{ id: SearchProvider; run: ProviderRun }> = [];
  const { tavilyApiKey, googleApiKey, googleCseId } = env.search;
  if (tavilyApiKey) chain.push({ id: "tavily", run: tavily(tavilyApiKey) });
  if (googleApiKey && googleCseId) chain.push({ id: "google", run: google(googleApiKey, googleCseId) });
  chain.push({ id: "duckduckgo", run: duckDuckGo() });
  return chain;
}

/** Short, secret-free reason (fetch errors can embed request URLs, which hold API keys). */
function describeError(error: unknown): string {
  if (error instanceof ProviderError) return error.message;
  if (error instanceof DOMException || (error instanceof Error && /Abort|Timeout/.test(error.name))) {
    return (error as Error).name === "TimeoutError" ? "timed out" : "aborted";
  }
  if (error instanceof SyntaxError) return "invalid response";
  return "network error";
}

export interface WebSearchOptions {
  maxResults?: number;
  signal?: AbortSignal | null;
  /** Per-provider budget; 8 s by default (tests shorten it). */
  providerTimeoutMs?: number;
}

/** Runs the provider chain; never throws. Each provider gets 8 s before the next one is tried. */
export async function webSearch(query: string, options: WebSearchOptions = {}): Promise<SearchResponse> {
  const q = query.replace(/\s+/g, " ").trim().slice(0, MAX_QUERY_CHARS);
  const maxResults = Math.min(10, Math.max(1, Math.floor(options.maxResults ?? 5)));
  if (!q) return { query: q, provider: "none", results: [], error: "Empty search query." };

  const failures: string[] = [];
  for (const { id, run } of providerChain(getEnv())) {
    if (options.signal?.aborted) break;
    try {
      const outcome = await run(q, maxResults, withTimeout(options.providerTimeoutMs ?? PROVIDER_TIMEOUT_MS, options.signal));
      const results = dedupeResults(outcome.results).slice(0, maxResults);
      if (results.length > 0 || outcome.answer) {
        const response: SearchResponse = { query: q, provider: id, results };
        if (outcome.answer) response.answer = truncate(outcome.answer, 1000);
        return response;
      }
      failures.push(`${id}: no results`);
    } catch (error) {
      failures.push(`${id}: ${describeError(error)}`);
    }
  }

  const error = options.signal?.aborted ? "Search cancelled." : `No live results (${failures.join("; ")}).`;
  return { query: q, provider: "none", results: [], error };
}

function formatDate(value: string | undefined): string | null {
  if (!value) return null;
  const time = Date.parse(value);
  return Number.isNaN(time) ? truncate(value, 20) : new Date(time).toISOString().slice(0, 10);
}

const PROVIDER_LABEL: Record<SearchProvider | "none", string> = {
  tavily: "Tavily",
  google: "Google Custom Search",
  duckduckgo: "DuckDuckGo",
  none: "no provider",
};

/** Numbered briefing for the LLM (and plain-text offline answers): "[n] title (date) — snippet — url". */
export function formatSearchBriefing(res: SearchResponse): string {
  if (res.results.length === 0 && !res.answer) {
    return `No live web results for "${res.query}".${res.error ? ` ${res.error}` : ""}`;
  }
  const lines = [`Live web results for "${res.query}" (via ${PROVIDER_LABEL[res.provider]}):`];
  if (res.answer) lines.push(`Quick answer: ${res.answer}`);
  res.results.forEach((r, i) => {
    const date = formatDate(r.publishedDate);
    const parts = [`[${i + 1}] ${r.title}${date ? ` (${date})` : ""}`];
    if (r.snippet) parts.push(truncate(r.snippet, 300));
    parts.push(r.url);
    lines.push(parts.join(" — "));
  });
  return lines.join("\n");
}

/** The `webSearch` tool for the core agent. `onSources` sees every non-empty result set. */
export function createSearchTool(onSources?: (sources: SourceLink[]) => void) {
  return tool({
    description:
      "Search the live web for fresh, time-sensitive or verifiable facts (news, prices, scores, weather, releases, current events). Returns numbered results with title, url, snippet and date.",
    inputSchema: z.object({ query: z.string().min(1).describe("A concise web search query") }),
    execute: async ({ query }, { abortSignal }) => {
      const res = await webSearch(query, { maxResults: 5, signal: abortSignal });
      if (res.results.length > 0) onSources?.(toSourceLinks(res.results));
      return {
        provider: res.provider,
        answer: res.answer ?? null,
        results: res.results.map((r, i) => ({
          n: i + 1,
          title: r.title,
          url: r.url,
          snippet: truncate(r.snippet, 300),
          date: r.publishedDate ?? null,
        })),
        error: res.error ?? null,
      };
    },
  });
}
