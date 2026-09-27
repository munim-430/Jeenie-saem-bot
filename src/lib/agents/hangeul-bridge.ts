// Hangeul Admin & Reporting Bridge: fetches the daily report and a health check
// from the Hangeul admin portal. Live data only for trusted callers with the
// portal configured; everyone else gets clearly labelled, deterministic demo
// data. Edge-safe (fetch + btoa, no Node APIs).

import { getEnv, hangeulLiveConfigured } from "../env";
import type { HangeulMetric, HangeulReport, HangeulStatus, ResolvedLang } from "../types";
import { truncate } from "../utils";

const LIVE_TIMEOUT_MS = 10_000;
const MAX_METRICS = 20;
const MAX_HIGHLIGHTS = 10;

// ─── Routing ────────────────────────────────────────────────────────────────
// "Hangeul"/한글 alone is also the Korean alphabet ("teach me hangeul",
// "한글로 보고서 써줘"), so it only routes here next to an admin/portal cue.

const EN_HANGEUL_CUES: RegExp[] = [
  /\b(?:admin|daily)\s+reports?\b/i,
  /\bhangeul(?:'s)?\s+(?:(?:daily|admin|today'?s)\s+)?(?:reports?|briefing|summary|status|dashboard|portal|admin|academy|institute|school|system|server|site|website|backend|metrics|stats|numbers|students|enrol{1,2}ments?|attendance|payments?|operations)\b/i,
  /\b(?:portal|admin|dashboard)\b[\s\S]{0,40}\bhangeul\b|\bhangeul\b[\s\S]{0,40}\b(?:portal|admin|dashboard)\b/i,
  /\b(?:report|status|numbers|metrics|stats)\s+(?:from|of|for)\s+(?:the\s+)?hangeul\b/i,
  /\bis\s+(?:the\s+)?hangeul\b[\s\S]{0,30}\b(?:up|down|online|offline)\b/i,
  /\b(?:check|ping)\s+(?:on\s+)?(?:the\s+)?hangeul\b/i,
  /\bhangeul\.com\b/i,
];

const KO_HANGEUL_CUES: RegExp[] = [
  /한글\s*(?:포털|관리자|어드민|리포트|보고서|현황|시스템|서버|사이트|대시보드)/,
  /한글\s*학원\s*(?:보고서|리포트|현황|상태|관리)/,
  /(?:관리자|어드민)\s*(?:리포트|보고서|현황|페이지)/,
  /(?:일일|데일리)\s*(?:리포트|보고서)/,
];

export function isHangeulQuery(text: string): boolean {
  const normalized = text.normalize("NFC");
  return EN_HANGEUL_CUES.some((re) => re.test(normalized)) || KO_HANGEUL_CUES.some((re) => re.test(normalized));
}

/** Health-check wording ("is the portal up?", "한글 포털 상태") rather than a report request. */
export function isHangeulStatusQuery(text: string): boolean {
  return /\b(?:status|online|offline|ping|health|healthy|reachable|uptime)\b|\b(?:up|down)\s*(?:right now|now)?\s*\??\s*$|상태|접속|작동|정상|다운/i.test(
    text,
  );
}

// ─── Deterministic demo data ────────────────────────────────────────────────

