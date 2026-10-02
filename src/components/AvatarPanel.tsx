"use client";

import type { ReactNode } from "react";
import { CloudRain, Frown, Hand, Heart, Mic, MicOff, ThumbsUp } from "lucide-react";
import { AvatarStage } from "@/components/AvatarStage";
import { WardrobeButton } from "@/components/WardrobeButton";
import type { AvatarDirector } from "@/hooks/useAvatarDirector";
import { useHoldToTalk } from "@/hooks/useHoldToTalk";
import type { SpeechRecognitionState } from "@/hooks/useSpeechRecognition";
import type { ReplyEmote } from "@/lib/emote";
import { cn } from "@/lib/utils";

// The desktop HUD's avatar frame: Jeannie full-body in the left column, a small
// emote row bottom-left and a hold-to-talk mic bottom-right.

const EMOTE_BUTTONS: { emote: ReplyEmote; label: string; icon: ReactNode }[] = [
  { emote: "greeting", label: "Bow", icon: <Hand /> },
  { emote: "air_kiss", label: "Air kiss", icon: <Heart /> },
  { emote: "nod", label: "Nod", icon: <ThumbsUp /> },
  { emote: "concern", label: "Concern", icon: <Frown /> },
  { emote: "sadness", label: "Sadness", icon: <CloudRain /> },
];

interface AvatarPanelProps {
  director: AvatarDirector;
  recognition: SpeechRecognitionState;
  /** Her voice's output level (0..1) and whether it is measured from the real audio. */
  voiceLevel: () => number;
  voiceMeasured: boolean;
  className?: string;
}

export function AvatarPanel({ director, recognition, voiceLevel, voiceMeasured, className }: AvatarPanelProps) {
  const hold = useHoldToTalk(recognition);
  const heard = recognition.listening ? recognition.interim : "";

  return (
    <section aria-label="Jeannie" className={cn("hud-panel avatar-panel relative overflow-hidden", className)}>
      <AvatarStage
        className="absolute inset-0"
        cue={director.cue}
        clips={director.clips}
        onEnded={director.ended}
        voiceLevel={voiceLevel}
        voiceMeasured={voiceMeasured}
      />

      {heard ? (
        <p className="avatar-heard pointer-events-none absolute inset-x-3 bottom-20 z-10 mx-auto max-w-[90%]">{heard}</p>
      ) : null}

      <div className="absolute inset-x-0 bottom-0 z-10 flex items-end justify-between gap-2 p-2.5">
        <div className="avatar-emotes" role="group" aria-label="Emotes">
          {EMOTE_BUTTONS.map(({ emote, label, icon }) => (
            <button
              key={emote}
              type="button"
              className="avatar-emote"
              onClick={() => director.play(emote)}
              aria-label={label}
              title={label}
            >
              {icon}
            </button>
          ))}
        </div>

        <WardrobeButton director={director} className="avatar-fab-sm" align="right" />

        <button
          type="button"
          className={cn("avatar-fab avatar-fab-desk touch-hold", recognition.listening && "avatar-fab-live")}
          disabled={!recognition.supported}
          aria-pressed={recognition.listening}
          aria-label={
            !recognition.supported
              ? "Voice input is not supported in this browser"
              : recognition.listening
                ? "Listening. Release to send"
                : "Hold to talk to Jeannie"
          }
          title={recognition.supported ? "Hold to talk" : "Voice input unavailable"}
          data-hold-to-talk=""
          {...hold}
        >
          {recognition.supported ? (
            <Mic className="h-6 w-6" aria-hidden="true" />
          ) : (
            <MicOff className="h-6 w-6" aria-hidden="true" />
          )}
        </button>
      </div>
    </section>
  );
}
