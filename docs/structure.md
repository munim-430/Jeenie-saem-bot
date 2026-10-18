# Project structure

**In plain words:** the app's code is under `src/`: `app/` is the page and the server routes, `components/` are
the pieces of the screen, `hooks/` are the screen's behaviours, and `lib/` is the logic underneath (the AI
agents, memory, the Hangeul data reader, the avatar's brain). `public/` holds files served as-is (the avatar
videos), `scripts/` are tools run by hand on a developer's computer, `supabase/` sets up the database (and one
Edge Function), and `tests/` checks it all.

```
Jeenie-saem-bot/
├── src/
│   ├── app/                    Next.js App Router
│   │   ├── page.tsx            the only page: HUD (desktop) or avatar screen (phone)
│   │   ├── layout.tsx          HTML shell, fonts, service worker registration
│   │   ├── manifest.ts         PWA manifest (/manifest.webmanifest)
│   │   ├── globals.css         Tailwind + HUD/avatar styles
│   │   └── api/                server routes, see site-map.md
│   │       ├── chat/  session/  search/  status/       (Edge runtime)
│   │       ├── tts/  memory/  telegram/webhook/         (Node.js runtime)
│   │       └── hangeul/  (status) and hangeul/{snapshot,changes,runs,ask}/  (Node.js runtime)
│   ├── components/             UI: ChatTerminal, ChatComposer, ChatMessageView, Markdown,
│   │                           HudHeader, HudPanel, TacticalMetrics, ReactorCore, HologramOrb,
│   │                           VoiceVisualizer, IoTControlGrid, LanguageToggle, MemoryPanel,
│   │                           CameraScanner, AccessKeyDialog, AvatarScreen, AvatarPanel,
│   │                           AvatarStage, WardrobeButton, EmotePicker (preview-only QA),
│   │                           ServiceWorkerRegister, OfflineBanner, HangeulSyncPanel,
│   │                           HangeulSyncNotice
│   ├── hooks/                  useJeannieChat, useSpeechOutput, useSpeechRecognition,
│   │                           useHoldToTalk, useAvatarDirector, useIdleWatch, useSystemStatus,
│   │                           useViewMode, useLastSeen, usePersistentState, useMediaQuery,
│   │                           useNow, useCanvasLoop, useDialogFocus, useOnlineStatus,
│   │                           useHangeulLocal (the Hangeul device copy)
│   └── lib/
│       ├── agents/             orchestrator + specialists (see codebase.md)
│       ├── hangeul/            Hangeul BOT's data: router, answer (isomorphic, code-built
│       │                       answers), store (PostgREST reads), respond, filter, days,
│       │                       vectors, memory-readers, http (route gate), types
│       ├── memory/             chunking, Supabase REST client, store and recall
│       ├── avatar/             clip table, director state machine, idle watch, voice gate,
│       │                       view mode, QA picker gate
│       ├── client/             browser-side: API wrappers, image downscaling, speakable text,
│       │   │                   reachability (offline banner), audio URL
│       │   └── hg-local/       the Hangeul device copy: db (IndexedDB), sync, search, check,
│       │                       ask, readers, device, embedder + embed.worker, ort-runtime
│       ├── env.ts              reads every environment variable in one place
│       ├── auth.ts             access-key / cron-secret checks
│       ├── telegram.ts         Telegram Bot API client + webhook handler
│       ├── emote.ts            the [emote:…] protocol between the model and the avatar
│       ├── types.ts  utils.ts  abort.ts
├── public/
│   ├── sw.js                   service worker (cache rules, see build-and-deploy.md)
│   ├── avatar/                 the shipped clips (*.mp4), posters (*.jpg), manifest.json
│   ├── icons/                  PWA icons
│   ├── ort/                    gitignored: onnxruntime-web WASM runtime, copied by copy-ort.mjs
│   └── favicon.ico, audio/ (empty)
├── assets/avatar/              source material, not served
│   ├── source/                 NEUTRAL anchor image (fullbody.png) and reference sheets
│   └── kling/                  every generated Kling clip, clips.json (verdicts), qa/ contact sheets
├── scripts/                    developer tools (never run on Vercel, except copy-ort.mjs in the build)
│   ├── upload-memory.mjs       bulk upload notes to /api/memory
│   ├── copy-ort.mjs            copies the embedder's WASM runtime to public/ort/ (predev, prebuild)
│   └── avatar-clips/           build.mjs, ingest-kling.mjs, kling.mjs, plan.mjs, ffmpeg.mjs, gate.py
├── supabase/
│   ├── migrations/             4 SQL files: memory tables, revoke public access,
│   │                           hangeul_context (the hg_* tables Hangeul BOT publishes to),
│   │                           service-role grant
│   └── functions/hg-embed/     Edge Function: question embeddings (gte-small) for Hangeul search
├── tests/                      ~40 Vitest suites (one per module; *.live.test.ts need network)
├── docs/                       these docs, adr/ (decisions), agents/ (issue-tracker conventions)
├── .scratch/                   local issue tracker and specs (ani-companion/, hangeul-cloud-context/)
├── .claude/                    Claude Code settings and installed skills (third-party, dev tooling)
├── memory/                     gitignored: personal notes kept locally for memory:upload
├── CONTEXT.md                  avatar glossary;  CLAUDE.md: agent instructions
├── README.md                   setup, configuration, API summary
├── next.config.mjs  vercel.json  tailwind.config.ts  postcss.config.mjs
├── eslint.config.mjs  tsconfig.json  vitest.config.mts
├── .env.example                every variable name, no values
├── .mcp.json                   read-only Supabase MCP server for maintenance
└── skills-lock.json            pinned versions of the installed skills
```

Notes:

- `reference` at the repo root is an empty tracked file (1 byte) with no role in the build.
- `scripts/avatar-clips/.work/`, `memory/` and `public/ort/` are gitignored.