function hashString(value: string): number {
  let hash = 0x811c9dc5; // FNV-1a
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

function seededRandom(seed: number): () => number {
  let state = seed; // mulberry32
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const MOCK_TITLE = { en: "Hangeul daily operations report (demo data)", ko: "한글 학원 일일 운영 보고서 (데모 데이터)" };

const METRIC_LABEL_KO: Record<string, string> = {
  "Active students": "재원생",
  "Classes today": "오늘 수업",
  "Attendance rate": "출석률",
  "New enquiries": "신규 문의",
  "Pending payments": "미납 건수",
  "TOPIK registrations": "TOPIK 접수",
};

interface MockContent {
  metrics: HangeulMetric[];
  highlights: { en: string[]; ko: string[] };
}

function mockContent(utcDate: string): MockContent {
  const rand = seededRandom(hashString(`hangeul:${utcDate}`));
  const between = (min: number, max: number) => min + Math.floor(rand() * (max - min + 1));
  const students = between(180, 260);
  const classes = between(8, 16);
  const attendance = between(86, 97);
  const enquiries = between(3, 14);
  const trials = between(1, Math.max(1, Math.floor(enquiries / 2)));
  const pending = between(2, 11);
  const topik = between(5, 25);

  const pool = [
    { en: `Attendance at ${attendance}% across ${classes} classes today.`, ko: `오늘 ${classes}개 수업 출석률 ${attendance}%.` },
    { en: `${enquiries} new enquiries; ${trials} trial lessons booked.`, ko: `신규 문의 ${enquiries}건, 체험 수업 ${trials}건 예약.` },
    { en: `${pending} pending payments need follow-up.`, ko: `미납 ${pending}건 후속 조치 필요.` },
    { en: `${topik} students registered for the next TOPIK session.`, ko: `다음 TOPIK 시험 접수 ${topik}명.` },
  ];
  // Rotate the pool deterministically and keep 2-3 highlights.
  const start = between(0, pool.length - 1);
  const count = between(2, 3);
  const picked = Array.from({ length: count }, (_, i) => pool[(start + i) % pool.length]);

  return {
    metrics: [
      { label: "Active students", value: students },
      { label: "Classes today", value: classes },
      { label: "Attendance rate", value: `${attendance}%` },
      { label: "New enquiries", value: enquiries },
      { label: "Pending payments", value: pending },
      { label: "TOPIK registrations", value: topik },
    ],
    highlights: { en: picked.map((p) => p.en), ko: picked.map((p) => p.ko) },
  };
}

function utcDate(now: Date): string {
  return now.toISOString().slice(0, 10);
}

function mockReport(now: Date, source: "mock" | "mock-fallback", note: string): HangeulReport {
  const content = mockContent(utcDate(now));
  return {
    source,
    generatedAt: now.toISOString(),
    title: MOCK_TITLE.en,
    metrics: content.metrics,
    highlights: content.highlights.en,
    note,
  };
}

// ─── Live portal access ─────────────────────────────────────────────────────

/** Joins a portal path onto the base URL, keeping the base path (`/admin` + `/api/x` → `/admin/api/x`). */
export function joinUrl(baseUrl: string, path: string): string {
  const base = baseUrl.trim().replace(/\/+$/, "");
  const relative = path.trim().replace(/^\/+/, "");
  return new URL(relative, `${base}/`).toString();
}

function isLocalHost(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]" || hostname.endsWith(".localhost");
}

/** HTTP Basic credentials, UTF-8 safe (plain btoa only takes Latin-1). */
function basicAuth(username: string, password: string): string {
  const bytes = new TextEncoder().encode(`${username}:${password}`);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return `Basic ${btoa(binary)}`;
}

class BridgeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BridgeError";
  }
}

/** Reason safe to show to anyone: never the URL (it may embed credentials) or raw error text. */
function sanitizeReason(error: unknown): string {
  if (error instanceof BridgeError) return error.message;
  if (error instanceof Error && error.name === "TimeoutError") return `timed out after ${LIVE_TIMEOUT_MS / 1000}s`;
  if (error instanceof Error && error.name === "AbortError") return "request cancelled";
  if (error instanceof SyntaxError) return "portal did not return valid JSON";
  return "network error";
}

function portalSignal(parent?: AbortSignal | null): AbortSignal {
  const timeout = AbortSignal.timeout(LIVE_TIMEOUT_MS);
  return parent && typeof AbortSignal.any === "function" ? AbortSignal.any([parent, timeout]) : timeout;
}

