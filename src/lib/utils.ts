import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";
import type { LangMode, ResolvedLang } from "./types";

/** Tailwind-aware className combiner. */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}

// Hangul Jamo, Compatibility Jamo and Syllables.
const HANGUL_CHAR = /[ᄀ-ᇿ㄰-㆏가-힯]/;
const HANGUL_GLOBAL = /[ᄀ-ᇿ㄰-㆏가-힯]/g;
const LATIN_GLOBAL = /[A-Za-z]/g;

export function containsHangul(text: string): boolean {
  return HANGUL_CHAR.test(text);
}

/**
 * Dominant language of a message. A Hangul syllable carries roughly as much
 * content as 2-3 Latin letters, so Korean wins once hangul*2 >= latin.
 */
export function detectLanguage(text: string): "en" | "ko" {
  const hangul = text.match(HANGUL_GLOBAL)?.length ?? 0;
  if (hangul === 0) return "en";
  const latin = text.match(LATIN_GLOBAL)?.length ?? 0;
  return hangul * 2 >= latin ? "ko" : "en";
}

/** Asking for both languages in the message itself switches to bilingual. */
const BILINGUAL_REQUEST =
  /\b(bilingual(ly)?|in both (languages|english and korean|korean and english))\b|영어(와|랑|하고)\s*한국어|한국어(와|랑|하고)\s*영어|두\s*언어/i;

export function resolveLanguage(mode: LangMode | undefined, text: string): ResolvedLang {
  if (mode === "en" || mode === "ko" || mode === "bilingual") return mode;
  if (BILINGUAL_REQUEST.test(text)) return "bilingual";
  return detectLanguage(text);
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/**
 * HTTP header values must be ASCII, but source titles can be Korean. Encode as
 * base64(UTF-8 JSON). Works in the browser, Edge and Node.js runtimes.
 */
export function encodeHeaderJson(value: unknown): string {
  return bytesToBase64(new TextEncoder().encode(JSON.stringify(value)));
}

export function decodeHeaderJson<T>(value: string | null | undefined): T | null {
  if (!value) return null;
  try {
    return JSON.parse(new TextDecoder().decode(base64ToBytes(value))) as T;
  } catch {
    return null;
  }
}

export function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, Math.max(0, max - 1)).trimEnd()}…`;
}

/** Constant-time string comparison (no Node crypto needed, so it runs on Edge). */
export function timingSafeEqual(a: string, b: string): boolean {
  const ea = new TextEncoder().encode(a);
  const eb = new TextEncoder().encode(b);
  let diff = ea.length ^ eb.length;
  const len = Math.max(ea.length, eb.length);
  for (let i = 0; i < len; i++) diff |= (ea[i] ?? 0) ^ (eb[i] ?? 0);
  return diff === 0;
}

/** Text safe to hand to a speech engine: no markdown, code, or bare URLs. */
export function stripMarkdownForSpeech(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`([^`]*)`/g, "$1")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/https?:\/\/\S+/g, " ")
    .replace(/^\s{0,3}#{1,6}\s+/gm, "")
    .replace(/^\s*[-*+]\s+/gm, "")
    .replace(/^\s*\d+\.\s+/gm, "")
    .replace(/[*_~>|#]+/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** JSON Response helper used by every API route. */
export function jsonResponse(body: unknown, status = 200, headers?: HeadersInit): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...headers },
  });
}

export function errorResponse(status: number, code: string, error: string): Response {
  return jsonResponse({ error, code }, status);
}

/** Rough data-URL size check (bytes of the decoded payload). */
export function dataUrlByteLength(dataUrl: string): number {
  const comma = dataUrl.indexOf(",");
  const payload = comma === -1 ? dataUrl : dataUrl.slice(comma + 1);
  return Math.floor((payload.length * 3) / 4);
}

export function isImageDataUrl(value: unknown): value is string {
  return typeof value === "string" && /^data:image\/(png|jpe?g|webp|gif);base64,[A-Za-z0-9+/=]+$/.test(value);
}
