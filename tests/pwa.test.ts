import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import { describe, expect, it } from "vitest";
import manifest from "@/app/manifest";

const root = fileURLToPath(new URL("..", import.meta.url));

/** Width and height from a PNG's IHDR chunk. */
function pngSize(path: string): [number, number] {
  const bytes = readFileSync(`${root}/public${path}`);
  expect(bytes.subarray(1, 4).toString("ascii")).toBe("PNG");
  return [bytes.readUInt32BE(16), bytes.readUInt32BE(20)];
}

interface SwGlobals {
  strategyFor: (url: URL, method: string, origin: string) => string | null;
  parseRange: (header: string, size: number) => { start: number; end: number } | null;
  rangeResponse: (cached: Response, header: string) => Promise<Response>;
  listeners: Record<string, unknown>;
}

/** Evaluate public/sw.js in a sandbox and expose its top-level functions. */
function loadServiceWorker(): SwGlobals {
  const listeners: Record<string, unknown> = {};
  const context = vm.createContext({
    self: {
      location: { origin: "https://jeannie.test" },
      addEventListener: (type: string, fn: unknown) => (listeners[type] = fn),
    },
    URL,
    Headers,
    Response,
    Set,
  });
  vm.runInContext(readFileSync(`${root}/public/sw.js`, "utf8"), context);
  return { ...(context as unknown as SwGlobals), listeners };
}

describe("web app manifest", () => {
  const m = manifest();

  it("is installable as a standalone portrait app", () => {
    expect(m).toMatchObject({ name: "Jeannie", short_name: "Jeannie", display: "standalone", orientation: "portrait", start_url: "/" });
    expect(m.theme_color).toMatch(/^#[0-9a-f]{6}$/i);
    expect(m.background_color).toMatch(/^#[0-9a-f]{6}$/i);
  });

  it("ships 192, 512 and maskable 512 icons that exist at their declared size", () => {
    const icons = m.icons ?? [];
    expect(icons.map((icon) => `${icon.sizes}:${icon.purpose}`)).toEqual(["192x192:any", "512x512:any", "512x512:maskable"]);
    for (const icon of icons) {
      const [w, h] = pngSize(icon.src);
      expect(`${w}x${h}`).toBe(icon.sizes);
    }
  });
});

describe("service worker", () => {
  const sw = loadServiceWorker();
  const origin = "https://jeannie.test";
  const strategy = (path: string, method = "GET", host = origin) => sw.strategyFor(new URL(path, host), method, origin);

  it("registers install, activate and fetch handlers", () => {
    expect(Object.keys(sw.listeners).sort()).toEqual(["activate", "fetch", "install"]);
  });

  it("routes requests by path", () => {
    expect(strategy("/api/chat")).toBe("network-only");
    expect(strategy("/api/greeting?awayMs=5")).toBe("network-only");
    expect(strategy("/avatar/idle.mp4")).toBe("cache-first");
    // Versioned clip URLs (CLIP_VERSION) stay cache-first; the query only changes the cache key.
    expect(strategy("/avatar/idle.mp4?v=k2")).toBe("cache-first");
    expect(strategy("/avatar/air_kiss.jpg")).toBe("cache-first");
    expect(strategy("/icons/icon-192.png")).toBe("cache-first");
    expect(strategy("/_next/static/chunks/main.js")).toBe("stale-while-revalidate");
    expect(strategy("/audio/beep.mp3")).toBeNull();
    expect(strategy("/avatar/nested/x.mp4")).toBeNull();
  });

  it("leaves non-GET and cross-origin requests alone", () => {
    expect(strategy("/avatar/idle.mp4", "POST")).toBeNull();
    expect(strategy("/avatar/idle.mp4", "GET", "https://cdn.example")).toBeNull();
  });

  it("parses single byte ranges", () => {
    expect(sw.parseRange("bytes=0-", 100)).toEqual({ start: 0, end: 99 });
    expect(sw.parseRange("bytes=10-19", 100)).toEqual({ start: 10, end: 19 });
    expect(sw.parseRange("bytes=90-500", 100)).toEqual({ start: 90, end: 99 });
    expect(sw.parseRange("bytes=-10", 100)).toEqual({ start: 90, end: 99 });
    expect(sw.parseRange("bytes=100-", 100)).toBeNull();
    expect(sw.parseRange("bytes=-", 100)).toBeNull();
    expect(sw.parseRange("bytes=0-1,5-6", 100)).toBeNull();
    expect(sw.parseRange("items=0-1", 100)).toBeNull();
  });

  it("slices a cached clip into a 206 partial response", async () => {
    const cached = new Response(new Uint8Array([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]), { headers: { "Content-Type": "video/mp4" } });
    const res = await sw.rangeResponse(cached, "bytes=2-4");
    expect(res.status).toBe(206);
    expect(res.headers.get("Content-Range")).toBe("bytes 2-4/10");
    expect(res.headers.get("Content-Length")).toBe("3");
    expect(res.headers.get("Content-Type")).toBe("video/mp4");
    expect([...new Uint8Array(await res.arrayBuffer())]).toEqual([2, 3, 4]);
  });

  it("answers an unsatisfiable range with 416", async () => {
    const res = await sw.rangeResponse(new Response(new Uint8Array(4)), "bytes=9-");
    expect(res.status).toBe(416);
    expect(res.headers.get("Content-Range")).toBe("bytes */4");
  });
});