async function fetchPortal(path: string, signal?: AbortSignal | null): Promise<{ res: Response; latencyMs: number }> {
  const { baseUrl, username, password } = getEnv().hangeul;
  if (!baseUrl || !username || !password) throw new BridgeError("portal not configured");

  let url: URL;
  try {
    url = new URL(joinUrl(baseUrl, path));
  } catch {
    throw new BridgeError("invalid HANGEUL_BASE_URL or path");
  }
  if (url.protocol !== "https:" && !(url.protocol === "http:" && isLocalHost(url.hostname))) {
    throw new BridgeError("HANGEUL_BASE_URL must use https");
  }
  if (url.username || url.password) throw new BridgeError("credentials must not be embedded in HANGEUL_BASE_URL");

  const started = Date.now();
  const res = await fetch(url, {
    headers: { authorization: basicAuth(username, password), accept: "application/json" },
    // A redirect usually means a login page; do not follow it with credentials attached.
    redirect: "manual",
    cache: "no-store",
    signal: portalSignal(signal),
  });
  return { res, latencyMs: Date.now() - started };
}

async function readJson(res: Response): Promise<unknown> {
  if (!res.ok) {
    await res.body?.cancel().catch(() => undefined);
    // Status 0 is an opaque redirect on runtimes that hide `redirect: "manual"` responses.
    if (res.status === 0 || (res.status >= 300 && res.status < 400)) {
      throw new BridgeError("portal redirected instead of returning JSON (check the endpoint path)");
    }
    throw new BridgeError(`portal answered HTTP ${res.status}`);
  }
  return JSON.parse(await res.text()) as unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** `active_students` / `classesToday` → "Active students" / "Classes today". */
export function humanizeKey(key: string): string {
  const words = key
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_\-.]+/g, " ")
    .trim()
    .toLowerCase();
  return words ? words[0].toUpperCase() + words.slice(1) : key;
}

function metricValue(value: unknown): string | number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) return truncate(value.trim(), 120);
  if (typeof value === "boolean") return value ? "yes" : "no";
  return null;
}

function metricsFromArray(items: unknown[]): HangeulMetric[] {
  const metrics: HangeulMetric[] = [];
  for (const item of items) {
    if (!isRecord(item)) continue;
    const label = item.label ?? item.name ?? item.key ?? item.title;
    const value = metricValue(item.value ?? item.count ?? item.total);
    if (typeof label === "string" && label.trim() && value !== null) metrics.push({ label: truncate(label.trim(), 60), value });
  }
  return metrics;
}

function metricsFromRecord(record: Record<string, unknown>, skip: Set<string>): HangeulMetric[] {
  const metrics: HangeulMetric[] = [];
  for (const [key, raw] of Object.entries(record)) {
    if (skip.has(key)) continue;
    const value = metricValue(raw);
    if (value !== null) metrics.push({ label: humanizeKey(key), value });
  }
  return metrics;
}

function highlightsFrom(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => {
      if (typeof item === "string") return item.trim();
      if (isRecord(item)) {
        const text = item.text ?? item.message ?? item.title ?? item.summary;
        return typeof text === "string" ? text.trim() : "";
      }
      return "";
    })
    .filter(Boolean)
    .map((text) => truncate(text, 240));
}

const META_KEYS = new Set([
  "title", "name", "report", "data", "metrics", "highlights", "notes", "alerts",
  "generatedAt", "generated_at", "date", "timestamp", "createdAt", "created_at", "id", "source", "note",
]);

