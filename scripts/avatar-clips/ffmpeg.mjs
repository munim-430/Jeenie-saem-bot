// Shared ffmpeg helpers for the avatar clip scripts (dev-time only).
// FFMPEG overrides the binary (default: `ffmpeg` on PATH).

import { spawnSync } from "node:child_process";
import { FPS, HEIGHT, WIDTH } from "./plan.mjs";

export const FFMPEG = process.env.FFMPEG || "ffmpeg";

export function run(cmd, args, opts = {}) {
  const res = spawnSync(cmd, args, { stdio: opts.quiet ? "pipe" : "inherit", encoding: "utf8", ...opts });
  if (res.status !== 0) {
    if (opts.quiet) process.stderr.write(res.stderr || res.stdout || "");
    throw new Error(`${cmd} ${args.slice(0, 3).join(" ")}... exited with ${res.status}`);
  }
  return res.stdout;
}

export const ffmpeg = (...args) => run(FFMPEG, ["-v", "error", "-y", ...args], { quiet: true });

/** Final web encode: 720x1280 cover, 24 fps, H.264 yuv420p, no audio, faststart. */
export function encode(input, output, { prefilter = "" } = {}) {
  ffmpeg(
    "-i", input, "-an",
    "-vf", `${prefilter}scale=${WIDTH}:${HEIGHT}:force_original_aspect_ratio=increase,crop=${WIDTH}:${HEIGHT},fps=${FPS},format=yuv420p`,
    "-c:v", "libx264", "-preset", "slow", "-crf", "23", "-profile:v", "high", "-pix_fmt", "yuv420p",
    "-movflags", "+faststart", output,
  );
}

export function poster(video, output) {
  ffmpeg("-i", video, "-frames:v", "1", "-q:v", "3", output);
}

/** Decoded frame count (no ffprobe needed). */
export function countFrames(file) {
  const res = spawnSync(FFMPEG, ["-v", "info", "-i", file, "-map", "0:v:0", "-f", "null", "-"], { encoding: "utf8" });
  const matches = [...(res.stderr || "").matchAll(/frame=\s*(\d+)/g)];
  if (res.status !== 0 || matches.length === 0) throw new Error(`could not count frames of ${file}`);
  return Number(matches.at(-1)[1]);
}
