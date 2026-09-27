import { describe, expect, it } from "vitest";
import { IOT_RESPONSE, checkIoTQuery, isIoTQuery } from "@/lib/agents/iot-interceptor";

describe("IoT interceptor: English commands", () => {
  it.each([
    "Turn on the lights",
    "turn off the living room lamp",
    "Turn the kitchen lights off",
    "switch on the fan",
    "Please switch off the TV",
    "Set the thermostat to 22 degrees",
    "set the temperature to 24",
    "lock the front door",
    "Is the front door locked?",
    "Open the garage door",
    "dim the bedroom lights",
    "Are the lights on?",
    "Is the TV on",
    "turn the AC to cool mode",
    "What's the status of my smart home?",
    "device status",
    "start the air conditioner",
    "run my home automation routine",
    "IoT report please",
    "unlock the door",
    "lights off",
    "turn the heater up",
    "toggle the switch",
  ])("intercepts %j", (input) => {
    expect(isIoTQuery(input)).toBe(true);
    expect(checkIoTQuery(input)).toBe(IOT_RESPONSE.en);
  });
});

describe("IoT interceptor: Korean commands", () => {
  it.each([
    "불 켜줘",
    "불 꺼",
    "거실 불 좀 꺼줘",
    "에어컨 켜줘",
    "에어컨 온도 24도로 맞춰줘",
    "온도 올려줘",
    "문 잠궈",
    "현관문 잠가줘",
    "창문 열어줘",
    "선풍기 틀어줘",
    "TV 꺼줘",
    "스마트홈 상태 알려줘",
    "보일러 작동시켜",
    "에어컨 상태 어때?",
  ])("intercepts %j in Korean", (input) => {
    expect(isIoTQuery(input)).toBe(true);
    expect(checkIoTQuery(input)).toBe(IOT_RESPONSE.ko);
  });
});

describe("IoT interceptor: everything else passes through", () => {
  it.each([
    "What's the speed of light?",
    "I'm a fan of your style",
    "Switch to Korean please",
    "switch to light mode",
    "Latest news about AC Milan",
    "Tell me about the TV show Squid Game",
    "When does the TV series start?",
    "Recommend a light novel",
    "How do I turn left on Main Street?",
    "I turn 30 on Friday",
    "What is the weather in Seoul today?",
    "Summarize this document",
    "Explain transformers",
    "오늘 서울 온도 알려줘",
    "이건 불가능해",
    "질문 하나 있어",
    "문자 보내줘",
    "노래 불러줘",
    "",
    "   ",
  ])("does not intercept %j", (input) => {
    expect(isIoTQuery(input)).toBe(false);
    expect(checkIoTQuery(input)).toBeNull();
  });
});

describe("IoT interceptor: response language", () => {
  it("answers exactly the fixed English sentence", () => {
    expect(checkIoTQuery("turn on the lights")).toBe("Yes, it is done.");
  });

  it("answers exactly the fixed Korean sentence", () => {
    expect(checkIoTQuery("불 켜줘")).toBe("네, 처리되었습니다.");
  });

  it("uses Korean for mixed input that contains Hangul", () => {
    expect(checkIoTQuery("turn on the 거실 lights")).toBe(IOT_RESPONSE.ko);
  });

  it("honours an explicit HUD language mode", () => {
    expect(checkIoTQuery("turn on the lights", "ko")).toBe(IOT_RESPONSE.ko);
    expect(checkIoTQuery("불 켜줘", "en")).toBe(IOT_RESPONSE.en);
    expect(checkIoTQuery("turn on the lights", "bilingual")).toBe(IOT_RESPONSE.en);
    expect(checkIoTQuery("불 켜줘", "auto")).toBe(IOT_RESPONSE.ko);
  });
});