/** Any portal JSON → HangeulReport. Uses metrics/highlights arrays when present, else flattens top-level values. */
export function normalizeHangeulReport(json: unknown, now: Date = new Date()): HangeulReport {
  let root: unknown = json;
  if (isRecord(root) && (isRecord(root.report) || isRecord(root.data))) root = isRecord(root.report) ? root.report : root.data;
  const record = isRecord(root) ? root : {};

  let metrics: HangeulMetric[] = [];
  if (Array.isArray(record.metrics)) metrics = metricsFromArray(record.metrics);
  else if (isRecord(record.metrics)) metrics = metricsFromRecord(record.metrics, new Set());
  if (metrics.length === 0) metrics = metricsFromRecord(record, META_KEYS);
  if (metrics.length === 0 && Array.isArray(root)) metrics = metricsFromArray(root);

  const highlights = [...highlightsFrom(record.highlights), ...highlightsFrom(record.alerts), ...highlightsFrom(record.notes)];

  const titleValue = record.title ?? record.name;
  const stamp = record.generatedAt ?? record.generated_at ?? record.timestamp ?? record.date;
  const parsed = typeof stamp === "string" || typeof stamp === "number" ? new Date(stamp) : null;

  const report: HangeulReport = {
    source: "live",
    generatedAt: parsed && !Number.isNaN(parsed.getTime()) ? parsed.toISOString() : now.toISOString(),
    title: typeof titleValue === "string" && titleValue.trim() ? truncate(titleValue.trim(), 120) : "Hangeul daily report",
    metrics: metrics.slice(0, MAX_METRICS),
    highlights: highlights.slice(0, MAX_HIGHLIGHTS),
  };
  if (report.metrics.length === 0 && report.highlights.length === 0) {
    report.note = "The portal responded, but the report contained no recognizable metrics.";
  }
  return report;
}

// ─── Public API ─────────────────────────────────────────────────────────────

export interface BridgeOptions {
  /** Caller proved a configured secret (access key, cron secret, Telegram admin chat). */
  trusted: boolean;
  signal?: AbortSignal | null;
  /** Clock override for tests. */
  now?: Date;
}

/** Why live data is not used for this caller, or null when it may be. */
function liveBlocker(trusted: boolean): string | null {
  const env = getEnv();
  if (env.hangeul.mockMode) return "MOCK_MODE is enabled, so this is demo data, not live portal data.";
  if (!hangeulLiveConfigured(env)) {
    return "The Hangeul portal is not configured (HANGEUL_BASE_URL, HANGEUL_USERNAME, HANGEUL_PASSWORD), so this is demo data.";
  }
  if (!trusted) return "Live portal data is only shared with trusted callers (valid access key or cron), so this is demo data.";
  return null;
}

export async function getHangeulReport(options: BridgeOptions): Promise<HangeulReport> {
  const now = options.now ?? new Date();
  const blocker = liveBlocker(options.trusted);
  if (blocker) return mockReport(now, "mock", blocker);

  try {
    const { res } = await fetchPortal(getEnv().hangeul.reportPath, options.signal);
    return normalizeHangeulReport(await readJson(res), now);
  } catch (error) {
    return mockReport(now, "mock-fallback", `Live portal request failed (${sanitizeReason(error)}), so this is demo data.`);
  }
}

function statusSaysOffline(body: unknown): boolean {
  if (!isRecord(body)) return false;
  if (body.online === false || body.ok === false || body.healthy === false) return true;
  const status = body.status ?? body.state;
  return typeof status === "string" && /down|offline|error|fail|maintenance|degraded/i.test(status);
}

export async function getHangeulStatus(options: BridgeOptions): Promise<HangeulStatus> {
  const now = options.now ?? new Date();
  const blocker = liveBlocker(options.trusted);
  if (blocker) {
    const latencyMs = 40 + (hashString(`latency:${utcDate(now)}`) % 80);
    return { source: "mock", online: true, checkedAt: now.toISOString(), latencyMs, note: blocker };
  }

  try {
    const { res, latencyMs } = await fetchPortal(getEnv().hangeul.statusPath, options.signal);
    let body: unknown = null;
    try {
      body = await readJson(res);
    } catch (error) {
      // A reachable portal that answers 2xx with non-JSON is still online.
      if (!(error instanceof SyntaxError)) throw error;
    }
    const online = !statusSaysOffline(body);
    const status: HangeulStatus = { source: "live", online, checkedAt: new Date().toISOString(), latencyMs };
    if (!online) status.note = "The portal reports a degraded or offline state.";
    return status;
  } catch (error) {
    return {
      source: "mock-fallback",
      online: false,
      checkedAt: new Date().toISOString(),
      note: `Live status check failed (${sanitizeReason(error)}).`,
    };
  }
}

