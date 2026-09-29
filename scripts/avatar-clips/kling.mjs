// Which accepted Kling clips go live, and under which app emote name (pure; unit-tested).

/** clips.json id -> app emote name. Ids not listed here are not shipped. */
export const KLING_NAMES = {
  idle_neutral: "idle",
  speaking: "talking",
  listening: "listening",
  sway: "sway",
  sway_2: "excited",
  peek: "peek",
  spin: "spin",
  curiosity: "curiosity",
  shyness: "shyness",
  excitement: "excitement",
  love: "love",
  stress: "stress",
  sadness: "sadness",
  frustration: "frustration",
  concern: "concern",
  supportive: "supportive",
  heartbeat: "heartbeat",
};

/** Clips the player loops while their state lasts (sway is a one-shot idle variation). */
const LOOPS = new Set(["idle", "talking", "listening"]);

/**
 * @param {{ clips: { id: string, file: string | null, verdict: string }[] }} clipsJson
 * @returns {{ name: string, file: string, loop: boolean }[]}
 */
export function ingestPlan(clipsJson) {
  return clipsJson.clips
    .filter((c) => c.verdict === "accept" && typeof c.file === "string" && c.id in KLING_NAMES)
    .map((c) => ({ name: KLING_NAMES[c.id], file: c.file, loop: LOOPS.has(KLING_NAMES[c.id]) }));
}
