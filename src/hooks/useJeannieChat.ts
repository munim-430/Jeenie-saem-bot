"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { ApiRequestError, isAbortError, openChatStream, readAccessKey } from "@/lib/client/api";
import type { AgentId, ChatMessage, LangMode, LlmProvider, ResolvedLang, SourceLink } from "@/lib/types";

export type HudMessageStatus = "streaming" | "done" | "stopped" | "error";

export interface HudMessage {
  id: string;
  role: "user" | "assistant" | "system";
  content: string;
  createdAt: number;
  status: HudMessageStatus;
  image?: string | null;
  agent?: AgentId | null;
  lang?: ResolvedLang | null;
  provider?: LlmProvider | null;
  sources?: SourceLink[];
  latencyMs?: number;
}

/** idle → waiting (request sent, no bytes yet) → streaming (text arriving) → idle. */
export type ChatPhase = "idle" | "waiting" | "streaming";

export interface ChatTelemetry {
  lastLatencyMs: number | null;
  lastTtfbMs: number | null;
  activeAgent: AgentId | null;
  provider: LlmProvider | null;
}

export interface CompletedReply {
  text: string;
  lang: ResolvedLang | null;
  agent: AgentId | null;
}

interface ChatOptions {
  lang: LangMode;
  /** Runs before every request (e.g. stop speaking). */
  onBeforeSend?: () => void;
  onReplyComplete?: (reply: CompletedReply) => void;
  /** 401 access_key_required. `rejected` = a stored key was sent and refused. */
  onAccessKeyRequired?: (rejected: boolean) => void;
}

// Contract limits are 50 messages / 20k chars; stay comfortably inside them.
const HISTORY_LIMIT = 24;
const MAX_CHARS = 20_000;

let sequence = 0;
const nextId = (prefix: string) => `${prefix}-${Date.now().toString(36)}-${(sequence++).toString(36)}`;

function defaultImagePrompt(lang: LangMode): string {
  return lang === "ko" ? "이 이미지를 분석해 주세요." : "Analyze this image.";
}

function describeError(error: unknown): string {
  if (error instanceof ApiRequestError) {
    if (error.status === 0) return error.message;
    return `${error.message} [${error.status}${error.code.startsWith("http_") ? "" : ` · ${error.code}`}]`;
  }
  return "Unexpected failure while talking to Jeannie.";
}