// ─── Plain-text formatting (Telegram, offline answers) ──────────────────────

function formatValue(value: string | number, lang: "en" | "ko"): string {
  return typeof value === "number" ? value.toLocaleString(lang === "ko" ? "ko-KR" : "en-US") : value;
}

function formatStamp(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : `${date.toISOString().slice(0, 16).replace("T", " ")} UTC`;
}

function formatReportIn(report: HangeulReport, lang: "en" | "ko"): string {
  const isMock = report.source !== "live";
  // Demo highlights are regenerated in Korean when they are exactly the ones we produced.
  let highlights = report.highlights;
  let title = report.title;
  if (isMock && lang === "ko") {
    const content = mockContent(report.generatedAt.slice(0, 10));
    if (content.highlights.en.join("\n") === report.highlights.join("\n")) highlights = content.highlights.ko;
    if (report.title === MOCK_TITLE.en) title = MOCK_TITLE.ko;
  }

  const lines = [title, `${lang === "ko" ? "생성 시각" : "Generated"}: ${formatStamp(report.generatedAt)}`, ""];
  for (const metric of report.metrics) {
    const label = lang === "ko" ? (METRIC_LABEL_KO[metric.label] ?? metric.label) : metric.label;
    lines.push(`• ${label}: ${formatValue(metric.value, lang)}`);
  }
  if (highlights.length > 0) {
    lines.push("", lang === "ko" ? "주요 사항:" : "Highlights:");
    for (const h of highlights) lines.push(`- ${h}`);
  }
  if (isMock) {
    lines.push(
      "",
      lang === "ko"
        ? `※ 데모 데이터입니다. 실시간 포털 데이터가 아닙니다.${report.note ? ` (${report.note})` : ""}`
        : `Note: ${report.note ?? "This is demo data, not live portal data."}`,
    );
  } else if (report.note) {
    lines.push("", `${lang === "ko" ? "참고" : "Note"}: ${report.note}`);
  }
  return lines.join("\n").trim();
}

export function formatHangeulReport(report: HangeulReport, lang: ResolvedLang): string {
  if (lang === "bilingual") return `${formatReportIn(report, "en")}\n\n—\n\n${formatReportIn(report, "ko")}`;
  return formatReportIn(report, lang);
}

function formatStatusIn(status: HangeulStatus, lang: "en" | "ko"): string {
  const demo = status.source !== "live";
  const state =
    lang === "ko"
      ? status.online ? "온라인" : "오프라인 또는 연결 불가"
      : status.online ? "online" : "offline or unreachable";
  const lines = [
    lang === "ko" ? `한글 포털 상태: ${state}${demo && status.source === "mock" ? " (데모)" : ""}` : `Hangeul portal: ${state}${demo && status.source === "mock" ? " (demo)" : ""}`,
  ];
  if (status.latencyMs !== undefined) lines.push(`${lang === "ko" ? "응답 시간" : "Latency"}: ${status.latencyMs} ms`);
  lines.push(`${lang === "ko" ? "확인 시각" : "Checked"}: ${formatStamp(status.checkedAt)}`);
  if (status.note) lines.push(`${lang === "ko" ? "참고" : "Note"}: ${status.note}`);
  return lines.join("\n");
}

export function formatHangeulStatus(status: HangeulStatus, lang: ResolvedLang): string {
  if (lang === "bilingual") return `${formatStatusIn(status, "en")}\n\n—\n\n${formatStatusIn(status, "ko")}`;
  return formatStatusIn(status, lang);
}
