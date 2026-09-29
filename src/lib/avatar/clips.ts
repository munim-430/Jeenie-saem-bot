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

/** Emotes that have their own clip file ("listening" reuses idle). */
export type ClipName = Exclude<Emote, "listening">;

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
  idle: clip("idle", 5, true, false),
  greeting: clip("greeting", 5.167, false, false),
  air_kiss: clip("air_kiss", 5.167, false, false),
  talking: clip("talking", 5.167, true, false),
  concern: clip("concern", 6.042, false, false),
  sadness: clip("sadness", 7.042, false, false),
  nod: clip("nod", 5.167, false, false),
};

export const CLIP_NAMES = EMOTES.filter((e): e is ClipName => e !== "listening");

/** The clip file an emote plays: "listening" is idle plus a CSS focus. */
export function clipNameFor(emote: Emote): ClipName {
  return emote === "listening" ? "idle" : emote;
}

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
    if (!isEmote(name) || name === "listening" || !isClipInfo(entry)) continue;
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
