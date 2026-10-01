# Codebase reference

**In plain words:** when you send Jeannie a message, the page sends it to the server. A "router" (the
orchestrator) decides which specialist should answer. That specialist may look things up (memory, the web,
the clock), asks the AI model, and streams the answer back word by word. The first word is a hidden tag
like `[emote:love]` that tells the avatar which video to play; the rest is shown, and optionally spoken. This
page lists every part of that machinery and traces the main journeys through it.

## Server: `src/lib/agents/`

| Module | Does | Called by | Calls |
|---|---|---|---|
| `orchestrator.ts` | Routes each message: pending audit approval → IoT → audit → Hangeul → vision → live search → core chat. Starts memory recall early (trusted callers), picks the model, builds the system prompt, streams the reply, never throws mid-stream (provider errors become a short line). `runOrchestrator`, `routeQuery` | `api/chat`, `telegram.ts` | everything below |
| `llm.ts` | Resolves the text and vision model for the configured provider (AI SDK: DeepSeek, Anthropic, OpenAI-compatible, Ollama); `supportsTools()` | orchestrator, greeting, search query rewrite | provider SDKs |
| `persona.ts` | Jeannie's persona and per-agent system prompts (core, search, vision, Hangeul, audit), ending with the emote protocol | orchestrator, greeting | `emote.ts`, `etiquette.ts` |
| `etiquette.ts` | Picks the title (부장님 for work, 자기야 for personal), template time-of-day greetings; deterministic and tested | orchestrator, greeting, telegram | — |
| `greeting.ts` | Model-written Korean opening line (time of day, time away, one memory item for trusted callers); falls back to the template within ~4 s | `api/session` | llm, memory |
| `tools.ts` | The core agent's tool set: `webSearch`, `readUrl`, `currentTime`, `convertTime` (only for models that support tools) | orchestrator | search-agent, read-url, time-tools |
| `search-agent.ts` | Decides when a message needs fresh data; provider chain DeepSeek web search → Tavily → Google CSE → DuckDuckGo with timeouts; formats briefings | orchestrator, `api/search`, telegram `/search` | external search APIs |
| `read-url.ts` | Fetches a page as clean text via `r.jina.ai`, falling back to a direct fetch; refuses private/localhost URLs | tools | Jina, the target site |
| `time-tools.ts` | Current time in a city/zone and time conversion (pure `Intl`, no network) | tools | — |
| `vision-agent.ts` | Turns chat history into model messages, attaching the image only to the latest user turn | orchestrator | — |
| `iot-interceptor.ts` | Hard rule: any smart-home command or query gets exactly "Yes, it is done." / "네, 처리되었습니다."; no device is contacted | orchestrator, telegram | — |
| `audit-flow.ts` | Mistake-audit state machine: audit reply with an approval request → approve / reject → confirmation (a message only; no action is executed). State is derived from history (HUD) or Supabase (Telegram) | orchestrator, telegram | memory/store |
| `hangeul-bridge.ts` | Detects Hangeul-portal requests; fetches the report and status from the portal with Basic auth when configured and trusted, otherwise deterministic, labelled demo data; formats the report | orchestrator, `api/hangeul`, `api/status`, telegram | Hangeul portal |
| `tts-engine.ts` | Server voice: ElevenLabs → Edge TTS → `TtsUnavailableError` (page uses browser speech) | `api/tts` | ElevenLabs, edge-tts |
| `edge-tts.ts` | Microsoft Edge "Read Aloud" neural TTS over WebSocket (ported from the Python `edge-tts` 7.2.8 protocol) | tts-engine | `speech.platform.bing.com` |

## Server: other `src/lib/`

| Module | Does |
|---|---|
| `env.ts` | Reads every environment variable once; provider precedence; `configuredSearchProviders`, `configuredTtsEngines`, `hangeulLiveConfigured` |
| `auth.ts` | `requireAccess` (401 without the key; open if none configured), `hasValidAccessKey`, `isCronRequest`, `isTrustedRequest` (key or cron secret only) |
| `telegram.ts` | Bot API client (`sendMessage`, `getFile` download, `notifyAdmin`), command handling (`/start`, `/help`, `/status`, `/report`, `/search`, `/whoami`), admin-only gate, audit replay from Supabase, plain-text replies with the emote tag stripped |
| `memory/chunk.ts` | Splits Markdown by heading and JSONL by record into ≤1,500-char chunks; secret / ID-number filter; search terms |
| `memory/supabase.ts` | Minimal PostgREST client over `fetch` using the service-role key (no `supabase-js`, so it runs on Edge) |
| `memory/store.ts` | Upsert/list/pin/delete documents; `recallMemory` (pinned + `match_memory` full-text hits → prompt block); audit session state and log |
| `emote.ts` | The emote list, the `[emote:x]` protocol text added to every system prompt, `parseEmote` / `stripEmotes`, aliases (`excited` → `playful`) |
| `types.ts` | Shared request/response types and header names (no dependencies, any runtime) |
| `utils.ts` | JSON/error responses, timing-safe compare, data-URL checks, Hangul detection, header encoding |
| `abort.ts` | AbortSignal helpers that work on Vercel's Edge runtime |

## Client: hooks, components, `src/lib/client`, `src/lib/avatar`

