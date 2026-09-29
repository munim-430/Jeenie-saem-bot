"use client";

import { useEffect, useState } from "react";
import type { AvatarDirector } from "@/hooks/useAvatarDirector";
import { emotePickerEnabled } from "@/lib/avatar/debug";
import { REPLY_EMOTES } from "@/lib/emote";

// QA picker (preview deployments only): plays any emote on tap so every clip can be
// checked on a real phone before a release goes live.

export function EmotePicker({ director }: { director: AvatarDirector }) {
  const [enabled, setEnabled] = useState(false);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    setEnabled(emotePickerEnabled(process.env.NEXT_PUBLIC_DEPLOY_ENV, window.location.search));
  }, []);

  if (!enabled) return null;

  return (
    <div className="emote-picker" data-testid="emote-picker">
      <button type="button" className="emote-picker-toggle" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
        {open ? "Close" : "Emotes (QA)"}
      </button>
      {open ? (
        <div className="emote-picker-list">
          {REPLY_EMOTES.map((emote) => (
            <button key={emote} type="button" data-emote={emote} onClick={() => director.play(emote)}>
              {emote}
            </button>
          ))}
          <button type="button" data-emote="sway" onClick={() => director.vary("sway")}>
            sway (idle)
          </button>
        </div>
      ) : null}
    </div>
  );
}
