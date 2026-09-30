// Server-side reads of the Hangeul context (what Hangeul BOT publishes to
// Supabase), over PostgREST with the server-only secret key. Read-only: this
// module never calls hg_sync or writes anything.
//
// Every read has a timeout (3 s for answers, 10 s for the bulk device sync)
// and fails closed with a plain reason (HangeulReadError): a failed read is
// never an empty list or a silent 0 (R5). Reasons and logs never carry row
// data, keys or URLs. Edge-safe (fetch, btoa; no Node APIs), because the chat
// route that answers questions runs on Edge.
//
// PostgREST caps every response at 1,000 rows (hg_changes_since included), so
// every list loops in pages until a short page comes back.

import { withTimeout } from "../agents/search-agent";
import { getEnv } from "../env";
import { MemoryError, supabaseRest, supabaseRestResponse } from "../memory/supabase";
import type { HangeulDataStatus, HangeulReportSummary, HangeulRunSummary } from "../types";
import { applyFilter, matchesFilter, rankStudents } from "./filter";
import {
  HG_KINDS,
  HangeulReadError,
  isHgKind,
  type HangeulReaders,
  type HgChange,
  type HgHit,
  type HgKind,
  type HgRecord,
  type HgRun,
  type HgRunStatus,
  type MatchOptions,
  type RecordFilter,
  type StudentQuery,
} from "./types";
import { EMBEDDING_DIMENSIONS, encodeVector, parsePgVector } from "./vectors";

export const READ_TIMEOUT_MS = 3_000;
export const BULK_TIMEOUT_MS = 10_000;
/** hg_match answers in ~0.3 s warm, but a cold HNSW scan was seen to pass 3 s (live check, 1 Oct). */
export const MATCH_TIMEOUT_MS = 6_000;
/** PostgREST's max-rows. */
export const PAGE_ROWS = 1_000;
/** Most rows one records() call returns; plans ask for far fewer. */
const MAX_ROWS = 20_000;
/** Keys per `key=in.(...)` request, to keep URLs short (keys hold names and file names). */
const KEYS_PER_REQUEST = 50;
/** Byte budget of one snapshot or changes page: under Vercel's 4.5 MB response cap. */
export const PAGE_BYTES = 3_000_000;
const RECENT_RUNS = 200;

export interface StoreOptions {
  signal?: AbortSignal | null;
  timeoutMs?: number;
}

export function hangeulConfigured(): boolean {
  return getEnv().hangeul.enabled;
}

// ─── Errors ─────────────────────────────────────────────────────────────────

/** A Supabase failure → a HangeulReadError with a plain reason. */
export function readError(error: unknown): HangeulReadError {
  if (error instanceof HangeulReadError) return error;
  if (error instanceof MemoryError) {
    if (error.message === "memory not configured") return new HangeulReadError("Hangeul data is not configured", "not_configured");
    if (error.message === "aborted") return new HangeulReadError("request cancelled", "cancelled");
    if (error.message === "timeout" || error.message === "network error") {
      return new HangeulReadError(`Hangeul data unreachable (${error.message})`);
    }
    if (/PGRST20[25]|42P01|42883/.test(error.message)) return new HangeulReadError("Hangeul tables are missing (not migrated)", "not_migrated");
    return new HangeulReadError(`Hangeul data unreachable (${error.message})`);
  }
  if (error instanceof SyntaxError) return new HangeulReadError("Hangeul data returned malformed JSON", "invalid");
  return new HangeulReadError("Hangeul data unreachable");
}

async function get<T>(path: string, options: StoreOptions, extra: { headers?: Record<string, string> } = {}): Promise<T> {
  if (!hangeulConfigured()) throw new HangeulReadError("Hangeul data is not configured", "not_configured");
  try {
    return await supabaseRest<T>(path, { signal: options.signal, timeoutMs: options.timeoutMs ?? READ_TIMEOUT_MS, headers: extra.headers });
  } catch (error) {
    throw readError(error);
  }
}

