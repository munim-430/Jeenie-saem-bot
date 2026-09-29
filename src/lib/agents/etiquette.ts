// Etiquette: how Jeannie addresses her operator, and how she opens a session.
// Deterministic helpers (the random source is injectable) so the weighting and
// the time-of-day greeting are unit-tested rather than left to the model.
// Runs on Edge and Node.js.

import type { Honorific } from "../types";

export interface Weighted<T> {
  value: T;
  weight: number;
}

/**
 * Picks one option with probability proportional to its weight, from a single
 * uniform draw `rng()` in [0, 1). Options are laid out on a cumulative scale in
 * order, so with weights 0.6 / 0.1 / 0.3 a draw below 0.6 gives the first,
 * below 0.7 the second, and anything else the third.
 */
export function pickWeighted<T>(options: readonly Weighted<T>[], rng: () => number = Math.random): T {
  if (options.length === 0) throw new RangeError("pickWeighted needs at least one option");
  let total = 0;
  for (const option of options) {
    if (!Number.isFinite(option.weight) || option.weight < 0) {
      throw new RangeError(`invalid weight ${option.weight}`);
    }
    total += option.weight;
  }
  if (total <= 0) throw new RangeError("weights must sum to a positive number");

  const draw = Math.min(Math.max(rng(), 0), 1 - Number.EPSILON) * total;
  let cumulative = 0;
  for (const option of options) {
    cumulative += option.weight;
    if (draw < cumulative) return option.value;
  }
  // Float rounding can leave the draw a hair above the last boundary.
  return options.findLast((o) => o.weight > 0)!.value;
}

/** 60% 부장님, 10% 사장님, 30% sir. */
export const HONORIFICS: readonly Weighted<Honorific>[] = [
  { value: "부장님", weight: 0.6 },
  { value: "사장님", weight: 0.1 },
  { value: "sir", weight: 0.3 },
];

export function pickHonorific(rng: () => number = Math.random): Honorific {
  return pickWeighted(HONORIFICS, rng);
}

/** System-prompt line that pins the title for one reply. */
export function honorificDirective(honorific: Honorific): string {
  const example = honorific === "sir" ? "\"Understood, sir.\" / \"네, sir.\"" : `"네, ${honorific}." / "Understood, ${honorific}."`;
  return `Address the user as "${honorific}" in this reply (for example ${example}). Use it once or twice, naturally, in whichever language you answer in. Do not use any other title or honorific for the user.`;
}

// ─── Session greeting ───────────────────────────────────────────────────────

/** Hour (0-23) and "HH:MM" in `timeZone`. */
export function localClock(date: Date, timeZone: string): { hour: number; time: string } {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  const hour = Number(parts.find((p) => p.type === "hour")?.value ?? "0") % 24;
  const minute = parts.find((p) => p.type === "minute")?.value ?? "00";
  return { hour, time: `${String(hour).padStart(2, "0")}:${minute}` };
}

/** Korean greeting for a local hour: morning 05-11, afternoon 12-17, evening 18-21, late night 22-04. */
export function koreanGreetingForHour(hour: number): string {
  if (hour >= 5 && hour < 12) return "좋은 아침입니다";
  if (hour >= 12 && hour < 18) return "좋은 오후입니다";
  if (hour >= 18 && hour < 22) return "좋은 저녁입니다";
  return "늦은 시간까지 수고 많으십니다";
}

export const ENCOURAGEMENTS: readonly string[] = [
  "오늘도 멋지게 해내실 거예요.",
  "필요하신 건 무엇이든 말씀만 하세요. 제가 곁에서 돕겠습니다.",
  "지금까지 잘해 오셨어요. 오늘도 한 걸음씩 함께 가요.",
  "어떤 일이든 차분하게 하나씩 정리해 드릴게요.",
  "좋은 결과가 기다리고 있을 거예요. 힘내세요!",
];

export interface GreetingOptions {
  now?: Date;
  timeZone: string;
  honorific?: Honorific;
  rng?: () => number;
}

/** "좋은 아침입니다, 부장님. 오늘도 멋지게 해내실 거예요." plus the facts it was built from. */
export function sessionGreeting(options: GreetingOptions): {
  greeting: string;
  honorific: Honorific;
  localTime: string;
  timeZone: string;
} {
  const rng = options.rng ?? Math.random;
  const honorific = options.honorific ?? pickHonorific(rng);
  const { hour, time } = localClock(options.now ?? new Date(), options.timeZone);
  const index = Math.min(Math.floor(rng() * ENCOURAGEMENTS.length), ENCOURAGEMENTS.length - 1);
  const greeting = `${koreanGreetingForHour(hour)}, ${honorific}. ${ENCOURAGEMENTS[index]}`;
  return { greeting, honorific, localTime: time, timeZone: options.timeZone };
}
