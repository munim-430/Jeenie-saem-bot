"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { MotionConfig } from "framer-motion";
import { AccessKeyDialog, type AccessKeyReason } from "@/components/AccessKeyDialog";
import { AvatarPanel } from "@/components/AvatarPanel";
import { AvatarReturnButton, AvatarScreen } from "@/components/AvatarScreen";
import { CameraScanner } from "@/components/CameraScanner";
import { ChatTerminal, type Attachment } from "@/components/ChatTerminal";
import type { OrbState } from "@/components/HologramOrb";
import { HudHeader } from "@/components/HudHeader";
import { MemoryPanel } from "@/components/MemoryPanel";
import { isLangMode } from "@/components/LanguageToggle";
import { ReactorCore } from "@/components/ReactorCore";
import { TacticalMetrics } from "@/components/TacticalMetrics";
import { useAvatarDirector } from "@/hooks/useAvatarDirector";
import { useIdleWatch } from "@/hooks/useIdleWatch";
import { useJeannieChat } from "@/hooks/useJeannieChat";
import { useLastSeen } from "@/hooks/useLastSeen";
import { useMediaQuery } from "@/hooks/useMediaQuery";
import { usePersistentState } from "@/hooks/usePersistentState";
import { useSpeechOutput } from "@/hooks/useSpeechOutput";
import { useSpeechRecognition, type RecognitionLang, type SpeechRecognitionState } from "@/hooks/useSpeechRecognition";
import { useSystemStatus } from "@/hooks/useSystemStatus";
import { useViewMode } from "@/hooks/useViewMode";
import { pickCheckIn } from "@/lib/avatar/idle";
import { DESKTOP_LAYOUT_STORAGE_KEY, isDesktopLayout, type DesktopLayout } from "@/lib/avatar/view-mode";
import { ApiRequestError, fetchSessionGreeting, readAccessKey, writeAccessKey } from "@/lib/client/api";
import type { LangMode } from "@/lib/types";
import { cn } from "@/lib/utils";

const isBoolean = (value: unknown): value is boolean => typeof value === "boolean";

/** Matches Tailwind's `xl`: below it five dock cards get too cramped, so the HUD keeps the orb layout. */
const WIDE_HUD_QUERY = "(min-width: 1280px)";

