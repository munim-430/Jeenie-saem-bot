import { describe, expect, it } from "vitest";
import { DEFAULT_CLIPS, clipNameFor, mergeClipManifest } from "@/lib/avatar/clips";
import {
  INITIAL_DIRECTOR,
  baseStateOf,
  cueOf,
  directorReducer,
  type DirectorEvent,
  type DirectorState,
} from "@/lib/avatar/director";
import {
  CHECK_IN_LINES,
  CHECK_IN_MS,
  FIRST_VARIATION_MS,
  VARIATION_MAX_MS,
  VARIATION_MIN_MS,
  holdIdle,
  idleStep,
  pickCheckIn,
  resetIdle,
} from "@/lib/avatar/idle";
import { awayMsFrom, isViewMode, resolveView } from "@/lib/avatar/view-mode";
import manifest from "../public/avatar/manifest.json";

const run = (events: DirectorEvent[], from: DirectorState = INITIAL_DIRECTOR) => events.reduce(directorReducer, from);

describe("avatar director", () => {
  it("loops idle by default", () => {
    expect(cueOf(INITIAL_DIRECTOR)).toEqual({ emote: "idle", key: "idle", loop: true, focus: false });
  });

  it("derives the base state: listening beats talking", () => {
    expect(baseStateOf({ listening: true, speaking: true })).toBe("listening");
    expect(baseStateOf({ listening: false, speaking: true })).toBe("talking");
    expect(baseStateOf({ listening: false, speaking: false })).toBe("idle");
  });

  it("plays a one-shot once, then returns to the base state", () => {
    const playing = run([{ type: "emote", emote: "greeting" }]);
    expect(cueOf(playing)).toMatchObject({ emote: "greeting", loop: false });
    const done = run([{ type: "ended", seq: playing.seq }], playing);
    expect(cueOf(done)).toMatchObject({ emote: "idle", loop: true });
  });

  it("hands a finished one-shot to talking while speech plays", () => {
    const state = run([
      { type: "emote", emote: "nod" },
      { type: "base", base: "talking" },
    ]);
    expect(cueOf(state).emote).toBe("nod");
    expect(cueOf(run([{ type: "ended", seq: state.seq }], state))).toMatchObject({ emote: "talking", loop: true });
  });

  it("queues one emote behind a playing one-shot, newest wins", () => {
    const state = run([
      { type: "emote", emote: "greeting" },
      { type: "emote", emote: "concern" },
      { type: "emote", emote: "air_kiss" },
    ]);
    expect(state.playing).toBe("greeting");
    expect(state.queued).toBe("air_kiss");
    const next = run([{ type: "ended", seq: state.seq }], state);
    expect(next.playing).toBe("air_kiss");
    expect(next.queued).toBeNull();
    expect(cueOf(next).key).not.toBe(cueOf(state).key);
  });

  it("restarts the clip for a repeat of the same emote", () => {
    const first = run([{ type: "emote", emote: "nod" }]);
    const second = run(
      [
        { type: "ended", seq: first.seq },
        { type: "emote", emote: "nod" },
      ],
      first,
    );
    expect(cueOf(second).key).not.toBe(cueOf(first).key);
  });

  it("ignores a stale ended event", () => {
    const first = run([{ type: "emote", emote: "nod" }]);
    const second = run(
      [
        { type: "ended", seq: first.seq },
        { type: "emote", emote: "sadness" },
      ],
      first,
    );
    expect(run([{ type: "ended", seq: first.seq }], second)).toBe(second);
  });

  it("listening cuts the one-shot and keeps the idle loop running under a focus", () => {
    const state = run([
      { type: "emote", emote: "greeting" },
      { type: "base", base: "listening" },
    ]);
    expect(state.playing).toBeNull();
    expect(cueOf(state)).toEqual({ emote: "listening", key: "idle", loop: true, focus: true });
  });

  it("holds emotes that arrive while listening until the mic is released", () => {
    const listening = run([
      { type: "base", base: "listening" },
      { type: "emote", emote: "concern" },
    ]);
    expect(listening.playing).toBeNull();
    expect(run([{ type: "base", base: "idle" }], listening).playing).toBe("concern");
  });

  it("idle variations never interrupt or queue", () => {
    expect(run([{ type: "vary", emote: "nod" }]).playing).toBe("nod");
    const busy = run([{ type: "emote", emote: "sadness" }]);
    expect(run([{ type: "vary", emote: "nod" }], busy)).toBe(busy);
    const talking = run([{ type: "base", base: "talking" }]);
    expect(run([{ type: "vary", emote: "nod" }], talking)).toBe(talking);
  });
});