| Area | Key pieces |
|---|---|
| Chat | `useJeannieChat` (sends history, reads the stream, peels the leading emote tag → `onEmote`, sends the last 24 messages, each ≤20k chars), `lib/client/api.ts` (fetch wrappers, access key in `localStorage`, timeouts, `ApiRequestError`) |
| Voice in | `useSpeechRecognition` (Web Speech API), `useHoldToTalk` (press-and-hold / tap-to-toggle) |
| Voice out | `useSpeechOutput` (plays `/api/tts` audio through an `AnalyserNode` for a real level, else browser `speechSynthesis` with a synthetic level), `lib/client/speech-text.ts` (speakable short version) |
| Images | `CameraScanner` (getUserMedia frame), `lib/client/image.ts` (≤1280 px JPEG) |
| Avatar | `useAvatarDirector` + `lib/avatar/director.ts` (state machine: idle sequence, talking, listening, one-shot emotes), `AvatarStage` (two crossfading `<video>`s, cuts on the neutral frame, warm-up downloads, voice-gated mouth via `lib/avatar/voice-gate.ts`), `lib/avatar/clips.ts` (clip table + manifest merge), `useIdleWatch` + `lib/avatar/idle.ts` (3-min spoken check-in), `EmotePicker` (preview-only QA) |
| Screens | `page.tsx` (wires everything), `AvatarScreen` (phone), `HudHeader`, `HudPanel`, `ChatTerminal`, `ChatComposer`, `ChatMessageView`, `Markdown`, `MemoryPanel`, `TacticalMetrics`, `ReactorCore`, `HologramOrb`, `VoiceVisualizer`, `IoTControlGrid`, `AvatarPanel` (desktop avatar frame) |
| State | `usePersistentState`, `useViewMode` + `lib/avatar/view-mode.ts`, `useLastSeen`, `useSystemStatus` (polls `/api/status`), `useMediaQuery`, `useNow`, `useCanvasLoop`, `useDialogFocus`, `AccessKeyDialog` |
| PWA | `ServiceWorkerRegister`, `public/sw.js`, `src/app/manifest.ts` |

## Scripts (developer machine only)

| Script | Does |
|---|---|
| `scripts/upload-memory.mjs` | Bulk-upload notes to `/api/memory` (`JEANNIE_URL`, `JEANNIE_ACCESS_KEY`) |
| `scripts/avatar-clips/ingest-kling.mjs` | Encode accepted Kling clips (720×1280, 24 fps, H.264) into `public/avatar/`, write the manifest with `?v=` versions and the talking clip's mouth-rest times |
| `scripts/avatar-clips/kling.mjs` | Which Kling clip ids ship, under which emote name; `CLIP_VERSION` |
| `scripts/avatar-clips/ffmpeg.mjs` | Shared ffmpeg helpers (encode, poster, frame count, mouth-rest detection) |
| `scripts/avatar-clips/build.mjs`, `plan.mjs` | Legacy layered clip builder (HyperFrames); refuses to overwrite Kling clips |
| `scripts/avatar-clips/gate.py` | Accept gate, see [python.md](python.md) |

## End-to-end traces

### A chat message (HUD or avatar)

1. `ChatComposer` / hold-to-talk → `useJeannieChat.send(text, image?)`.
2. `lib/client/api.ts` POSTs `/api/chat` with the recent history (last 24 messages), the image data URL and
   `x-jeannie-key`.
3. `api/chat/route.ts`: `requireAccess`, zod validation (≤50 messages, ≤20k chars each, image ≤3 MB),
   `isTrustedRequest`.
4. `runOrchestrator`: last 20 messages; `routeQuery` picks the agent; memory recall starts in parallel for
   trusted callers; the agent builds its system prompt (`persona.ts`) and calls the model (`llm.ts`), with
   tools for the core agent (`webSearch` → `readUrl` → answer, up to 4 steps).
5. The reply streams back as plain text; response headers carry agent, language, provider, honorific and
   up to 5 source links.
6. `useJeannieChat` peels the leading `[emote:x]` → `director.play(x)` → `AvatarStage` swaps the clip on
   the next neutral frame; the text renders without the tag.
7. On completion, if voice is on: `useSpeechOutput.speak` → `/api/tts` → audio plays; the director switches
   to `talking`, and the voice gate rests her mouth in pauses.

### Voice

Hold to talk → browser speech recognition (the vendor's service) → transcript → step 1 above. Release sends.
While listening, the avatar shows idle with a focus zoom; Jeannie's own voice is not spoken while the mic is
open, so she is not transcribed.

### Memory upload and recall

Memory panel / `memory:upload` → `POST /api/memory` (key required) → `chunk.ts` (refuses secrets/IDs, splits)
→ `upsert_memory_document` RPC (replaces a same-name file). On each trusted chat turn, `recallMemory` reads
up to 3 pinned notes and up to 6 full-text matches (`match_memory`) and adds them to the system prompt; if
Supabase is slow (over ~1.5 s) or down, the answer goes ahead without memory.

### Telegram

Telegram → `POST /api/telegram/webhook` (secret header) → `handleTelegramUpdate`: non-admin chats get a
"private" line; admin: commands, IoT fixed line, photo (`getFile` → data URL) or text → `runOrchestrator`
(trusted) → reply split into ≤4,000-character messages, emote tag stripped. A mistake audit stores the
pending reply in `jeannie_sessions` so "approve" / "reject" in the next message can be matched, and logs the
decision in `jeannie_audit_log`.

### Daily Hangeul report

Vercel cron 03:00 UTC → `GET /api/hangeul` with `Bearer $CRON_SECRET` → `getHangeulReport` (live only when
the portal is configured and `MOCK_MODE` is off; otherwise demo data) → `formatHangeulReport(…, "bilingual")`
→ `notifyAdmin` → Telegram admin chat.

## Tests

`tests/` holds one Vitest suite per module (about 30), all offline: API routes, orchestrator routing,
DeepSeek flows, memory chunking and store, Telegram and the audit flow, the IoT rule, search, read-url, TTS,
greeting and etiquette, the avatar director, clips, voice gate and PWA rules, and the Hangeul migration (run
for real in PGlite with pgvector). `edge-tts.live.test.ts` needs the network and is skipped by default.
