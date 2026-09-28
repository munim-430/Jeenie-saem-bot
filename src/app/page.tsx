"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { MotionConfig } from "framer-motion";
import { AccessKeyDialog, type AccessKeyReason } from "@/components/AccessKeyDialog";
import { CameraScanner } from "@/components/CameraScanner";
import { ChatTerminal, type Attachment } from "@/components/ChatTerminal";
import type { OrbState } from "@/components/HologramOrb";
import { HudHeader } from "@/components/HudHeader";
import { MemoryPanel } from "@/components/MemoryPanel";
import { isLangMode } from "@/components/LanguageToggle";
import { ReactorCore } from "@/components/ReactorCore";
import { TacticalMetrics } from "@/components/TacticalMetrics";
import { useJeannieChat } from "@/hooks/useJeannieChat";
import { usePersistentState } from "@/hooks/usePersistentState";
import { useSpeechOutput } from "@/hooks/useSpeechOutput";
import { useSpeechRecognition, type RecognitionLang, type SpeechRecognitionState } from "@/hooks/useSpeechRecognition";
import { useSystemStatus } from "@/hooks/useSystemStatus";
import { fetchSessionGreeting, readAccessKey, writeAccessKey } from "@/lib/client/api";
import type { LangMode } from "@/lib/types";

const isBoolean = (value: unknown): value is boolean => typeof value === "boolean";

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
  const [sessionStart, setSessionStart] = useState<number | null>(null);
  const [prefersKorean, setPrefersKorean] = useState(false);

  const system = useSystemStatus();
  const speech = useSpeechOutput({
    serverVoice: system.status ? system.status.voice.engines.some((engine) => engine !== "browser") : true,
  });
  const voiceOnRef = useRef(voiceOn);
  const attachmentRef = useRef(attachment);
  const listeningRef = useRef(false);

  useEffect(() => {
    voiceOnRef.current = voiceOn;
    attachmentRef.current = attachment;
  });

  // Browser-only facts, read after hydration.
  useEffect(() => {
    setHasAccessKey(readAccessKey() !== null);
    setSessionStart(Date.now());
    setPrefersKorean(/^ko\b/i.test(navigator.language ?? ""));
  }, []);

  const chat = useJeannieChat({
    lang,
    onBeforeSend: speech.stop,
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
    if (greetedRef.current || !statusLoaded || (keyNeeded && !hasAccessKey)) return;
    greetedRef.current = true;
    // Not aborted on cleanup: the ref already stops a second request, and the
    // greeting is skipped anyway once the operator has started chatting.
    fetchSessionGreeting()
      .then(({ greeting }) => {
        // Browsers may block audio before the first click; the text still shows.
        if (greet(greeting) && voiceOnRef.current && !listeningRef.current) speak(greeting, "ko");
      })
      .catch(() => undefined);
  }, [statusLoaded, keyNeeded, hasAccessKey, greet, speak]);

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

  return (
    <MotionConfig reducedMotion="user">
      <div className="relative z-10 mx-auto flex min-h-[100dvh] w-full max-w-[1920px] flex-col gap-3 px-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] pt-[max(0.75rem,env(safe-area-inset-top))] sm:px-4 lg:h-[100dvh] lg:overflow-hidden">
        <HudHeader
          status={system.status}
          statusError={system.error}
          hasAccessKey={hasAccessKey}
          onAccessKey={() => setKeyDialog({ open: true, reason: "manage" })}
        />

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

          <ChatTerminal
            className="order-2 h-[72svh] min-h-[460px] lg:order-3 lg:h-auto lg:min-h-0"
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

          <TacticalMetrics
            className="order-3 md:grid md:grid-cols-2 md:items-start lg:order-1 lg:flex lg:min-h-0 lg:items-stretch lg:overflow-y-auto lg:overscroll-contain lg:pb-1 lg:pr-1"
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
        </main>
      </div>

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