describe("avatar clips", () => {
  it("listening reuses the idle clip", () => {
    expect(clipNameFor("listening")).toBe("idle");
    expect(clipNameFor("air_kiss")).toBe("air_kiss");
  });

  it("the static table agrees with the pipeline manifest on files and looping", () => {
    // Durations move whenever the pipeline re-cuts a clip; the manifest overrides them at runtime.
    const merged = mergeClipManifest(DEFAULT_CLIPS, manifest);
    for (const [name, clip] of Object.entries(merged)) {
      const base = DEFAULT_CLIPS[name as keyof typeof DEFAULT_CLIPS];
      expect({ name, src: clip.src, poster: clip.poster, loop: clip.loop }).toEqual({
        name,
        src: base.src,
        poster: base.poster,
        loop: base.loop,
      });
    }
  });

  it("merges valid manifest entries and ignores junk", () => {
    const merged = mergeClipManifest(DEFAULT_CLIPS, {
      nod: { src: "/avatar/nod.mp4", poster: "/avatar/nod.jpg", duration: 2.5, loop: false, placeholder: false },
      talking: { src: "https://evil.example/x.mp4", poster: "", duration: 1, loop: true },
      listening: { src: "/x.mp4", poster: "/x.jpg", duration: 1, loop: true },
      unknown: { src: "/x.mp4", poster: "/x.jpg", duration: 1, loop: true },
      idle: { src: "/avatar/idle.mp4", poster: "/avatar/idle.jpg", duration: -1, loop: true },
    });
    expect(merged.nod).toMatchObject({ duration: 2.5, placeholder: false });
    expect(merged.talking).toEqual(DEFAULT_CLIPS.talking);
    expect(merged.idle).toEqual(DEFAULT_CLIPS.idle);
    expect(mergeClipManifest(DEFAULT_CLIPS, null)).toBe(DEFAULT_CLIPS);
  });
});

describe("idle watch", () => {
  const t0 = 1_000_000;
  const mid = () => 0.5;

  it("first variation after 30 s, then every 30–60 s", () => {
    let state = resetIdle(t0);
    expect(idleStep(state, t0 + FIRST_VARIATION_MS - 1).action).toBeNull();
    const first = idleStep(state, t0 + FIRST_VARIATION_MS, mid);
    expect(first.action).toBe("variation");
    state = first.state;
    const gap = state.nextVariationAt - (t0 + FIRST_VARIATION_MS);
    expect(gap).toBeGreaterThanOrEqual(VARIATION_MIN_MS);
    expect(gap).toBeLessThanOrEqual(VARIATION_MAX_MS);
    expect(idleStep(state, t0 + FIRST_VARIATION_MS + 1).action).toBeNull();
  });

  it("checks in once after ~3 min, until the user interacts", () => {
    let state = resetIdle(t0);
    const checkIn = idleStep(state, t0 + CHECK_IN_MS, mid);
    expect(checkIn.action).toBe("check-in");
    state = checkIn.state;
    // Her own speech holds the silence but does not re-arm the check-in.
    state = holdIdle(state, t0 + CHECK_IN_MS + 5_000);
    expect(idleStep(state, t0 + CHECK_IN_MS * 3, mid).action).toBe("variation");
    // The user interacts: armed again.
    state = resetIdle(t0 + CHECK_IN_MS * 3);
    expect(idleStep(state, t0 + CHECK_IN_MS * 4, mid).action).toBe("check-in");
  });

  it("picks a Korean check-in line", () => {
    expect(CHECK_IN_LINES).toContain(pickCheckIn(() => 0));
    expect(CHECK_IN_LINES).toContain(pickCheckIn(() => 0.999999));
    expect(pickCheckIn(() => 0.99)).toMatch(/부장님|자기야/);
  });
});

describe("view mode", () => {
  it("defaults to the avatar on phones, the HUD elsewhere, unless overridden", () => {
    expect(resolveView(null, true)).toBe("avatar");
    expect(resolveView(null, false)).toBe("hud");
    expect(resolveView("hud", true)).toBe("hud");
    expect(resolveView("avatar", false)).toBe("avatar");
    expect(isViewMode("avatar")).toBe(true);
    expect(isViewMode("desktop")).toBe(false);
  });

  it("computes how long the user was away", () => {
    expect(awayMsFrom(null, 5000)).toBeUndefined();
    expect(awayMsFrom("garbage", 5000)).toBeUndefined();
    expect(awayMsFrom("9000", 5000)).toBeUndefined();
    expect(awayMsFrom("1000", 5000)).toBe(4000);
  });
});