export function useJeannieChat(options: ChatOptions) {
  const [messages, setMessages] = useState<HudMessage[]>([]);
  const [phase, setPhase] = useState<ChatPhase>("idle");
  const [telemetry, setTelemetry] = useState<ChatTelemetry>({
    lastLatencyMs: null,
    lastTtfbMs: null,
    activeAgent: null,
    provider: null,
  });

  // Mirrors of state for use inside async flows without stale closures.
  const messagesRef = useRef<HudMessage[]>([]);
  const optionsRef = useRef(options);
  const controllerRef = useRef<AbortController | null>(null);
  const pendingRetryRef = useRef<string | null>(null);

  useEffect(() => {
    optionsRef.current = options;
  });

  const commit = useCallback((update: (prev: HudMessage[]) => HudMessage[]) => {
    messagesRef.current = update(messagesRef.current);
    setMessages(messagesRef.current);
  }, []);

  const patch = useCallback(
    (id: string, changes: Partial<HudMessage>) =>
      commit((prev) => prev.map((m) => (m.id === id ? { ...m, ...changes } : m))),
    [commit],
  );

  const addSystemLine = useCallback(
    (content: string) =>
      commit((prev) => [
        ...prev,
        { id: nextId("sys"), role: "system", content, createdAt: Date.now(), status: "error" },
      ]),
    [commit],
  );

  const buildHistory = useCallback((userId: string): ChatMessage[] => {
    const all = messagesRef.current;
    const end = all.findIndex((m) => m.id === userId);
    const upTo = end === -1 ? all : all.slice(0, end + 1);
    const conversational = upTo.filter(
      (m) => m.role !== "system" && m.status !== "error" && m.content.trim().length > 0,
    );
    return conversational.slice(-HISTORY_LIMIT).map((m, index, list): ChatMessage => {
      const isNewest = index === list.length - 1;
      const role = m.role === "user" ? "user" : "assistant";
      const content = m.content.slice(0, MAX_CHARS);
      // Only the newest user turn carries its image; older turns are text-only.
      return isNewest && m.image ? { role, content, image: m.image } : { role, content };
    });
  }, []);

  const run = useCallback(
    async (userId: string) => {
      const history = buildHistory(userId);
      if (history.length === 0 || history[history.length - 1].role !== "user") return;

      const controller = new AbortController();
      controllerRef.current = controller;
      const assistantId = nextId("jeannie");
      commit((prev) => [
        ...prev,
        { id: assistantId, role: "assistant", content: "", createdAt: Date.now(), status: "streaming" },
      ]);
      setPhase("waiting");
      setTelemetry((prev) => ({ ...prev, activeAgent: null }));

      const started = performance.now();
      let text = "";
      let frame = 0;
      const flush = () => {
        frame = 0;
        patch(assistantId, { content: text });
      };

      try {
        const { meta, chunks } = await openChatStream(
          { messages: history, lang: optionsRef.current.lang },
          controller.signal,
        );
        patch(assistantId, { agent: meta.agent, lang: meta.lang, provider: meta.provider, sources: meta.sources });
        setTelemetry((prev) => ({ ...prev, activeAgent: meta.agent, provider: meta.provider }));

        let ttfb: number | null = null;
        for await (const chunk of chunks) {
          if (ttfb === null) {
            ttfb = Math.round(performance.now() - started);
            setPhase("streaming");
            setTelemetry((prev) => ({ ...prev, lastTtfbMs: ttfb }));
          }
          text += chunk;
          // Coalesce token bursts into one render per frame.
          if (!frame) frame = requestAnimationFrame(flush);
        }
        cancelAnimationFrame(frame);

        const latency = Math.round(performance.now() - started);
        setTelemetry((prev) => ({ ...prev, lastLatencyMs: latency, lastTtfbMs: ttfb ?? latency }));
        if (!text.trim()) {
          commit((prev) => prev.filter((m) => m.id !== assistantId));
          addSystemLine("Jeannie returned an empty transmission. Try again.");
          return;
        }
        patch(assistantId, { content: text, status: "done", latencyMs: latency });
        optionsRef.current.onReplyComplete?.({ text, lang: meta.lang, agent: meta.agent });
      } catch (error) {
        cancelAnimationFrame(frame);
        if (isAbortError(error)) {
          if (text) patch(assistantId, { content: text, status: "stopped" });
          else commit((prev) => prev.filter((m) => m.id !== assistantId));
          return;
        }
        if (text) patch(assistantId, { content: text, status: "stopped" });
        else commit((prev) => prev.filter((m) => m.id !== assistantId));

        if (error instanceof ApiRequestError && error.needsAccessKey) {
          pendingRetryRef.current = userId;
          optionsRef.current.onAccessKeyRequired?.(readAccessKey() !== null);
          return;
        }
        addSystemLine(describeError(error));
      } finally {
        if (controllerRef.current === controller) {
          controllerRef.current = null;
          setPhase("idle");
        }
      }
    },
    [addSystemLine, buildHistory, commit, patch],
  );

  const stop = useCallback(() => {
    controllerRef.current?.abort();
  }, []);

  /** Sends a user turn. Interrupts a reply still streaming. Returns false when there is nothing to send. */
  const send = useCallback(
    (text: string, image?: string | null): boolean => {
      const trimmed = text.trim();
      if (!trimmed && !image) return false;
      controllerRef.current?.abort();
      pendingRetryRef.current = null;
      optionsRef.current.onBeforeSend?.();

      const userMessage: HudMessage = {
        id: nextId("op"),
        role: "user",
        content: trimmed || defaultImagePrompt(optionsRef.current.lang),
        createdAt: Date.now(),
        status: "done",
        image: image ?? null,
      };
      commit((prev) => [...prev, userMessage]);
      void run(userMessage.id);
      return true;
    },
    [commit, run],
  );

  /** Re-sends the request that was refused for lack of an access key. */
  const retryPending = useCallback(() => {
    const pending = pendingRetryRef.current;
    pendingRetryRef.current = null;
    if (pending) void run(pending);
  }, [run]);

  const dropPending = useCallback(() => {
    if (!pendingRetryRef.current) return;
    pendingRetryRef.current = null;
    addSystemLine("Access key required. Use the lock control to enter it, then resend.");
  }, [addSystemLine]);

  const clear = useCallback(() => {
    controllerRef.current?.abort();
    pendingRetryRef.current = null;
    commit(() => []);
  }, [commit]);

  useEffect(() => () => controllerRef.current?.abort(), []);

  return { messages, phase, telemetry, send, stop, retryPending, dropPending, clear, notify: addSystemLine };
}

export type JeannieChat = ReturnType<typeof useJeannieChat>;
