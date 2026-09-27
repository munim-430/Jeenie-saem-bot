import { describe, expect, it } from "vitest";
import {
  containsHangul,
  dataUrlByteLength,
  decodeHeaderJson,
  detectLanguage,
  encodeHeaderJson,
  isImageDataUrl,
  resolveLanguage,
  stripMarkdownForSpeech,
  timingSafeEqual,
  truncate,
} from "@/lib/utils";

describe("language detection", () => {
  it("detects Korean and English", () => {
    expect(detectLanguage("안녕하세요, 오늘 일정 알려줘")).toBe("ko");
    expect(detectLanguage("What's on my calendar today?")).toBe("en");
    expect(detectLanguage("")).toBe("en");
  });

  it("weighs mixed text by content", () => {
    expect(detectLanguage("Jennie 노래 추천해줘")).toBe("ko");
    expect(detectLanguage("Can you explain the word 사랑 in a long English sentence?")).toBe("en");
  });

  it("containsHangul sees jamo and syllables", () => {
    expect(containsHangul("ㅋㅋ")).toBe(true);
    expect(containsHangul("hello")).toBe(false);
  });

  it("resolves HUD language modes", () => {
    expect(resolveLanguage("en", "안녕")).toBe("en");
    expect(resolveLanguage("ko", "hello")).toBe("ko");
    expect(resolveLanguage("bilingual", "hello")).toBe("bilingual");
    expect(resolveLanguage("auto", "안녕하세요")).toBe("ko");
    expect(resolveLanguage(undefined, "hello")).toBe("en");
    expect(resolveLanguage("auto", "Answer bilingually: what is kimchi?")).toBe("bilingual");
    expect(resolveLanguage("auto", "영어와 한국어로 설명해줘")).toBe("bilingual");
  });
});

describe("header JSON encoding", () => {
  it("round-trips non-ASCII values as ASCII", () => {
    const value = [{ title: "서울 날씨 · Seoul weather", url: "https://example.com/?q=서울" }];
    const encoded = encodeHeaderJson(value);
    expect(encoded).toMatch(/^[A-Za-z0-9+/=]+$/);
    expect(decodeHeaderJson(encoded)).toEqual(value);
  });

  it("returns null for missing or garbage input", () => {
    expect(decodeHeaderJson(null)).toBeNull();
    expect(decodeHeaderJson("%%%")).toBeNull();
  });
});

describe("helpers", () => {
  it("truncate adds an ellipsis only when needed", () => {
    expect(truncate("short", 10)).toBe("short");
    expect(truncate("a long sentence here", 8)).toBe("a long…");
  });

  it("timingSafeEqual compares exactly", () => {
    expect(timingSafeEqual("secret", "secret")).toBe(true);
    expect(timingSafeEqual("secret", "secreT")).toBe(false);
    expect(timingSafeEqual("secret", "secret2")).toBe(false);
    expect(timingSafeEqual("", "")).toBe(true);
  });

  it("stripMarkdownForSpeech removes markup and URLs", () => {
    const md = "## Briefing\n- **Seoul**: 21°C [source](https://x.com)\n```js\ncode()\n```\nSee https://example.com";
    expect(stripMarkdownForSpeech(md)).toBe("Briefing Seoul: 21°C source See");
  });

  it("validates image data URLs", () => {
    expect(isImageDataUrl("data:image/png;base64,iVBORw0KGgo=")).toBe(true);
    expect(isImageDataUrl("data:text/html;base64,PGgxPg==")).toBe(false);
    expect(isImageDataUrl("https://example.com/cat.png")).toBe(false);
    expect(dataUrlByteLength("data:image/png;base64,AAAA")).toBe(3);
  });
});
