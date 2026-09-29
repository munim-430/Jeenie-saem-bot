// Emote protocol shared by the server persona and the avatar player.
//
// Every reply opens with one tag such as `[emote:concern]`. The avatar plays
// that clip; the tag is stripped before the text is shown, spoken or sent to
// Telegram. Replies without a tag fall back to "talking".

export const EMOTES = ["idle", "greeting", "air_kiss", "talking", "listening", "concern", "sadness", "nod"] as const;

export type Emote = (typeof EMOTES)[number];

/** Emotes the model may choose for a reply. idle/listening/talking are driven by the app itself. */
export const REPLY_EMOTES = ["greeting", "air_kiss", "concern", "sadness", "nod"] as const satisfies readonly Emote[];

export type ReplyEmote = (typeof REPLY_EMOTES)[number];

export function isEmote(value: unknown): value is Emote {
  return typeof value === "string" && (EMOTES as readonly string[]).includes(value);
}

export function isReplyEmote(value: unknown): value is ReplyEmote {
  return typeof value === "string" && (REPLY_EMOTES as readonly string[]).includes(value);
}

// Tolerant of what models actually write: `[emote: nod]`, `[Emote:air-kiss]`, `[emote:air kiss]`.
const LEADING_TAG = /^\s*\[\s*emote\s*:\s*([a-z_ -]*?)\s*\]\s*/i;
// A whole tag anywhere, or an unterminated one at the very end (still streaming in).
const ANY_TAG = /\[\s*emote\s*:[^\]\n]{0,24}(?:\]|$)\s*/gi;

const normalizeName = (name: string) => name.trim().toLowerCase().replace(/[\s-]+/g, "_");

/**
 * Split a (possibly still streaming) reply into its emote and display text.
 * `pending` is true while the text could still be the start of a tag, so the
 * caller can hold back rendering the first few characters. Pass `final` once
 * the text is complete: nothing is held back then.
 */
export function parseEmote(
  text: string,
  options: { final?: boolean } = {},
): { emote: ReplyEmote | null; text: string; pending: boolean } {
  const match = LEADING_TAG.exec(text);
  if (match) {
    const name = normalizeName(match[1]!);
    return {
      emote: isReplyEmote(name) ? name : null,
      text: text.slice(match[0].length).replace(ANY_TAG, ""),
      pending: false,
    };
  }
  const head = text.trimStart();
  const compact = head.replace(/\s+/g, "").slice(0, 7).toLowerCase();
  const pending = !options.final && head.length < 32 && "[emote:".startsWith(compact) && !head.includes("]");
  return { emote: null, text: pending ? "" : text.replace(ANY_TAG, ""), pending };
}

/** Remove every emote tag from finished text (for TTS, Telegram, memory). */
export function stripEmotes(text: string): string {
  return parseEmote(text, { final: true }).text;
}

/** System-prompt line teaching the model the protocol. */
export const EMOTE_DIRECTIVE = `Begin every reply with exactly one emote tag chosen from: ${REPLY_EMOTES.map((e) => `[emote:${e}]`).join(", ")}.
Pick the one that matches your feeling: greeting when welcoming the user, air_kiss for affection or a warm goodbye, concern when the user is stressed, tired, unwell or facing a problem, sadness for bad news or when you missed the user, nod when agreeing, confirming or acknowledging.
The tag is invisible to the user; never mention it and never use it anywhere else in the reply.`;