async function rpc<T>(name: "hg_match" | "hg_changes_since", body: unknown, options: StoreOptions): Promise<T> {
  if (!hangeulConfigured()) throw new HangeulReadError("Hangeul data is not configured", "not_configured");
  try {
    return await supabaseRest<T>(`rpc/${name}`, {
      method: "POST",
      body,
      signal: options.signal,
      timeoutMs: options.timeoutMs ?? READ_TIMEOUT_MS,
    });
  } catch (error) {
    throw readError(error);
  }
}

// ─── Query building ─────────────────────────────────────────────────────────

/** A value inside `in.(...)` / `or=(...)`: double-quoted, with `\` and `"` escaped (keys hold `|`, `,`, `.`, `()`). */
export function quoteValue(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

const enc = encodeURIComponent;
const SAFE_FIELD = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** PostgREST filter parameters for a RecordFilter (without paging). Rows are re-checked with matchesFilter. */
export function filterParams(kind: string, filter: RecordFilter = {}): string[] {
  const p = [`kind=eq.${enc(kind)}`];
  if (filter.key !== undefined) p.push(`key=eq.${enc(filter.key)}`);
  if (filter.keys !== undefined) p.push(`key=in.${enc(`(${filter.keys.map(quoteValue).join(",")})`)}`);
  if (filter.keySuffix !== undefined) p.push(`key=like.${enc(`*${filter.keySuffix}`)}`);
  if (filter.scope !== undefined) p.push(`scope=eq.${enc(filter.scope)}`);
  if (filter.scopePrefix !== undefined) p.push(`scope=like.${enc(`${filter.scopePrefix}*`)}`);
  if (filter.day !== undefined) p.push(`day=eq.${enc(filter.day)}`);
  if (filter.from !== undefined) p.push(`day=gte.${enc(filter.from)}`);
  if (filter.to !== undefined) p.push(`day=lte.${enc(filter.to)}`);
  if (filter.studentUid !== undefined) p.push(`student_uid=eq.${Math.trunc(filter.studentUid)}`);
  if (filter.studentHngId !== undefined) p.push(`student_hng_id=eq.${enc(filter.studentHngId)}`);
  if (filter.passportNo !== undefined) p.push(`passport_no=eq.${enc(filter.passportNo)}`);
  for (const [field, value] of Object.entries(filter.dataEq ?? {})) {
    if (SAFE_FIELD.test(field)) p.push(`data->>${field}=eq.${enc(value)}`);
  }
  p.push(filter.order === "day.desc" ? "order=day.desc.nullslast,key.asc" : "order=key.asc");
  return p;
}

// ─── Rows ───────────────────────────────────────────────────────────────────

interface RawRecord {
  kind?: unknown;
  key?: unknown;
  scope?: unknown;
  student_uid?: unknown;
  student_hng_id?: unknown;
  student_name?: unknown;
  passport_no?: unknown;
  day?: unknown;
  data?: unknown;
  content?: unknown;
  content_hash?: unknown;
  source?: unknown;
  read_at?: unknown;
  run_id?: unknown;
  updated_at?: unknown;
}

const text = (v: unknown): string | null => (typeof v === "string" && v !== "" ? v : null);

export function toRecord(raw: RawRecord): HgRecord {
  const uid = typeof raw.student_uid === "number" ? raw.student_uid : raw.student_uid === null || raw.student_uid === undefined ? null : Number(raw.student_uid);
  return {
    kind: String(raw.kind ?? ""),
    key: String(raw.key ?? ""),
    scope: String(raw.scope ?? ""),
    student_uid: uid !== null && Number.isFinite(uid) ? uid : null,
    student_hng_id: text(raw.student_hng_id),
    student_name: text(raw.student_name),
    passport_no: text(raw.passport_no),
    day: typeof raw.day === "string" ? raw.day.slice(0, 10) : null,
    data: raw.data && typeof raw.data === "object" && !Array.isArray(raw.data) ? (raw.data as Record<string, unknown>) : {},
    content: typeof raw.content === "string" ? raw.content : "",
    content_hash: text(raw.content_hash) ?? undefined,
    source: text(raw.source) ?? undefined,
    read_at: typeof raw.read_at === "string" ? raw.read_at : "",
    run_id: text(raw.run_id),
    updated_at: text(raw.updated_at) ?? undefined,
  };
}

async function pagedRecords(params: string[], wanted: number, options: StoreOptions, pageRows = PAGE_ROWS): Promise<HgRecord[]> {
  const out: HgRecord[] = [];
  for (let offset = 0; out.length < wanted; offset += pageRows) {
    const limit = Math.min(pageRows, wanted - out.length);
    const rows = await get<RawRecord[]>(`hg_records?select=*&${params.join("&")}&limit=${limit}&offset=${offset}`, options);
    if (!Array.isArray(rows)) throw new HangeulReadError("Hangeul data returned malformed rows", "invalid");
    out.push(...rows.map(toRecord));
    if (rows.length < limit) break;
  }
  return out;
}

/** Records of one kind matching `filter` (all conditions ANDed), paged past PostgREST's 1,000-row cap. */
export async function readRecords(kind: HgKind, filter: RecordFilter = {}, options: StoreOptions = {}): Promise<HgRecord[]> {
  const wanted = Math.min(filter.limit ?? MAX_ROWS, MAX_ROWS);
  let rows: HgRecord[];
  if (filter.keys !== undefined) {
    if (filter.keys.length === 0) return [];
    rows = [];
    for (let i = 0; i < filter.keys.length; i += KEYS_PER_REQUEST) {
      const part = { ...filter, keys: filter.keys.slice(i, i + KEYS_PER_REQUEST), limit: undefined };
      rows.push(...(await pagedRecords(filterParams(kind, part), MAX_ROWS, options)));
    }
  } else {
    rows = await pagedRecords(filterParams(kind, { ...filter, limit: undefined }), wanted, options);
  }
  return applyFilter(
    rows.filter((r) => r.kind === kind && matchesFilter(r, filter)),
    filter,
  );
}

function nameTokens(name: string): string[] {
  return name
    .split(/[^\p{L}\p{N}]+/u)
    .filter((t) => t.length >= 2)
    .slice(0, 4);
}

/** Students by HNG id, portal uid or passport (exact), else by name: exact (any case), then every token. */
export async function findStudents(query: StudentQuery, options: StoreOptions = {}): Promise<HgRecord[]> {
  let params: string[];
  if (query.hngId) params = [`kind=eq.student`, `student_hng_id=eq.${enc(query.hngId)}`];
  else if (query.uid !== undefined) params = [`kind=eq.student`, `key=eq.${enc(String(Math.trunc(query.uid)))}`];
  else if (query.passport) params = [`kind=eq.student`, `passport_no=eq.${enc(query.passport)}`];
  else if (query.name) {
    const name = query.name.replace(/[*%_,()"\\]/g, " ").replace(/\s+/g, " ").trim();
    if (!name) return [];
    const exact = await pagedRecords([`kind=eq.student`, `student_name=ilike.${enc(name)}`, "order=key.asc"], 50, options);
    const ranked = rankStudents(exact, { name });
    if (ranked.length) return ranked;
    const tokens = nameTokens(name);
    if (tokens.length === 0) return [];
    const and = `(${tokens.map((t) => `student_name.ilike.*${t}*`).join(",")})`;
    const loose = await pagedRecords([`kind=eq.student`, `and=${enc(and)}`, "order=key.asc"], 50, options);
    return rankStudents(loose, { name });
  } else return [];
  const rows = await pagedRecords([...params, "order=key.asc"], 50, options);
  return rankStudents(rows, query);
}

// ─── Runs ───────────────────────────────────────────────────────────────────

interface RawRun {
  job?: unknown;
  started_at?: unknown;
  finished_at?: unknown;
  status?: unknown;
  by_kind?: unknown;
  failed_reads?: unknown;
}

const RUN_SELECT = "select=job,started_at,finished_at,status,by_kind:counts->by_kind,failed_reads:counts->failed_reads";
const RUN_DONE = "finished_at=not.is.null&status=in.(ok,partial)";

function toRun(raw: RawRun): HgRun {
  const byKind: Record<string, number[]> = {};
  if (raw.by_kind && typeof raw.by_kind === "object" && !Array.isArray(raw.by_kind)) {
    for (const [kind, value] of Object.entries(raw.by_kind as Record<string, unknown>)) {
      byKind[kind] = Array.isArray(value) ? value.map((n) => (typeof n === "number" ? n : 0)) : [];
    }
  }
  const status = raw.status === "ok" || raw.status === "partial" || raw.status === "failed" ? (raw.status as HgRunStatus) : null;
  return {
    job: String(raw.job ?? ""),
    started_at: String(raw.started_at ?? ""),
    finished_at: typeof raw.finished_at === "string" ? raw.finished_at : null,
    status,
    byKind,
    failedReads: Array.isArray(raw.failed_reads) ? raw.failed_reads.filter((f): f is string => typeof f === "string") : [],
  };
}

/**
 * Finished runs (ok or partial), newest first: the recent ones, plus, for each
 * kind in `kinds` none of them read, the newest run that did (e.g. kinds only
 * the backfill has published so far).
 */
export async function readRuns(kinds: readonly string[] = [], options: StoreOptions = {}): Promise<HgRun[]> {
  const recent = await get<RawRun[]>(`hg_runs?${RUN_SELECT}&${RUN_DONE}&order=finished_at.desc&limit=${RECENT_RUNS}`, options);
  if (!Array.isArray(recent)) throw new HangeulReadError("Hangeul data returned malformed runs", "invalid");
  const runs = recent.map(toRun);
  const missing = [...new Set(kinds)].filter((k) => isHgKind(k) && !runs.some((r) => k in r.byKind));
  const older = await Promise.all(
    missing.map((kind) =>
      get<RawRun[]>(`hg_runs?${RUN_SELECT}&${RUN_DONE}&counts->by_kind=cs.${enc(JSON.stringify({ [kind]: [] }))}&order=finished_at.desc&limit=1`, options),
    ),
  );
  for (const rows of older) {
    for (const r of Array.isArray(rows) ? rows.map(toRun) : []) {
      if (!runs.some((x) => x.job === r.job && x.started_at === r.started_at)) runs.push(r);
    }
  }
  return runs.sort((a, b) => ((a.finished_at ?? "") < (b.finished_at ?? "") ? 1 : -1));
}

export type RunSummary = HangeulRunSummary;

/** The newest finished run of each job. */
export function lastRunPerJob(runs: readonly HgRun[]): RunSummary[] {
  const out = new Map<string, RunSummary>();
  for (const r of runs) {
    if (r.finished_at && !out.has(r.job)) out.set(r.job, { job: r.job, finishedAt: r.finished_at, status: r.status });
  }
  return [...out.values()];
}

// ─── Change log ─────────────────────────────────────────────────────────────

interface RawChange {
  seq?: unknown;
  kind?: unknown;
  key?: unknown;
  op?: unknown;
  changed_at?: unknown;
}

function toChange(raw: RawChange): HgChange {
  return {
    seq: Number(raw.seq ?? 0),
    kind: String(raw.kind ?? ""),
    key: String(raw.key ?? ""),
    op: raw.op === "delete" ? "delete" : "upsert",
    changed_at: String(raw.changed_at ?? ""),
  };
}

/** Change-log rows (light form) changed at or after `sinceIso`, oldest first, up to `limit`. */
export async function readChanges(sinceIso: string, limit = MAX_ROWS, options: StoreOptions = {}): Promise<HgChange[]> {
  const out: HgChange[] = [];
  let after = 0;
  while (out.length < limit) {
    const page = Math.min(PAGE_ROWS, limit - out.length);
    const rows = await get<RawChange[]>(
      `hg_changes?select=seq,kind,key,op,changed_at&changed_at=gte.${enc(sinceIso)}&seq=gt.${after}&order=seq.asc&limit=${page}`,
      options,
    );
    if (!Array.isArray(rows)) throw new HangeulReadError("Hangeul data returned malformed changes", "invalid");
    out.push(...rows.map(toChange));
    if (rows.length < page) break;
    after = out[out.length - 1].seq;
  }
  return out;
}

/** The newest change-log seq (0 when the log is empty): where a device's delta starts after a snapshot. */
export async function readMaxSeq(options: StoreOptions = {}): Promise<number> {
  const rows = await get<{ seq?: unknown }[]>("hg_changes?select=seq&order=seq.desc&limit=1", options);
  const seq = Array.isArray(rows) && rows[0] ? Number(rows[0].seq) : 0;
  return Number.isFinite(seq) ? seq : 0;
}

// ─── Wire forms (device sync) ───────────────────────────────────────────────

/** A chunk as the device receives it. `content` is left out when it equals the record's content. */
export interface WireChunk {
  kind: string;
  key: string;
  ord: number;
  content?: string;
  /** base64 of little-endian float32, 384 values. */
  embedding: string;
  embed_model: string;
}

export interface WireChange {
  seq: number;
  kind: string;
  key: string;
  op: "upsert" | "delete";
  changed_at: string;
  /** The record now (upserts). Null when it was deleted later: its delete follows in the feed. Absent for deletes. */
  record?: HgRecord | null;
  chunks?: WireChunk[] | null;
}

function wireChunk(kind: string, key: string, raw: { ord?: unknown; content?: unknown; embedding?: unknown; embed_model?: unknown }, recordContent: string): WireChunk {
  const vector = parsePgVector(raw.embedding);
  if (!vector || vector.length !== EMBEDDING_DIMENSIONS) throw new HangeulReadError("a stored vector could not be read", "invalid");
  const content = typeof raw.content === "string" ? raw.content : "";
  const chunk: WireChunk = { kind, key, ord: Number(raw.ord ?? 0), embedding: encodeVector(vector), embed_model: String(raw.embed_model ?? "") };
  if (content !== recordContent) chunk.content = content;
  return chunk;
}

/** UTF-8 bytes of a value's JSON (Vercel's response cap counts bytes; OCR text may hold Bangla or Korean). */
function bytes(value: unknown): number {
  const json = JSON.stringify(value);
  let n = json.length;
  for (let i = 0; i < json.length; i++) {
    const c = json.charCodeAt(i);
    if (c < 0x80) continue;
    if (c < 0x800) n += 1;
    else if (c >= 0xd800 && c <= 0xdbff) {
      n += 2; // a surrogate pair: 4 bytes for 2 UTF-16 units
      i++;
    } else n += 2;
  }
  return n;
}

export interface ChangesPage {
  changes: WireChange[];
  /** Pass as `since` for the next page (the last seq returned, or `since` when there was none). */
  next_seq: number;
  more: boolean;
}

/** Changes after `since` with current records and base64 vectors, cut to the page byte budget. */
export async function readChangesSince(since: number, limit = 200, options: StoreOptions = {}): Promise<ChangesPage> {
  const cap = Math.max(1, Math.min(PAGE_ROWS, Math.trunc(limit)));
  const rows = await rpc<
    {
      seq?: unknown;
      kind?: unknown;
      key?: unknown;
      op?: unknown;
      changed_at?: unknown;
      record?: RawRecord | null;
      chunks?: { ord?: unknown; content?: unknown; embedding?: unknown; embed_model?: unknown }[] | null;
    }[]
  >("hg_changes_since", { p_seq: Math.max(0, Math.trunc(since)), p_limit: cap }, { timeoutMs: BULK_TIMEOUT_MS, ...options });
  if (!Array.isArray(rows)) throw new HangeulReadError("Hangeul data returned malformed changes", "invalid");
  const changes: WireChange[] = [];
  let total = 0;
  let cut = false;
  for (const raw of rows) {
    const base = toChange(raw);
    let change: WireChange;
    if (base.op === "delete") {
      change = base;
    } else if (!raw.record) {
      change = { ...base, record: null, chunks: null };
    } else {
      const record = toRecord(raw.record);
      change = { ...base, record, chunks: (raw.chunks ?? []).map((c) => wireChunk(base.kind, base.key, c, record.content)) };
    }
    const size = bytes(change);
    if (changes.length > 0 && total + size > PAGE_BYTES) {
      cut = true;
      break;
    }
    total += size;
    changes.push(change);
  }
  return {
    changes,
    next_seq: changes.length ? changes[changes.length - 1].seq : Math.max(0, Math.trunc(since)),
    more: cut || rows.length === cap,
  };
}

// ─── Snapshot (a device's first sync) ───────────────────────────────────────

interface SnapshotCursor {
  v: 1;
  /** max_seq read before the first page: the device's changes start after it. */
  s: number;
  /** Index into HG_KINDS. */
  k: number;
  /** Last key sent of that kind (keyset: stable under deletes, unlike offsets). */
  a: string | null;
}

function toBase64Url(value: string): string {
  const b = new TextEncoder().encode(value);
  let binary = "";
  for (const byte of b) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64Url(value: string): string {
  const b64 = value.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(b64 + "=".repeat((4 - (b64.length % 4)) % 4));
  return new TextDecoder().decode(Uint8Array.from(binary, (c) => c.charCodeAt(0)));
}

export function encodeCursor(cursor: SnapshotCursor): string {
  return toBase64Url(JSON.stringify(cursor));
}

/** A cursor from a client, or null when it is not one of ours. */
export function decodeCursor(value: string): SnapshotCursor | null {
  try {
    const c = JSON.parse(fromBase64Url(value)) as Partial<SnapshotCursor>;
    if (c.v !== 1 || !Number.isInteger(c.s) || !Number.isInteger(c.k) || (c.s as number) < 0) return null;
    if ((c.k as number) < 0 || (c.k as number) > HG_KINDS.length) return null;
    if (c.a !== null && typeof c.a !== "string") return null;
    return { v: 1, s: c.s as number, k: c.k as number, a: c.a ?? null };
  } catch {
    return null;
  }
}

export interface SnapshotPage {
  max_seq: number;
  records: HgRecord[];
  chunks: WireChunk[];
  /** Cursor for the next page; null after the last page. */
  next: string | null;
}

/** Records per request while paging a kind (the OCR pages are large). */
function snapshotBatch(kind: string): number {
  return kind === "doc_page_text" ? 150 : 500;
}

async function chunksFor(kind: string, records: HgRecord[], options: StoreOptions): Promise<Map<string, WireChunk[]>> {
  const out = new Map<string, WireChunk[]>();
  if (records.length === 0) return out;
  const byKey = new Map(records.map((r) => [r.key, r]));
  const first = records[0].key;
  const last = records[records.length - 1].key;
  for (let offset = 0; ; offset += 500) {
    const rows = await get<{ key?: unknown; ord?: unknown; content?: unknown; embedding?: unknown; embed_model?: unknown }[]>(
      `hg_chunks?select=key,ord,content,embedding,embed_model&kind=eq.${enc(kind)}&key=gte.${enc(first)}&key=lte.${enc(last)}&order=key.asc,ord.asc&limit=500&offset=${offset}`,
      options,
    );
    if (!Array.isArray(rows)) throw new HangeulReadError("Hangeul data returned malformed chunks", "invalid");
    for (const raw of rows) {
      const key = String(raw.key ?? "");
      const record = byKey.get(key);
      if (!record) continue;
      const chunk = wireChunk(kind, key, raw, record.content);
      const list = out.get(key);
      if (list) list.push(chunk);
      else out.set(key, [chunk]);
    }
    if (rows.length < 500) break;
  }
  return out;
}

/**
 * One page of the full dump: records and their chunks (base64 vectors), kind by
 * kind in HG_KINDS order and key order within a kind, cut to the byte budget.
 * The first page (no cursor) reads max_seq before anything else, so applying
 * the changes after it on top of the snapshot converges on the current data.
 */
export async function readSnapshotPage(cursorText: string | null, options: StoreOptions = {}): Promise<SnapshotPage> {
  const bulk = { timeoutMs: BULK_TIMEOUT_MS, ...options };
  let cursor: SnapshotCursor;
  if (cursorText) {
    const decoded = decodeCursor(cursorText);
    if (!decoded) throw new HangeulReadError("invalid snapshot cursor", "invalid");
    cursor = decoded;
  } else {
    cursor = { v: 1, s: await readMaxSeq(bulk), k: 0, a: null };
  }
  const records: HgRecord[] = [];
  const chunks: WireChunk[] = [];
  let total = 0;
  while (cursor.k < HG_KINDS.length) {
    const kind = HG_KINDS[cursor.k];
    const batch = snapshotBatch(kind);
    const params = [`kind=eq.${enc(kind)}`, ...(cursor.a !== null ? [`key=gt.${enc(cursor.a)}`] : []), "order=key.asc"];
    const rows = await get<RawRecord[]>(`hg_records?select=*&${params.join("&")}&limit=${batch}`, bulk);
    if (!Array.isArray(rows)) throw new HangeulReadError("Hangeul data returned malformed rows", "invalid");
    const found = rows.map(toRecord);
    const foundChunks = await chunksFor(kind, found, bulk);
    let lastSent: string | null = null;
    let kept = 0;
    for (const record of found) {
      const own = foundChunks.get(record.key) ?? [];
      const size = bytes(record) + own.reduce((n, c) => n + bytes(c), 0);
      if (records.length > 0 && total + size > PAGE_BYTES) break;
      total += size;
      records.push(record);
      chunks.push(...own);
      lastSent = record.key;
      kept++;
    }
    if (kept < found.length) {
      // The budget ran out inside this kind: continue after the last record of it sent (if any).
      if (lastSent !== null) cursor = { ...cursor, a: lastSent };
      return { max_seq: cursor.s, records, chunks, next: encodeCursor(cursor) };
    }
    cursor = rows.length < batch ? { ...cursor, k: cursor.k + 1, a: null } : { ...cursor, a: found[found.length - 1].key };
    if (total >= PAGE_BYTES * 0.9) break;
  }
  return { max_seq: cursor.s, records, chunks, next: cursor.k < HG_KINDS.length ? encodeCursor(cursor) : null };
}

// ─── Search ─────────────────────────────────────────────────────────────────

function toHit(raw: Record<string, unknown>): HgHit {
  const record = toRecord(raw as RawRecord);
  return {
    kind: record.kind,
    key: record.key,
    ord: Number(raw.ord ?? 0),
    content: typeof raw.content === "string" ? raw.content : "",
    similarity: typeof raw.similarity === "number" ? raw.similarity : Number(raw.similarity ?? 0),
    data: record.data,
    day: record.day,
    read_at: record.read_at,
    student_uid: record.student_uid,
    student_hng_id: record.student_hng_id,
    student_name: record.student_name,
  };
}

/** Vector search over every chunk (hg_match), nearest first. */
export async function matchChunks(embedding: readonly number[], opts: MatchOptions = {}, options: StoreOptions = {}): Promise<HgHit[]> {
  if (embedding.length !== EMBEDDING_DIMENSIONS) throw new HangeulReadError("search needs a 384-number embedding", "invalid");
  const rows = await rpc<Record<string, unknown>[]>(
    "hg_match",
    {
      p_embedding: embedding,
      p_count: Math.max(1, Math.min(100, opts.count ?? 12)),
      p_kinds: opts.kinds?.length ? opts.kinds : null,
      p_day_from: opts.from ?? null,
      p_day_to: opts.to ?? null,
      p_student_uid: opts.studentUid ?? null,
    },
    { timeoutMs: MATCH_TIMEOUT_MS, ...options },
  );
  if (!Array.isArray(rows)) throw new HangeulReadError("Hangeul search returned malformed rows", "invalid");
  return rows.map(toHit);
}

/** hg-embed's own limits (supabase/functions/hg-embed/index.ts). */
const EMBED_MAX_TEXTS = 16;
const EMBED_MAX_CHARS = 2_000;

/**
 * Question embeddings from the hg-embed Edge Function (gte-small, like the
 * stored vectors). Fails closed ("search not available") while the function
 * is not deployed; structured plans never need it.
 */
export async function embedQuestion(texts: readonly string[], options: StoreOptions = {}): Promise<number[][]> {
  const env = getEnv();
  const key = env.memory.serviceKey;
  if (!env.hangeul.enabled || !env.hangeul.embedUrl || !key) {
    throw new HangeulReadError("search not available (not configured)", "not_configured");
  }
  const wanted = texts.slice(0, EMBED_MAX_TEXTS).map((t) => t.trim().slice(0, EMBED_MAX_CHARS));
  if (wanted.length === 0 || wanted.some((t) => !t)) throw new HangeulReadError("search not available (empty question)", "invalid");
  // The same header rule as supabaseRest: sb_secret_… in apikey; a legacy JWT also as the bearer token.
  const headers: Record<string, string> = { "content-type": "application/json", apikey: key };
  if (key.startsWith("eyJ")) headers.authorization = `Bearer ${key}`;
  let res: Response;
  try {
    res = await fetch(env.hangeul.embedUrl, {
      method: "POST",
      headers,
      body: JSON.stringify({ texts: wanted }),
      signal: withTimeout(options.timeoutMs ?? READ_TIMEOUT_MS, options.signal),
      cache: "no-store",
    });
  } catch (error) {
    const name = error instanceof Error ? error.name : "";
    throw new HangeulReadError(`search not available (${name === "TimeoutError" ? "timeout" : "network error"})`);
  }
  if (!res.ok) {
    await res.body?.cancel().catch(() => undefined);
    throw new HangeulReadError(`search not available (${res.status === 404 ? "embedding function not deployed" : `HTTP ${res.status}`})`);
  }
  let body: { embeddings?: unknown };
  try {
    body = (await res.json()) as { embeddings?: unknown };
  } catch {
    throw new HangeulReadError("search not available (malformed embeddings)", "invalid");
  }
  const vectors = Array.isArray(body.embeddings) ? body.embeddings : [];
  if (vectors.length !== wanted.length || !vectors.every((v) => Array.isArray(v) && v.length === EMBEDDING_DIMENSIONS && v.every((n) => typeof n === "number"))) {
    throw new HangeulReadError("search not available (malformed embeddings)", "invalid");
  }
  return vectors as number[][];
}

// ─── Overview (status endpoints) ────────────────────────────────────────────

/** Total hg_records rows (PostgREST's exact count in Content-Range). */
export async function countRecords(options: StoreOptions = {}): Promise<number> {
  if (!hangeulConfigured()) throw new HangeulReadError("Hangeul data is not configured", "not_configured");
  try {
    const { headers } = await supabaseRestResponse("hg_records?select=kind&limit=1", {
      headers: { prefer: "count=exact" },
      signal: options.signal,
      timeoutMs: options.timeoutMs ?? READ_TIMEOUT_MS,
    });
    const total = Number((headers.get("content-range") ?? "").split("/")[1]);
    if (!Number.isFinite(total)) throw new HangeulReadError("Hangeul data returned no count", "invalid");
    return total;
  } catch (error) {
    throw readError(error);
  }
}

export type ReportSummary = HangeulReportSummary;

async function latestReport(scope: string | null, options: StoreOptions): Promise<ReportSummary | null> {
  const rows = await get<RawRecord[]>(
    `hg_records?select=key,scope,day,read_at&kind=eq.report${scope ? `&scope=eq.${enc(scope)}` : ""}&order=day.desc.nullslast,read_at.desc&limit=1`,
    options,
  );
  const row = Array.isArray(rows) ? rows[0] : undefined;
  if (!row) return null;
  return { key: String(row.key ?? ""), report: String(row.scope ?? ""), day: typeof row.day === "string" ? row.day : null, read_at: String(row.read_at ?? "") };
}

/** What the HUD panel shows: volume, latest runs, latest brief (keys and times only, no content). */
export async function readDataStatus(options: StoreOptions = {}): Promise<HangeulDataStatus> {
  const [records, runs, latestBrief, latest] = await Promise.all([
    countRecords(options),
    readRuns([], options),
    latestReport("brief", options),
    latestReport(null, options),
  ]);
  return { configured: true, records, lastRuns: lastRunPerJob(runs), latestBrief, latestReport: latest };
}

// ─── Readers ────────────────────────────────────────────────────────────────

/** The server's HangeulReaders: Supabase over PostgREST. */
export function createHangeulStore(options: StoreOptions = {}): HangeulReaders {
  return {
    records: (kind, filter) => readRecords(kind, filter, options),
    runs: (kinds) => readRuns(kinds, options),
    findStudents: (query) => findStudents(query, options),
    changes: (sinceIso, limit) => readChanges(sinceIso, limit, options),
    match: (embedding, opts) => matchChunks(embedding, opts, options),
    embed: (texts) => embedQuestion(texts, options),
  };
}
