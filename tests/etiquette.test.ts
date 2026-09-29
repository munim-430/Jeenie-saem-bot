import { describe, expect, it } from "vitest";
import {
  ENCOURAGEMENTS,
  HONORIFICS,
  honorificDirective,
  koreanGreetingForHour,
  localClock,
  pickHonorific,
  pickWeighted,
  sessionGreeting,
} from "@/lib/agents/etiquette";

/** Deterministic PRNG (mulberry32) for the distribution check. */
function seeded(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe("pickWeighted", () => {
  it("lays the options out on a cumulative scale", () => {
    const options = [
      { value: "a", weight: 0.6 },
      { value: "b", weight: 0.1 },
      { value: "c", weight: 0.3 },
    ];
    expect(pickWeighted(options, () => 0)).toBe("a");
    expect(pickWeighted(options, () => 0.5999)).toBe("a");
    expect(pickWeighted(options, () => 0.6)).toBe("b");
    expect(pickWeighted(options, () => 0.6999)).toBe("b");
    expect(pickWeighted(options, () => 0.7)).toBe("c");
    expect(pickWeighted(options, () => 0.9999999)).toBe("c");
  });

  it("normalizes weights that do not sum to 1 and skips zero weights", () => {
    const options = [
      { value: "x", weight: 3 },
      { value: "never", weight: 0 },
      { value: "y", weight: 1 },
    ];
    expect(pickWeighted(options, () => 0.74)).toBe("x");
    expect(pickWeighted(options, () => 0.75)).toBe("y");
    expect(pickWeighted(options, () => 1)).toBe("y"); // out-of-range draw is clamped
  });

  it("rejects empty, negative and all-zero weights", () => {
    expect(() => pickWeighted([])).toThrow(RangeError);
    expect(() => pickWeighted([{ value: 1, weight: -1 }])).toThrow(RangeError);
    expect(() => pickWeighted([{ value: 1, weight: 0 }])).toThrow(RangeError);
    expect(() => pickWeighted([{ value: 1, weight: Number.NaN }])).toThrow(RangeError);
  });
});

describe("honorifics", () => {
  it("weights 부장님 60%, 사장님 10%, sir 30%", () => {
    expect(HONORIFICS).toEqual([
      { value: "부장님", weight: 0.6 },
      { value: "사장님", weight: 0.1 },
      { value: "sir", weight: 0.3 },
    ]);
    expect(pickHonorific(() => 0.3)).toBe("부장님");
    expect(pickHonorific(() => 0.65)).toBe("사장님");
    expect(pickHonorific(() => 0.95)).toBe("sir");
  });

  it("produces the 60/10/30 split over many replies", () => {
    const rng = seeded(42);
    const counts = { 부장님: 0, 사장님: 0, sir: 0 };
    const n = 10_000;
    for (let i = 0; i < n; i++) counts[pickHonorific(rng)]++;
    expect(counts.부장님 / n).toBeCloseTo(0.6, 1);
    expect(Math.abs(counts.부장님 / n - 0.6)).toBeLessThan(0.02);
    expect(Math.abs(counts.사장님 / n - 0.1)).toBeLessThan(0.02);
    expect(Math.abs(counts.sir / n - 0.3)).toBeLessThan(0.02);
  });

  it("tells the model to use exactly that title", () => {
    expect(honorificDirective("부장님")).toContain('"부장님"');
    expect(honorificDirective("sir")).toContain("Understood, sir.");
    expect(honorificDirective("사장님")).toMatch(/Do not use any other title/);
  });
});

describe("Korean session greeting", () => {
  it.each([
    [5, "좋은 아침입니다"],
    [11, "좋은 아침입니다"],
    [12, "좋은 오후입니다"],
    [17, "좋은 오후입니다"],
    [18, "좋은 저녁입니다"],
    [21, "좋은 저녁입니다"],
    [22, "늦은 시간까지 수고 많으십니다"],
    [0, "늦은 시간까지 수고 많으십니다"],
    [4, "늦은 시간까지 수고 많으십니다"],
  ])("hour %i → %s", (hour, expected) => {
    expect(koreanGreetingForHour(hour)).toBe(expected);
  });

  it("reads the hour in the operator's time zone", () => {
    const utc0230 = new Date("2026-09-28T02:30:00Z");
    expect(localClock(utc0230, "Asia/Dhaka")).toEqual({ hour: 8, time: "08:30" }); // UTC+6
    expect(localClock(utc0230, "Asia/Seoul")).toEqual({ hour: 11, time: "11:30" }); // UTC+9
    expect(localClock(utc0230, "UTC")).toEqual({ hour: 2, time: "02:30" });
    expect(localClock(new Date("2026-09-28T18:00:00Z"), "Asia/Dhaka").hour).toBe(0); // midnight, not 24
  });

  it("builds greeting, honorific and encouragement", () => {
    const evening = new Date("2026-09-28T13:05:00Z"); // 19:05 in Dhaka
    const result = sessionGreeting({ now: evening, timeZone: "Asia/Dhaka", honorific: "부장님", rng: () => 0 });
    expect(result).toEqual({
      greeting: `좋은 저녁입니다, 부장님. ${ENCOURAGEMENTS[0]}`,
      honorific: "부장님",
      localTime: "19:05",
      timeZone: "Asia/Dhaka",
    });
  });

  it("draws the honorific with the same weighting when none is given", () => {
    const morning = new Date("2026-09-28T01:00:00Z"); // 07:00 in Dhaka
    const result = sessionGreeting({ now: morning, timeZone: "Asia/Dhaka", rng: () => 0.95 });
    expect(result.honorific).toBe("sir");
    expect(result.greeting.startsWith("좋은 아침입니다, sir. ")).toBe(true);
    expect(ENCOURAGEMENTS).toContain(result.greeting.split("sir. ")[1]);
  });
});
