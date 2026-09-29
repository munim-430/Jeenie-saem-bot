// Avatar clip state machine. The base state follows the app (idle, listening
// while the mic is held, talking while speech plays); one-shot emotes play once
// over it and hand back. At most one emote waits behind the one playing.

import type { Emote, ReplyEmote } from "@/lib/emote";

export type BaseState = "idle" | "listening" | "talking";

export interface DirectorState {
  base: BaseState;
  /** One-shot emote currently playing. */
  playing: ReplyEmote | null;
  /** Next one-shot, played when `playing` ends (queue of one: newer replaces older). */
  queued: ReplyEmote | null;
  /** Bumped every time a one-shot starts, so a repeat of the same emote restarts the clip. */
  seq: number;
}

export type DirectorEvent =
  | { type: "base"; base: BaseState }
  /** A reply / greeting / check-in emote. */
  | { type: "emote"; emote: ReplyEmote }
  /** An idle variation: only when nothing else is happening, never queued. */
  | { type: "vary"; emote: ReplyEmote }
  /** The one-shot started as `seq` finished (stale ends are ignored). */
  | { type: "ended"; seq: number };

export const INITIAL_DIRECTOR: DirectorState = { base: "idle", playing: null, queued: null, seq: 0 };

export function baseStateOf(flags: { listening: boolean; speaking: boolean }): BaseState {
  return flags.listening ? "listening" : flags.speaking ? "talking" : "idle";
}

const start = (state: DirectorState, emote: ReplyEmote | null): DirectorState =>
  emote ? { ...state, playing: emote, queued: null, seq: state.seq + 1 } : { ...state, playing: null, queued: null };

export function directorReducer(state: DirectorState, event: DirectorEvent): DirectorState {
  switch (event.type) {
    case "base": {
      if (event.base === state.base) return state;
      // Holding the mic cuts any emote: she is listening now.
      if (event.base === "listening") return { ...state, base: "listening", playing: null, queued: null };
      const next = { ...state, base: event.base };
      // Emotes that arrived while listening play once the mic is released.
      return state.base === "listening" && state.queued ? start(next, state.queued) : next;
    }
    case "emote":
      if (state.base === "listening" || state.playing) return { ...state, queued: event.emote };
      return start(state, event.emote);
    case "vary":
      if (state.base !== "idle" || state.playing || state.queued) return state;
      return start(state, event.emote);
    case "ended":
      if (!state.playing || event.seq !== state.seq) return state;
      return start(state, state.queued);
  }
}

export interface ClipCue {
  emote: Emote;
  /** Changes whenever the player must (re)start a clip. */
  key: string;
  loop: boolean;
  /** Listening: idle clip with the CSS focus treatment. */
  focus: boolean;
}

/** What the stage should show for a state. Listening shares idle's key so the loop is not restarted. */
export function cueOf(state: DirectorState): ClipCue {
  const focus = state.base === "listening";
  if (state.playing) return { emote: state.playing, key: `${state.playing}#${state.seq}`, loop: false, focus };
  const emote: Emote = state.base === "talking" ? "talking" : state.base;
  return { emote, key: state.base === "talking" ? "talking" : "idle", loop: true, focus };
}
