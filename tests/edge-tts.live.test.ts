// Real synthesis against speech.platform.bing.com. Opt-in:
//   LIVE_EDGE_TTS=1 npx vitest run tests/edge-tts.live.test.ts
// Optional: LIVE_EDGE_TTS_OUT=<dir> saves tts-sample-en.mp3 / tts-sample-ko.mp3 there.

import { writeFileSync } from "node:fs";
import http from "node:http";
import https from "node:https";
import { join } from "node:path";
import type { Duplex } from "node:stream";
import tls from "node:tls";
import { describe, expect, it } from "vitest";
import { synthesizeEdgeTts } from "@/lib/agents/edge-tts";

type ConnectCallback = (error: Error | null, socket?: Duplex) => void;

/**
 * `ws` ignores HTTPS_PROXY. When egress goes through an HTTP CONNECT proxy
 * (CI sandboxes), tunnel the WebSocket's TLS connection through it.
 */
class ConnectTunnelAgent extends https.Agent {
  constructor(private readonly proxy: URL) {
    super({ keepAlive: false });
  }

  // Node's Agent accepts an async createConnection that reports through the callback.
  createConnection(options: tls.ConnectionOptions & { host?: string; port?: number }, callback: ConnectCallback) {
    const target = `${options.host}:${options.port ?? 443}`;
    const request = http.request({
      host: this.proxy.hostname,
      port: Number(this.proxy.port || 80),
      method: "CONNECT",
      path: target,
      headers: { host: target },
    });
    request.once("connect", (response, socket) => {
      if (response.statusCode !== 200) {
        socket.destroy();
        callback(new Error(`Proxy CONNECT failed with HTTP ${response.statusCode}`));
        return;
      }
      callback(null, tls.connect({ socket, servername: options.servername ?? options.host, ALPNProtocols: ["http/1.1"] }));
    });
    request.once("error", (error) => callback(error));
    request.end();
    return undefined;
  }
}

function proxyAgent(): https.Agent | undefined {
  const proxy = process.env.HTTPS_PROXY ?? process.env.https_proxy;
  return proxy ? new ConnectTunnelAgent(new URL(proxy)) : undefined;
}

function looksLikeMp3(bytes: Uint8Array): boolean {
  const id3 = bytes[0] === 0x49 && bytes[1] === 0x44 && bytes[2] === 0x33; // "ID3"
  const frameSync = bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0;
  return id3 || frameSync;
}

function save(name: string, bytes: Uint8Array) {
  const dir = process.env.LIVE_EDGE_TTS_OUT;
  if (dir) writeFileSync(join(dir, name), bytes);
}

describe.skipIf(!process.env.LIVE_EDGE_TTS)("Edge TTS (live)", () => {
  const agent = proxyAgent();

  it("speaks English with JennyNeural", async () => {
    const audio = await synthesizeEdgeTts({
      text: "Good evening. All systems are online, and I'm standing by for your next command.",
      voice: "en-US-JennyNeural",
      agent,
    });
    expect(audio.byteLength).toBeGreaterThan(2048);
    expect(looksLikeMp3(audio)).toBe(true);
    save("tts-sample-en.mp3", audio);
  }, 30_000);

  it("speaks Korean with SunHiNeural", async () => {
    const audio = await synthesizeEdgeTts({
      text: "안녕하세요. 모든 시스템이 정상적으로 작동하고 있어요. 다음 명령을 기다리고 있을게요.",
      voice: "ko-KR-SunHiNeural",
      agent,
    });
    expect(audio.byteLength).toBeGreaterThan(2048);
    expect(looksLikeMp3(audio)).toBe(true);
    save("tts-sample-ko.mp3", audio);
  }, 30_000);
});
