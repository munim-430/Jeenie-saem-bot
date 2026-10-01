# Project structure

**In plain words:** the app's code is under `src/`: `app/` is the page and the server routes, `components/` are
the pieces of the screen, `hooks/` are the screen's behaviours, and `lib/` is the logic underneath (the AI
agents, memory, the avatar's brain). `public/` holds files served as-is (the avatar videos), `scripts/` are
tools run by hand on a developer's computer, `supabase/` sets up the database, and `tests/` checks it all.

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
│   │       └── tts/  memory/  hangeul/  telegram/webhook/  (Node.js runtime)
│   ├── components/             UI: ChatTerminal, ChatComposer, ChatMessageView, Markdown,
│   │                           HudHeader, HudPanel, TacticalMetrics, ReactorCore, HologramOrb,
│   │                           VoiceVisualizer, IoTControlGrid, LanguageToggle, MemoryPanel,
│   │                           CameraScanner, AccessKeyDialog, AvatarScreen, AvatarPanel,
│   │                           AvatarStage, EmotePicker (preview-only QA), ServiceWorkerRegister
│   ├── hooks/                  useJeannieChat, useSpeechOutput, useSpeechRecognition,
│   │                           useHoldToTalk, useAvatarDirector, useIdleWatch, useSystemStatus,
│   │                           useViewMode, useLastSeen, usePersistentState, useMediaQuery,
│   │                           useNow, useCanvasLoop, useDialogFocus
│   └── lib/
│       ├── agents/             orchestrator + specialists (see codebase.md)
│       ├── memory/             chunking, Supabase REST client, store and recall
│       ├── avatar/             clip table, director state machine, idle watch, voice gate,
│       │                       view mode, QA picker gate
│       ├── client/             browser-side: API wrappers, image downscaling, speakable text
│       ├── env.ts              reads every environment variable in one place
│       ├── auth.ts             access-key / cron-secret checks
│       ├── telegram.ts         Telegram Bot API client + webhook handler
│       ├── emote.ts            the [emote:…] protocol between the model and the avatar
│       ├── types.ts  utils.ts  abort.ts
├── public/
│   ├── sw.js                   service worker (cache rules, see build-and-deploy.md)
│   ├── avatar/                 the shipped clips (*.mp4), posters (*.jpg), manifest.json
│   ├── icons/                  PWA icons
│   └── favicon.ico, audio/ (empty)
├── assets/avatar/              source material, not served
│   ├── source/                 NEUTRAL anchor image (fullbody.png) and reference sheets
│   └── kling/                  every generated Kling clip, clips.json (verdicts), qa/ contact sheets
├── scripts/                    developer tools (never run on Vercel)
│   ├── upload-memory.mjs       bulk upload notes to /api/memory
│   └── avatar-clips/           build.mjs, ingest-kling.mjs, kling.mjs, plan.mjs, ffmpeg.mjs, gate.py
├── supabase/migrations/        4 SQL files: memory tables, revoke public access,
│                               hangeul_context (planned hg_* tables), service-role grant
├── tests/                      ~30 Vitest suites (one per module; *.live.test.ts need network)
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
- `scripts/avatar-clips/.work/` and `memory/` are gitignored.
