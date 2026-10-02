import { describe, expect, it, vi } from "vitest";
import { releaseAudioUrl } from "@/lib/client/audio-url";

function fakeAudio(src: string | null) {
  const attrs = new Map<string, string>(src === null ? [] : [["src", src]]);
  return {
    getAttribute: (name: string) => attrs.get(name) ?? null,
    removeAttribute: vi.fn((name: string) => void attrs.delete(name)),
    load: vi.fn(),
  };
}

describe("releaseAudioUrl", () => {
  it("detaches the element from the URL before revoking it", () => {
    const order: string[] = [];
    const audio = fakeAudio("blob:a");
    audio.load.mockImplementation(() => void order.push("load"));
    releaseAudioUrl(audio, "blob:a", () => order.push("revoke"));
    expect(audio.getAttribute("src")).toBeNull();
    expect(order).toEqual(["load", "revoke"]);
  });

  it("leaves an element that already moved on to another source alone", () => {
    const audio = fakeAudio("blob:next");
    const revoke = vi.fn();
    releaseAudioUrl(audio, "blob:old", revoke);
    expect(audio.getAttribute("src")).toBe("blob:next");
    expect(audio.load).not.toHaveBeenCalled();
    expect(revoke).toHaveBeenCalledWith("blob:old");
  });
});
