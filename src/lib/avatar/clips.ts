// Avatar clip table. Mirrors public/avatar/manifest.json (written by the clip
// pipeline) so the player works before, or without, fetching the manifest.

import { EMOTES, isEmote, type Emote } from "@/lib/emote";

export interface ClipInfo {
  src: string;
  poster: string;
  /** Seconds. */
  duration: number;
  loop: boolean;
  /** Built from frame sheets until the generated clip lands. */
  placeholder: boolean;
}

/** Every emote has its own clip file. */
export type ClipName = Emote;

export type ClipTable = Record<ClipName, ClipInfo>;

export const CLIP_MANIFEST_URL = "/avatar/manifest.json";

/** Page backdrop behind the clips, sampled from the clip background (top edge / floor). */
export const AVATAR_BACKDROP = "#dbc7c7";
export const AVATAR_FLOOR = "#f3e3e3";

const clip = (name: ClipName, duration: number, loop: boolean, placeholder: boolean): ClipInfo => ({
  src: `/avatar/${name}.mp4`,
  poster: `/avatar/${name}.jpg`,
  duration,
  loop,
  placeholder,
});

export const DEFAULT_CLIPS: ClipTable = {
  idle: clip("idle", 6.042, true, false),
  listening: clip("listening", 8.042, true, false),
  talking: clip("talking", 8.042, true, false),
  sway: clip("sway", 8.042, false, false),
  greeting: clip("greeting", 5.167, false, false),
  air_kiss: clip("air_kiss", 5.167, false, false),
  nod: clip("nod", 5.167, false, false),
  supportive: clip("supportive", 6.042, false, false),
  concern: clip("concern", 6.042, false, false),
  sadness: clip("sadness", 7.042, false, false),
  love: clip("love", 6.042, false, false),
  heartbeat: clip("heartbeat", 6.042, false, false),
  shyness: clip("shyness", 6.042, false, false),
  curiosity: clip("curiosity", 5.042, false, false),
  excitement: clip("excitement", 6.042, false, false),
  excited: clip("excited", 6.042, false, false),
  stress: clip("stress", 6.042, false, false),
  frustration: clip("frustration", 6.042, false, false),
  peek: clip("peek", 6.042, false, false),
  spin: clip("spin", 8.042, false, false),
};

export const CLIP_NAMES: readonly ClipName[] = EMOTES;

/** Fetched first on load: every state the player can enter before a reply arrives. */
export const ESSENTIAL_CLIPS: readonly ClipName[] = ["idle", "greeting", "listening", "talking"];

function isClipInfo(value: unknown): value is ClipInfo {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.src === "string" &&
    v.src.startsWith("/") &&
    typeof v.poster === "string" &&
    typeof v.duration === "number" &&
    Number.isFinite(v.duration) &&
    v.duration > 0 &&
    typeof v.loop === "boolean"
  );
}

/** Overlays valid manifest entries on `base`; anything malformed keeps the static entry. */
export function mergeClipManifest(base: ClipTable, manifest: unknown): ClipTable {
  if (!manifest || typeof manifest !== "object") return base;
  const next: ClipTable = { ...base };
  for (const [name, entry] of Object.entries(manifest as Record<string, unknown>)) {
    if (!isEmote(name) || !isClipInfo(entry)) continue;
    next[name] = {
      src: entry.src,
      poster: entry.poster,
      duration: entry.duration,
      loop: entry.loop,
      placeholder: Boolean((entry as { placeholder?: unknown }).placeholder),
    };
  }
  return next;
}