export default function JeannieHud() {
  const [lang, setLang] = usePersistentState<LangMode>("jeannie.lang", "auto", isLangMode);
  const [voiceOn, setVoiceOn] = usePersistentState<boolean>("jeannie.voice", true, isBoolean);
  const [attachment, setAttachment] = useState<Attachment | null>(null);
  const [cameraOpen, setCameraOpen] = useState(false);
  const [keyDialog, setKeyDialog] = useState<{ open: boolean; reason: AccessKeyReason }>({
    open: false,
    reason: "required",
  });
  const [hasAccessKey, setHasAccessKey] = useState(false);
  // Bumped on every key entry so a greeting refused with a stale key is retried.
  const [keyVersion, setKeyVersion] = useState(0);
  const [sessionStart, setSessionStart] = useState<number | null>(null);
  const [prefersKorean, setPrefersKorean] = useState(false);

  // Phones get the avatar screen, everything else the HUD (null until hydrated).
  const viewMode = useViewMode();
  const avatarMode = viewMode.view === "avatar";
  // Wide HUD (desktop): Jeannie stands in the left frame and the panels move to a dock below.
  const wideScreen = useMediaQuery(WIDE_HUD_QUERY);
  // Option 2 (avatar) unless the header's 1 | 2 switch picked Option 1 (classic HUD) on this device.
  const [desktopLayout, setDesktopLayout] = usePersistentState<DesktopLayout>(
    DESKTOP_LAYOUT_STORAGE_KEY,
    "avatar",
    isDesktopLayout,
  );
  const desktopAvatar = viewMode.view === "hud" && wideScreen === true && desktopLayout === "avatar";
  // Either way she is on screen, so she bows, reacts and checks in.
  const avatarOnScreen = avatarMode || desktopAvatar;
  const awayMs = useLastSeen();

  const system = useSystemStatus();
  const speech = useSpeechOutput({
    serverVoice: system.status ? system.status.voice.engines.some((engine) => engine !== "browser") : true,
  });
  const voiceOnRef = useRef(voiceOn);
  const attachmentRef = useRef(attachment);
  const listeningRef = useRef(false);
  // The greeting's text until it has actually been heard (autoplay may block it).
  const unheardGreetingRef = useRef<string | null>(null);
  const speechBusyRef = useRef(false);

  useEffect(() => {
    voiceOnRef.current = voiceOn;
    attachmentRef.current = attachment;
    speechBusyRef.current = speech.speaking || speech.preparing;
  });

  // Browser-only facts, read after hydration.
  useEffect(() => {
    setHasAccessKey(readAccessKey() !== null);
    setSessionStart(Date.now());
    setPrefersKorean(/^ko\b/i.test(navigator.language ?? ""));
  }, []);

  const chat = useJeannieChat({
    lang,
    onBeforeSend: () => {
      unheardGreetingRef.current = null;
      speech.stop();
    },
    // Only reached after render, when `director` exists.
    onEmote: (emote) => director.play(emote),
    onReplyComplete: (reply) => {
      // Not while the mic is open: she would be transcribed into the operator's next message.
      if (voiceOnRef.current && !listeningRef.current) speech.speak(reply.text, reply.lang);
    },
    onAccessKeyRequired: (rejected) => setKeyDialog({ open: true, reason: rejected ? "rejected" : "required" }),
  });

  // Opening line: a Korean greeting for the operator's time of day. Once per page load,
  // after the status says whether a key is needed (a 401 here would be noise).
  const greetedRef = useRef(false);
  const statusLoaded = system.status !== null;
  const keyNeeded = Boolean(system.status?.accessKeyRequired);
  const { greet } = chat;
  const { speak } = speech;
  useEffect(() => {
    if (greetedRef.current || awayMs === undefined || !statusLoaded || (keyNeeded && !hasAccessKey)) return;
    greetedRef.current = true;
    // Not aborted on cleanup: the ref already stops a second request, and the
    // greeting is skipped anyway once the operator has started chatting.
    fetchSessionGreeting({ awayMs: awayMs ?? undefined })
      .then(({ greeting }) => {
        if (!greet(greeting) || !voiceOnRef.current || listeningRef.current) return;
        // Browsers may block audio before the first tap; the text still shows and
        // the voice gets one more try on the first tap (below).
        unheardGreetingRef.current = greeting;
        speak(greeting, "ko");
      })
      .catch((error: unknown) => {
        // A missing or stale key: ask for it, then greet once it is entered.
        if (!(error instanceof ApiRequestError) || !error.needsAccessKey) return;
        greetedRef.current = false;
        setKeyDialog({ open: true, reason: readAccessKey() ? "rejected" : "required" });
      });
  }, [awayMs, statusLoaded, keyNeeded, hasAccessKey, keyVersion, greet, speak]);

  // The avatar screen has no lock button, so a phone without a key is asked for it
  // straight away; otherwise she would stand silent until the first message.
  const promptedForKeyRef = useRef(false);
  useEffect(() => {
    if (promptedForKeyRef.current || !avatarMode || !keyNeeded || hasAccessKey) return;
    promptedForKeyRef.current = true;
    setKeyDialog({ open: true, reason: "required" });
  }, [avatarMode, keyNeeded, hasAccessKey]);

  useEffect(() => {
    if (speech.speaking) unheardGreetingRef.current = null;
  }, [speech.speaking]);

  useEffect(() => {
    const onPointerDown = (event: PointerEvent) => {
      const greeting = unheardGreetingRef.current;
      // Still fetching / playing: it may yet be heard, so keep the retry for later.
      if (!greeting || speechBusyRef.current) return;
      unheardGreetingRef.current = null;
      // Pressing the mic means the user wants to talk, not to be greeted.
      const target = event.target instanceof Element ? event.target : null;
      if (target?.closest("[data-hold-to-talk]")) return;
      if (voiceOnRef.current && !listeningRef.current) speak(greeting, "ko");
    };
    window.addEventListener("pointerdown", onPointerDown, true);
    return () => window.removeEventListener("pointerdown", onPointerDown, true);
  }, [speak]);

  const recognitionLang: RecognitionLang =
    lang === "ko" ? "ko-KR" : lang === "en" ? "en-US" : prefersKorean ? "ko-KR" : "en-US";

  const recognition = useSpeechRecognition({
    lang: recognitionLang,
    onFinal: (transcript) => {
      chat.send(transcript, attachmentRef.current?.dataUrl ?? null);
      setAttachment(null);
    },
  });

  // Opening the mic silences Jeannie so she doesn't transcribe herself.
  const voiceInput: SpeechRecognitionState = {
    ...recognition,
    start: () => {
      speech.stop();
      recognition.start();
    },
  };

  useEffect(() => {
    listeningRef.current = recognition.listening;
  }, [recognition.listening]);

  // Avatar clip state machine: idle / listening / talking plus one-shot emotes.
  const director = useAvatarDirector({ listening: recognition.listening, speaking: speech.speaking });

  // She bows on every load, the first time her screen is up.
  const bowedRef = useRef(false);
  const { play: playEmote } = director;
  useEffect(() => {
    if (!avatarOnScreen || bowedRef.current) return;
    bowedRef.current = true;
    playEmote("greeting");
  }, [avatarOnScreen, playEmote]);

  // Idle behaviour (avatar screen only): one spoken check-in after ~3 min (the director plays the idle sequence).
  useIdleWatch({
    enabled: avatarOnScreen,
    busy: speech.speaking || speech.preparing || recognition.listening || chat.phase !== "idle",
    onCheckIn: () => {
      const line = pickCheckIn();
      chat.announce(line, "ko");
      playEmote("concern");
      if (voiceOnRef.current && !listeningRef.current) speak(line, "ko");
    },
  });

  const { getLevel: speechLevel } = speech;
  const { activityRef } = recognition;
  const getLevel = useCallback(() => {
    if (listeningRef.current) {
      // Speech recognition exposes no audio samples: pulse on detected speech activity instead.
      const now = performance.now() / 1000;
      const since = now - activityRef.current;
      return Math.min(1, 0.2 + 0.55 * Math.exp(-since * 2.5) + 0.08 * Math.sin(now * 7.7));
    }
    return speechLevel();
  }, [activityRef, speechLevel]);

  const orbState: OrbState = recognition.listening
    ? "listening"
    : speech.speaking
      ? "speaking"
      : chat.phase !== "idle" || speech.preparing
        ? "analyzing"
        : "standby";

  const toggleVoice = () => {
    if (voiceOn) speech.stop();
    setVoiceOn(!voiceOn);
  };

  const closeKeyDialog = () => {
    const wasRequired = keyDialog.reason !== "manage";
    setKeyDialog((prev) => ({ ...prev, open: false }));
    if (wasRequired) chat.dropPending();
  };

  const submitKey = (key: string) => {
    writeAccessKey(key);
    setHasAccessKey(true);
    setKeyVersion((v) => v + 1);
    setKeyDialog((prev) => ({ ...prev, open: false }));
    chat.retryPending();
  };

  const forgetKey = () => {
    writeAccessKey(null);
    setHasAccessKey(false);
    setKeyDialog((prev) => ({ ...prev, open: false }));
  };

  const sendCommand = (command: string) => {
    chat.send(command);
  };

  const conversationCount = chat.messages.filter((m) => m.role !== "system").length;
  const replyLang = chat.messages.findLast((m) => m.role === "assistant" && m.lang)?.lang ?? null;
  const latestReply = chat.messages.findLast((m) => m.role === "assistant") ?? null;

  const renderChat = (className: string) => (
    <ChatTerminal
      className={className}
      messages={chat.messages}
      phase={chat.phase}
      speaking={speech.speaking || speech.preparing}
      lang={lang}
      onLangChange={setLang}
      voiceOn={voiceOn}
      onVoiceToggle={toggleVoice}
      attachment={attachment}
      onAttach={setAttachment}
      onOpenCamera={() => setCameraOpen(true)}
      onSend={chat.send}
      onStop={() => {
        chat.stop();
        speech.stop();
      }}
      onClear={() => {
        chat.clear();
        speech.stop();
      }}
      onNotice={chat.notify}
      recognition={voiceInput}
    />
  );

  const renderPanels = (className: string, dock = false) => (
    <TacticalMetrics
      className={className}
      dock={dock}
      status={system.status}
      statusLoading={system.loading}
      statusError={system.error}
      onRetryStatus={system.refresh}
      hasAccessKey={hasAccessKey}
      lang={lang}
      onCommand={sendCommand}
      telemetry={chat.telemetry}
      messageCount={conversationCount}
      voiceEngine={speech.engine}
      replyLang={replyLang}
      sessionStart={sessionStart}
    >
      <MemoryPanel
        configured={Boolean(system.status?.memory?.configured)}
        accessKeyRequired={keyNeeded}
        hasAccessKey={hasAccessKey}
        statusReady={statusLoaded}
        onNotice={chat.notify}
      />
    </TacticalMetrics>
  );

  return (
    <MotionConfig reducedMotion="user">
      {viewMode.view === null ? <div className="view-pending-backdrop" aria-hidden="true" /> : null}
      {avatarMode ? (
        <AvatarScreen
          director={director}
          subtitle={latestReply?.content ?? ""}
          subtitleLive={latestReply?.status === "streaming" || speech.speaking || speech.preparing}
          recognition={voiceInput}
          onSwitchToHud={() => viewMode.setView("hud")}
          voiceLevel={speech.getLevel}
          voiceMeasured={speech.routed}
        />
      ) : (
        // The server renders the HUD (desktop unchanged); phones keep it hidden until the view is known.
        <div
          className={cn(
            "relative z-10 mx-auto flex min-h-[100dvh] w-full max-w-[1920px] flex-col gap-3 px-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] pt-[max(0.75rem,env(safe-area-inset-top))] sm:px-4 lg:h-[100dvh] lg:overflow-hidden",
            viewMode.view === null && "view-pending",
          )}
        >
          <HudHeader
            status={system.status}
            statusError={system.error}
            hasAccessKey={hasAccessKey}
            onAccessKey={() => setKeyDialog({ open: true, reason: "manage" })}
            desktopLayout={wideScreen === true ? desktopLayout : undefined}
            onDesktopLayoutChange={setDesktopLayout}
          />

          {desktopAvatar ? (
            <main className="grid min-h-0 flex-1 grid-cols-[auto_minmax(0,1fr)] grid-rows-[minmax(0,1fr)_auto] gap-3">
              <AvatarPanel
                // Exactly her clips' 9:16 shape at the row's height: head to heels, no side bars.
                className="aspect-[9/16] h-full min-h-0"
                director={director}
                recognition={voiceInput}
                voiceLevel={speech.getLevel}
                voiceMeasured={speech.routed}
              />
              {renderChat("min-h-0")}
              {/* The dock: every panel as an equal card, each scrolling inside its own height. */}
              {renderPanels(
                "col-span-2 grid h-[clamp(230px,33vh,340px)] grid-cols-5 items-stretch gap-3 [&>*]:min-h-0 [&>*]:overflow-y-auto [&>*]:overscroll-contain",
                true,
              )}
            </main>
          ) : (
            <main className="grid min-h-0 flex-1 grid-cols-1 gap-3 lg:grid-cols-[minmax(280px,300px)_minmax(0,1fr)_minmax(340px,400px)] xl:grid-cols-[minmax(300px,340px)_minmax(0,1fr)_minmax(400px,460px)] 2xl:grid-cols-[minmax(340px,380px)_minmax(0,1fr)_minmax(460px,540px)]">
              <ReactorCore
                className="order-1 h-[350px] sm:h-[420px] lg:order-2 lg:h-auto lg:min-h-0 lg:py-2"
                state={orbState}
                getLevel={getLevel}
                // The real spectrum only while server audio plays through it; the mic has no samples.
                analyser={speech.speaking && speech.routed ? speech.analyser : null}
                activeAgent={chat.telemetry.activeAgent}
                provider={system.status?.llm.provider ?? chat.telemetry.provider}
                voiceEngine={speech.engine}
                preparingVoice={chat.phase === "idle" && speech.preparing}
                lang={lang}
              />

              {renderChat("order-2 h-[72svh] min-h-[460px] lg:order-3 lg:h-auto lg:min-h-0")}

              {renderPanels(
                "order-3 md:grid md:grid-cols-2 md:items-start lg:order-1 lg:flex lg:min-h-0 lg:items-stretch lg:overflow-y-auto lg:overscroll-contain lg:pb-1 lg:pr-1",
              )}
            </main>
          )}
        </div>
      )}
      {viewMode.view === "hud" && viewMode.isPhone ? (
        <AvatarReturnButton onClick={() => viewMode.setView("avatar")} />
      ) : null}

      <CameraScanner
        open={cameraOpen}
        onClose={() => setCameraOpen(false)}
        onCapture={(dataUrl) => setAttachment({ dataUrl, name: "Camera capture", source: "camera" })}
      />
      <AccessKeyDialog
        open={keyDialog.open}
        reason={keyDialog.reason}
        hasStoredKey={hasAccessKey}
        onSubmit={submitKey}
        onForget={forgetKey}
        onClose={closeKeyDialog}
      />
    </MotionConfig>
  );
}
