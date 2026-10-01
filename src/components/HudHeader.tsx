"use client";

import { motion } from "framer-motion";
import { Lock, LockOpen } from "lucide-react";
import { formatClock, useNow } from "@/hooks/useNow";
import type { DesktopLayout } from "@/lib/avatar/view-mode";
import type { SystemStatus } from "@/lib/types";
import { cn } from "@/lib/utils";

interface HudHeaderProps {
  status: SystemStatus | null;
  statusError: string | null;
  hasAccessKey: boolean;
  onAccessKey: () => void;
  /** Wide desktop only: the 1 | 2 switch between the classic HUD and the avatar layout. */
  desktopLayout?: DesktopLayout;
  onDesktopLayoutChange?: (layout: DesktopLayout) => void;
}

const LAYOUT_OPTIONS: { value: DesktopLayout; label: string; title: string }[] = [
  { value: "hud", label: "1 HUD", title: "Option 1: classic HUD" },
  { value: "avatar", label: "2 Avatar", title: "Option 2: Jeannie in the left frame" },
];

function LayoutSwitch({ value, onChange }: { value: DesktopLayout; onChange: (layout: DesktopLayout) => void }) {
  return (
    <div
      role="radiogroup"
      aria-label="Desktop view"
      className="inline-flex rounded-md border border-neon/35 bg-void/60 p-0.5"
      onKeyDown={(event) => {
        if (["ArrowRight", "ArrowLeft", "ArrowUp", "ArrowDown"].includes(event.key)) {
          event.preventDefault();
          onChange(value === "hud" ? "avatar" : "hud");
        }
      }}
    >
      {LAYOUT_OPTIONS.map((option) => {
        const selected = option.value === value;
        return (
          <button
            key={option.value}
            type="button"
            role="radio"
            aria-checked={selected}
            tabIndex={selected ? 0 : -1}
            title={option.title}
            aria-label={option.title}
            onClick={() => onChange(option.value)}
            className={cn(
              "min-h-[36px] rounded px-2.5 font-mono text-[0.68rem] font-semibold tracking-[0.12em] transition-all",
              selected
                ? "bg-neon text-white shadow-glow-sm"
                : "text-petal-soft/70 hover:bg-neon/15 hover:text-petal-soft",
            )}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}

const dateFormatter = new Intl.DateTimeFormat("en-GB", {
  weekday: "short",
  day: "2-digit",
  month: "short",
  year: "numeric",
});

function Pill({ label, value, state }: { label: string; value: string; state: "on" | "warn" | "off" }) {
  return (
    <span className="hud-pill" title={`${label}: ${value}`}>
      <span className={cn("led", state === "on" ? "led-on" : state === "warn" ? "led-warn" : "")} aria-hidden="true" />
      <span className="text-petal-soft/60">{label}</span>
      <span className="text-white">{value}</span>
    </span>
  );
}

function LogoMark() {
  return (
    <span aria-hidden="true" className="relative flex h-9 w-9 shrink-0 items-center justify-center">
      <span className="absolute inset-0 animate-[spin_12s_linear_infinite] rounded-full border border-dashed border-neon-hot/70" />
      <span className="absolute inset-[5px] rounded-full border border-neon/60" />
      <span className="h-3.5 w-3.5 rounded-full bg-[radial-gradient(circle,#fff_0%,#FF69B4_40%,#FF007F_75%)] shadow-glow" />
    </span>
  );
}

export function HudHeader({
  status,
  statusError,
  hasAccessKey,
  onAccessKey,
  desktopLayout,
  onDesktopLayoutChange,
}: HudHeaderProps) {
  const now = useNow(1000);
  const locked = Boolean(status?.accessKeyRequired) && !hasAccessKey;

  const pills = status
    ? [
        {
          label: "CORE",
          value: status.llm.provider === "none" ? "OFFLINE" : status.llm.provider.toUpperCase(),
          state: status.llm.provider === "none" ? ("warn" as const) : ("on" as const),
        },
        { label: "SEARCH", value: String(status.search.providers.length), state: "on" as const },
        {
          label: "VOICE",
          value: status.voice.engines.includes("elevenlabs")
            ? "11LABS"
            : status.voice.engines.includes("edge")
              ? "NEURAL"
              : "BROWSER",
          state: status.voice.engines.length > 1 ? ("on" as const) : ("warn" as const),
        },
        {
          label: "TG",
          value: status.telegram.configured ? "LINK" : "OFF",
          state: status.telegram.configured ? ("on" as const) : ("off" as const),
        },
        {
          label: "HANGEUL",
          value: status.hangeul.mode.toUpperCase(),
          state: status.hangeul.mode === "live" ? ("on" as const) : ("warn" as const),
        },
      ]
    : [
        {
          label: "SYS",
          value: statusError ? "NO FEED" : "SCANNING",
          state: statusError ? ("warn" as const) : ("off" as const),
        },
      ];

  return (
    <motion.header
      initial={{ opacity: 0, y: -12 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.5, ease: [0.22, 1, 0.36, 1] }}
      className="hud-panel flex items-center justify-between gap-3 px-3 py-1.5 sm:px-4"
    >
      <div className="flex min-w-0 items-center gap-2.5 sm:gap-3">
        <LogoMark />
        <div className="min-w-0">
          <h1 className="animate-glitch whitespace-nowrap font-display text-[0.95rem] font-bold tracking-[0.22em] text-white text-glow sm:text-lg sm:tracking-[0.34em]">
            J.E.A.N.N.I.E
          </h1>
          <p className="truncate font-mono text-[0.58rem] uppercase tracking-[0.16em] text-petal-soft/65 sm:text-[0.62rem] sm:tracking-[0.22em]">
            Tactical AI<span className="hidden normal-case tracking-[0.08em] sm:inline"> · 전술 AI 비서</span>
          </p>
        </div>
      </div>

      <div
        className="hidden min-w-0 flex-wrap items-center justify-center gap-1.5 xl:flex"
        aria-label="System capabilities"
      >
        {pills.map((pill) => (
          <Pill key={pill.label} {...pill} />
        ))}
      </div>

      <div className="flex shrink-0 items-center gap-2 sm:gap-3">
        <div className="text-right" aria-label="Local time">
          <p className="font-mono text-sm tabular-nums tracking-[0.08em] text-white text-glow-soft sm:text-lg">
            {now ? formatClock(now) : "--:--:--"}
          </p>
          <p className="hidden font-mono text-[0.58rem] uppercase tracking-[0.2em] text-petal-soft/60 sm:block">
            {now ? dateFormatter.format(now) : " "}
          </p>
        </div>
        {desktopLayout && onDesktopLayoutChange ? (
          <LayoutSwitch value={desktopLayout} onChange={onDesktopLayoutChange} />
        ) : null}
        <button
          type="button"
          onClick={onAccessKey}
          aria-label={
            locked ? "Locked: enter access key" : hasAccessKey ? "Access key loaded: manage key" : "Set access key"
          }
          title={locked ? "Access key required" : hasAccessKey ? "Access key loaded" : "Access key"}
          data-active={hasAccessKey}
          className={cn("hud-btn", locked && "animate-pulse border-amber-300/70 text-amber-200")}
        >
          {hasAccessKey || locked ? (
            <Lock aria-hidden="true" className="h-4 w-4" />
          ) : (
            <LockOpen aria-hidden="true" className="h-4 w-4" />
          )}
        </button>
      </div>
    </motion.header>
  );
}
