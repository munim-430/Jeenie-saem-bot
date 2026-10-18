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
| `tts-engine.ts` | Server voice: ElevenLabs → Edge TTS → `TtsUnavailableError` (page uses browser speech) | `api/tts` | ElevenLabs, edge-tts |
| `edge-tts.ts` | Microsoft Edge "Read Aloud" neural TTS over WebSocket (ported from the Python `edge-tts` 7.2.8 protocol) | tts-engine | `speech.platform.bing.com` |

## Server and shared: `src/lib/hangeul/`

Hangeul BOT's data, read from Supabase. Jeannie never talks to the Hangeul portal and never writes these tables.
Modules marked *isomorphic* also run in the browser against the device copy. Question embeddings for server-side
search come from the `hg-embed` Supabase Edge Function (`supabase/functions/hg-embed/index.ts`: the Edge
Runtime's built-in gte-small; it checks the secret key itself and is deployed by hand).

| Module | Does | Called by | Calls |
|---|---|---|---|
| `router.ts` | *Isomorphic.* Whole-word rules that map a question to a query plan (`classify`, `isHangeulContextQuery`); "Hangeul" alone is also the Korean alphabet, so each intent needs its domain noun. Bounded patterns, linear in the input | answer, orchestrator | days |
| `answer.ts` | *Isomorphic.* `planFor` → `runPlan` (reads rows through a `HangeulReaders`) → facts, tables, notes and an "as of" line dated by `hg_runs` (`renderAnswer`). An unread kind is "not available yet", never 0. `factsForModel` (what the model sees), `checkProse` (drops a sentence holding a number not in the facts) | respond, `hg-local/ask.ts` | router, days |
| `respond.ts` | One answer end to end (`answerHangeul`): plan → code-built facts → at most two model sentences (8 s cap) → number check; Korean/Bangla search questions are first rewritten into English by the model. Without a model, the facts alone | orchestrator, `api/hangeul/ask`, telegram `/report` (no model) | answer, persona, the model passed in |
| `store.ts` | Read-only PostgREST over `fetch` with the server-only key (Edge-safe): records, runs, change log, snapshot pages (~3 MB), `hg_match` vector search, `embedQuestion` (hg-embed), status counts; `createHangeulStore` is the server's readers. 3 s timeouts (15 s bulk); fails closed with a plain reason, never an empty list | orchestrator, telegram, `api/hangeul/*`, `api/status` | Supabase, hg-embed, filter |
| `http.ts` | The `/api/hangeul/*` gate (403 no key configured, 401 not presented, 503 no Supabase) and error mapping | `api/hangeul/*` | auth, env |
| `filter.ts` | *Isomorphic.* What a record filter means, so the server and the device answer from the same rows | store, `hg-local/readers.ts` | — |
| `memory-readers.ts` | *Isomorphic.* Readers over rows already in memory | tests | filter |
| `days.ts`, `vectors.ts`, `types.ts` | *Isomorphic.* Business days in `JEANNIE_TIMEZONE`; 384-d vectors as base64 float32; the record kinds (`HG_KINDS`) and shapes | everywhere above | — |

## Server: other `src/lib/`

| Module | Does |
|---|---|
| `env.ts` | Reads every environment variable once; provider precedence; `hangeul.enabled` (the Supabase pair) and `hangeul.embedUrl`; `configuredSearchProviders`, `configuredTtsEngines` |
| `auth.ts` | `requireAccess` (401 without the key; open if none configured), `hasValidAccessKey` (what the Hangeul data needs), `isCronRequest`, `isTrustedRequest` (key or cron secret only; memory) |
| `telegram.ts` | Bot API client (`sendMessage`, `getFile` download, `notifyAdmin`), command handling (`/start`, `/help`, `/status`, `/report` (the Hangeul daily brief, code-built, no model), `/search`, `/whoami`), admin-only gate, audit replay from Supabase, plain-text replies with the emote tag stripped |
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
| Voice out | `useSpeechOutput` (plays `/api/tts` audio through an `AnalyserNode` for a real level, else browser `speechSynthesis` with a synthetic level), `lib/client/speech-text.ts` (speakable short version; `spokenText` turns a Hangeul reply into a fixed line, so student data never reaches the voice engines) |
| Images | `CameraScanner` (getUserMedia frame), `lib/client/image.ts` (≤1280 px JPEG) |
| Avatar | `useAvatarDirector` + `lib/avatar/director.ts` (state machine: idle sequence, talking, listening, one-shot emotes), `AvatarStage` (two crossfading `<video>`s, cuts on the neutral frame, warm-up downloads, voice-gated mouth via `lib/avatar/voice-gate.ts`), `lib/avatar/clips.ts` (clip table + manifest merge), `useIdleWatch` + `lib/avatar/idle.ts` (3-min spoken check-in), `EmotePicker` (preview-only QA), `WardrobeButton` (outfit menu; `lib/avatar/clips.ts` `OUTFITS`, `clipNameFor(emote, outfit)`) |
| Screens | `page.tsx` (wires everything), `AvatarScreen` (phone), `HudHeader`, `HudPanel`, `ChatTerminal`, `ChatComposer`, `ChatMessageView`, `Markdown`, `MemoryPanel`, `TacticalMetrics`, `ReactorCore`, `HologramOrb`, `VoiceVisualizer`, `IoTControlGrid`, `AvatarPanel` (desktop avatar frame) |
| State | `usePersistentState`, `useViewMode` + `lib/avatar/view-mode.ts`, `useLastSeen`, `useSystemStatus` (polls `/api/status`), `useMediaQuery`, `useNow`, `useCanvasLoop`, `useDialogFocus`, `AccessKeyDialog` |
| Hangeul device copy | `useHangeulLocal` (schedules everything below; only where the server serves the data), `lib/client/hg-local/`: `db.ts` (IndexedDB `jeannie-hg`: records, chunks, meta), `sync.ts` (snapshot pages, then runs and the change log), `ask.ts` (answer a structured question on the device, or send hints to the server), `search.ts` (brute-force cosine over local vectors), `embedder.ts` + `embed.worker.ts` (transformers.js gte-small in a Web Worker; runtime from `/ort/` via `ort-runtime.ts`), `check.ts` (embed-model check), `readers.ts`, `device.ts` ("Delete local copy" across tabs); `HangeulSyncPanel` (HUD), `HangeulSyncNotice` (avatar screen) |
| Offline | `useOnlineStatus` + `lib/client/reachability.ts` (browser flag plus API reachability, re-probing `/api/status`), `OfflineBanner`; the input is disabled, there are no offline answers |
| PWA | `ServiceWorkerRegister`, `public/sw.js`, `src/app/manifest.ts` |

## Scripts (developer machine only, except `copy-ort.mjs`)

| Script | Does |
|---|---|
| `scripts/upload-memory.mjs` | Bulk-upload notes to `/api/memory` (`JEANNIE_URL`, `JEANNIE_ACCESS_KEY`) |
| `scripts/copy-ort.mjs` | Copies onnxruntime-web's WASM runtime from `node_modules` to `public/ort/` (files listed in `hg-local/ort-files.json`) so the embedder never loads code from a CDN. Runs as `predev` / `prebuild`, so also in Vercel's build |
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

### A Hangeul question

1. `useJeannieChat.send` → `prepareHangeul` (`page.tsx`) → `useHangeulLocal.prepare` → `hg-local/ask.ts`.
   Not a Hangeul question: the chat goes on as usual. A structured question, with a copy synced in the last
   6 minutes that holds the bot's runs, renders on the device with `answer.ts` when it finds something: no
   request at all, no model.
   A search question is embedded in the worker and searched over the local vectors; the vector and the top
   records (kind and key only) ride along as `hangeul` in the `/api/chat` body. Everything else goes as a
   plain question.
2. `api/chat` (Edge) passes `hangeulAccess: hasValidAccessKey(req)` (never the cron bearer) →
   `routeQuery` → `isHangeulContextQuery` → `runHangeul`: without the key a fixed "needs the access key" line,
   without Supabase a "not configured" line.
3. `answerHangeul` (`respond.ts`): `planFor` → `runPlan` reads rows through `createHangeulStore`. Search uses
   the device's vector, else `embedQuestion` (hg-embed), then `hg_match`; device hits are re-read from current
   rows.
4. `renderAnswer` → facts, tables, notes, "as of" line. With a model, the `factsForModel` JSON goes into the
   Hangeul system prompt and at most two sentences come back; `checkProse` drops any with a number the facts
   do not hold. The reply is sent whole (not streamed), agent `hangeul`.
5. Voice on: `spokenText` speaks a fixed line instead of the answer.

Telegram: `/report` → `answerHangeul` for "Hangeul daily report" with no model → admin chat. A free-text
Hangeul question in the admin chat goes through step 2 onwards (the admin chat counts as having access).

### Hangeul device sync

`useHangeulLocal` (only when `/api/status` says Hangeul is configured, the server requires a key, and this
browser has one): first sync pages `/api/hangeul/snapshot` (asking first on mobile data), one IndexedDB
transaction per page, resumable; then `/api/hangeul/runs` and `/api/hangeul/changes?since=` on open, on
focus, every 5 minutes and when the connection changes; tabs take turns (Web Locks). Once, `check.ts` embeds
three stored chunk texts on the device: a cosine below 0.98 against the bot's vectors keeps search on the server.
"Delete local copy" (`device.ts`) clears the store and stops syncing in every tab of the origin.

## Tests

`tests/` holds one Vitest suite per module (about 40), all offline: API routes, orchestrator routing,
DeepSeek flows, memory chunking and store, Telegram and the audit flow, the IoT rule, search, read-url, TTS,
greeting and etiquette, the avatar director, clips, voice gate and PWA rules, offline controls, the Hangeul
migration (run for real in PGlite with pgvector), the Hangeul router, answers, store and routes, `hg-embed`,
and the device copy (an in-memory IndexedDB shim; synthetic data only, `tests/hangeul-fixtures.ts`).
`edge-tts.live.test.ts` needs the network and is skipped by default.
