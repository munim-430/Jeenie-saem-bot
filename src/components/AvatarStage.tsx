"use client";

import { useEffect, useRef, useState, type SyntheticEvent } from "react";
import {
  AVATAR_BACKDROP,
  AVATAR_FLOOR,
  CLIP_NAMES,
  DEFAULT_CLIPS,
  clipNameFor,
  type ClipTable,
} from "@/lib/avatar/clips";
import type { ClipCue } from "@/lib/avatar/director";
import { cn } from "@/lib/utils";

// Two stacked muted videos: the next clip starts on the hidden one and fades in
// over the current one (~150 ms), so cuts between clips never flash.
const FADE_MS = 150;

interface AvatarStageProps {
  cue: ClipCue;
  clips: ClipTable;
  /** The current one-shot clip finished. */
  onEnded: () => void;
  className?: string;
}

export function AvatarStage({ cue, clips, onEnded, className }: AvatarStageProps) {
  const videoA = useRef<HTMLVideoElement>(null);
  const videoB = useRef<HTMLVideoElement>(null);
  const [front, setFront] = useState<0 | 1>(0);
  const frontRef = useRef<0 | 1>(0);
  const startedRef = useRef(false);
  // The cue key each video element was last loaded for, and the current cue's key:
  // a clip that ends after the cue moved on must not end the new one-shot.
  const loadedKeys = useRef<[string | null, string | null]>([null, null]);
  const cueKeyRef = useRef<string | null>(null);
  const onEndedRef = useRef(onEnded);

  useEffect(() => {
    onEndedRef.current = onEnded;
  });

  const info = clips[clipNameFor(cue.emote)];
  const { key, loop } = cue;

  useEffect(() => {
    const videos = [videoA.current, videoB.current] as const;
    const target: 0 | 1 = startedRef.current ? (frontRef.current === 0 ? 1 : 0) : 0;
    startedRef.current = true;
    const video = videos[target];
    cueKeyRef.current = key;
    if (!video) return;
    loadedKeys.current[target] = key;

    let cancelled = false;
    let pauseTimer: ReturnType<typeof setTimeout> | undefined;
    // React only sets `muted` as a property after mount; autoplay needs it before play().
    video.muted = true;
    video.loop = loop;
    video.poster = info.poster;
    if (video.getAttribute("src") !== info.src) video.src = info.src;
    else video.currentTime = 0;

    const reveal = () => {
      if (cancelled) return;
      frontRef.current = target;
      setFront(target);
      const other = videos[target === 0 ? 1 : 0];
      // Hold the outgoing clip until it has faded out, then stop decoding it.
      if (other && other !== video) pauseTimer = setTimeout(() => other.pause(), FADE_MS + 60);
    };
    // Muted inline playback is allowed without a gesture; if it is refused anyway
    // (data saver, decode error) show the poster rather than a stale clip.
    video.play().then(reveal, reveal);

    return () => {
      cancelled = true;
      clearTimeout(pauseTimer);
    };
  }, [key, loop, info.src, info.poster]);

  // Warm the HTTP / service-worker cache so later clips start instantly.
  useEffect(() => {
    const controller = new AbortController();
    for (const name of CLIP_NAMES) {
      fetch(clips[name].src, { signal: controller.signal }).catch(() => undefined);
    }
    return () => controller.abort();
    // Once per mount: the table only changes in durations after the manifest loads.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Browsers pause background video; resume the visible clip on return.
  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState !== "visible") return;
      const video = frontRef.current === 0 ? videoA.current : videoB.current;
      if (video && video.paused && !video.ended) void video.play().catch(() => undefined);
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, []);

  const endedFor = (index: 0 | 1) => (event: SyntheticEvent<HTMLVideoElement>) => {
    if (index !== frontRef.current || event.currentTarget.loop) return;
    if (loadedKeys.current[index] === cueKeyRef.current) onEndedRef.current();
  };

  return (
    <div
      className={cn("avatar-stage", className)}
      data-focus={cue.focus}
      style={{
        background: `linear-gradient(to bottom, ${AVATAR_BACKDROP} 0%, ${AVATAR_BACKDROP} 62%, ${AVATAR_FLOOR} 100%)`,
      }}
      aria-hidden="true"
    >
      {([videoA, videoB] as const).map((ref, index) => (
        <video
          key={index}
          ref={ref}
          className="avatar-video"
          data-front={front === index}
          // Every clip starts on the neutral idle pose; the effect sets each clip's own poster.
          poster={index === 0 ? DEFAULT_CLIPS.idle.poster : undefined}
          muted
          playsInline
          preload="auto"
          disablePictureInPicture
          disableRemotePlayback
          onEnded={endedFor(index as 0 | 1)}
        />
      ))}
      <div className="avatar-vignette" />
    </div>
  );
}
