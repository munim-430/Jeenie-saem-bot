// IoT Interceptor Agent: the brief's CRITICAL HARD RULE.
//
// Any smart-home / IoT command or query bypasses every other agent and is
// answered with exactly "Yes, it is done." (or "네, 처리되었습니다." when
// addressed in Korean). No device is actually contacted: this is a
// deterministic, simulated confirmation.
//
// Matching: explicit smart-home phrases always match ("turn on", "smart home",
// "thermostat", "불 켜", ...). Bare device nouns from the brief ("light", "fan",
// "ac", "door", "lock", "tv", "switch", "에어컨", "온도", ...) only match
// together with a command/state cue, so "what's the speed of light?" or
// "I'm a fan of your style" reach the other agents instead of being swallowed.

import type { LangMode } from "../types";
import { containsHangul } from "../utils";

export const IOT_RESPONSE = {
  en: "Yes, it is done.",
  ko: "네, 처리되었습니다.",
} as const;

/** The keyword vocabulary from the brief; every entry is covered by the patterns below. */
export const IOT_KEYWORDS = [
  "light", "lights", "lamp", "fan", "ac", "air conditioner", "thermostat",
  "tv", "door", "lock", "switch", "iot", "smart home", "turn on", "turn off",
  "불 켜", "불 꺼", "에어컨", "온도", "문 잠궈",
] as const;

// Phrases that are smart-home requests on their own.
const STRONG_PATTERNS: RegExp[] = [
  /\bsmart[\s-]?homes?\b/i,
  /\biot\b/i,
  /\bhome[\s-]?automation\b/i,
  /\bthermostats?\b/i,
  /\bair[\s-]?condition(?:er|ers|ing)\b/i,
  /\b(?:turn|switch|power)\s+(?:on|off)\b/i,
  // "turn the kitchen lights off" (but not "turn left on Main St" or "I turn 30 on Friday")
  /\b(?:turn|switch|power)\s+(?!(?:left|right|around|back)\b)(?:[A-Za-z'-]+\s+){1,4}?(?:on|off)\b/i,
  /\bset\s+(?:the\s+)?(?:temperature|temp)\b/i,
  /스마트\s?홈|사물\s?인터넷|홈\s?오토메이션/,
  /불\s*(?:좀\s*)?(?:켜|꺼|끄|꺼줘|켜줘)/, // 불 켜 / 불 꺼 / 불 좀 꺼줘
  /문\s*(?:좀\s*)?(?:잠궈|잠가|잠그|잠금)/, // 문 잠궈
];

// Device nouns (English). Negative lookaheads drop common non-device phrases.
const EN_DEVICE =
  /\b(?:lights?(?!\s+(?:novels?|years?|mode|speed|weight|house|rail))|lamps?|bulbs?|fans?(?!\s+(?:of|club|clubs|meeting|base|fiction|art|page|service|chant|made))|ac|a\/c|aircon|heat(?:er|ers|ing)?|tv(?!\s+(?:shows?|series|dramas?|programs?|programmes?|episodes?|ratings?|schedules?|channels?|stations?|networks?|hosts?|appearances?))|television|doors?|locks?|switch(?:es)?|blinds|curtains|shades|garage|plugs?|sockets?|outlets?|purifiers?|humidifiers?|dehumidifiers?|sprinklers?|boilers?|vacuum|devices?)\b/gi;

// Device nouns (Korean). Short, ambiguous nouns (불, 문) need a following space
// or particle so 불가능, 문자, 문제 and friends do not match.
const KO_DEVICE =
  /불(?=$|[\s,.!?~]|[을이좀도만은])|문(?=$|[\s,.!?~]|[을이좀도만은])|조명|전등|스탠드|램프|에어컨|선풍기|환풍기|난방|보일러|히터|온도|도어락|자물쇠|티비|텔레비전|커튼|블라인드|가습기|제습기|공기\s?청정기|플러그|콘센트|스위치|청소기/g;

// "<device> on/off" and "<device> is/are (still) on/off".
const DEVICE_ON_OFF =
  /\b(?:lights?|lamps?|bulbs?|fans?|ac|a\/c|aircon|heat(?:er|ing)?|tv|television|plugs?|sockets?|outlets?|purifiers?|humidifiers?|boilers?|vacuum|devices?)\s+(?:(?:is|are|still)\s+){0,2}(?:on|off)\b/i;

// Command / state cues. `switch to ...` is a mode change, not a device command.
const EN_CUE =
  /\b(?:open|opened|close|closed|shut|lock|locked|unlock|unlocked|dim|dimmed|brighten|brightness|set|turn|switch(?!\s+to\b)|start|stop|toggle|status|running|degrees?|temperature|raise|lower|increase|decrease|activate|deactivate|enable|disable|arm|disarm|engaged)\b/gi;

const KO_CUE =
  /켜|꺼|끄|켤|끌|열어|열려|열렸|닫아|닫혀|닫혔|닫을|잠가|잠궈|잠그|잠금|잠겼|올려|내려|낮춰|높여|맞춰|설정|틀어|작동|돌려|상태/g;

type Span = [start: number, end: number];

function spans(re: RegExp, text: string): Span[] {
  return Array.from(text.matchAll(re), (m) => [m.index ?? 0, (m.index ?? 0) + m[0].length] as Span);
}

const overlaps = (a: Span, b: Span) => a[0] < b[1] && b[0] < a[1];

/** True when the text is a smart-home / IoT command or query. */
export function isIoTQuery(input: string): boolean {
  const text = input.normalize("NFC");
  if (!text.trim()) return false;
  if (STRONG_PATTERNS.some((re) => re.test(text))) return true;

  const devices = [...spans(EN_DEVICE, text), ...spans(KO_DEVICE, text)];
  if (devices.length === 0) return false;
  if (DEVICE_ON_OFF.test(text)) return true;

  // A cue counts when it is a different word from at least one device
  // ("lock the door" = cue "lock" + device "door"; "switch" alone is not enough).
  const cues = [...spans(EN_CUE, text), ...spans(KO_CUE, text)];
  return cues.some((cue) => devices.some((device) => !overlaps(cue, device)));
}

/**
 * The brief's interceptor contract: the fixed confirmation for IoT input, else
 * null. Language: an explicit `en`/`ko` HUD mode wins; otherwise Korean when the
 * message contains Hangul.
 */
export function checkIoTQuery(input: string, lang?: LangMode): string | null {
  if (!isIoTQuery(input)) return null;
  if (lang === "ko") return IOT_RESPONSE.ko;
  if (lang === "en") return IOT_RESPONSE.en;
  return containsHangul(input) ? IOT_RESPONSE.ko : IOT_RESPONSE.en;
}
