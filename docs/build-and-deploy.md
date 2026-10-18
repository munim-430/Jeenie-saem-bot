# Build and deploy

**In plain words:** Jeannie is a Next.js web app written in TypeScript. You push code to GitHub. Vercel
builds it automatically: every branch gets a private "preview" link, and merging into `main` updates the live
site at `jeenie-saem-bot.vercel.app` within a couple of minutes. Secrets such as API keys live in Vercel's
settings, never in the code. If a release goes wrong, Vercel can switch back to the previous one instantly.

## Stack

| Part | Choice |
|---|---|
| Runtime | Node.js 22.x (`package.json` `engines`) |
| Framework | Next.js 15 (App Router), React 19 |
| Language | TypeScript 5.9, validated input with zod 4 |
| AI | Vercel AI SDK (`ai`) with `@ai-sdk/deepseek`, `@ai-sdk/anthropic`, `@ai-sdk/openai` |
| UI | Tailwind CSS 3, framer-motion, lucide-react icons |
| Voice | `ws` (Microsoft Edge TTS WebSocket client) |
| Device search | `@huggingface/transformers` (transformers.js) running `Supabase/gte-small` in a Web Worker on onnxruntime-web (WASM) |
| Tests | Vitest; PGlite + pgvector run the SQL migrations in memory |
| Hosting | Vercel (functions; no cron) |
| Database | Supabase Postgres: memory and audit state, plus the `hg_*` Hangeul tables that Hangeul BOT writes and Jeannie only reads; one Edge Function, `hg-embed` |

## npm scripts

| Command | What it does |
|---|---|
| `npm run dev` | Local dev server on `http://localhost:3000` (runs `scripts/copy-ort.mjs` first) |
| `npm run build` / `npm start` | Production build (runs `scripts/copy-ort.mjs` first, on Vercel too) / serve it locally |
| `npm run lint` | ESLint over the repo |
| `npm run typecheck` | `next typegen` then `tsc --noEmit` |
| `npm test` | All Vitest suites (`tests/`); `*.live.test.ts` need network and are skipped by default |
| `npm run memory:upload -- <files> [--pin]` | Upload `.md`/`.jsonl` notes to memory through `/api/memory` |
| `npm run avatar:clips` | Legacy avatar clip build (refuses to overwrite the Kling set without `--force`) |
| `npm run avatar:ingest` | Encode the accepted Kling clips into `public/avatar/` and update the manifest |

## Local setup

1. `npm install`
2. Copy `.env.example` to `.env.local` and fill in what you need. With no keys at all the app still runs:
   the chat says no model is connected, search falls back to DuckDuckGo, voice falls back to the browser,
   and a Hangeul question gets a line saying the data needs the access key. Hangeul answers need
   `SUPABASE_URL`, the Supabase secret key and `JEANNIE_ACCESS_KEY` (not a language model).
3. `npm run dev`

## Environment variables (names only)

Read by `src/lib/env.ts`; the full descriptions are in the README's Configuration table.

| Group | Variables | Used for |
|---|---|---|
| App | `NEXT_PUBLIC_APP_NAME`, `NEXT_PUBLIC_VOICE_NAME` | Display names |
| Access | `JEANNIE_ACCESS_KEY` | The shared secret for every `/api` route except `/api/status`; the Hangeul data needs it set and presented |
| Access | `CRON_SECRET` | Optional: a caller with `Authorization: Bearer $CRON_SECRET` is trusted for memory (for a cron you add; `vercel.json` schedules none). Never unlocks the Hangeul data |
| Time | `JEANNIE_TIMEZONE` | Greeting time of day and the Hangeul business day (default `Asia/Dhaka`) |
| Greeting | `MOCK_MODE` | `true`: the session greeting uses its template instead of the model |
| Language model | `LLM_PROVIDER`; `DEEPSEEK_API_KEY`, `DEEPSEEK_MODEL`, `DEEPSEEK_VISION_MODEL`, `DEEPSEEK_BASE_URL`; `ANTHROPIC_API_KEY`, `ANTHROPIC_MODEL`, `ANTHROPIC_VISION_MODEL`; `OPENAI_API_KEY`, `OPENAI_BASE_URL`, `DEFAULT_MODEL`, `VISION_MODEL`; `OLLAMA_BASE_URL`, `OLLAMA_MODEL`, `OLLAMA_VISION_MODEL` | Which model answers. With no `LLM_PROVIDER`: DeepSeek, then Claude, then OpenAI, then Ollama, whichever has a key |
| Search | `DEEPSEEK_ANTHROPIC_BASE_URL`, `DEEPSEEK_SEARCH_MODEL`, `TAVILY_API_KEY`, `GOOGLE_CSE_API_KEY`, `GOOGLE_CSE_ID` | Live web search chain |
| Voice | `ELEVENLABS_API_KEY`, `ELEVENLABS_VOICE_ID`, `ELEVENLABS_MODEL_ID`, `EDGE_TTS_ENABLED`, `EDGE_TTS_VOICE_EN`, `EDGE_TTS_VOICE_KO`, `EDGE_TTS_VOICE_MIXED` | Server voice |
| Memory and Hangeul | `SUPABASE_URL` (or `NEXT_PUBLIC_SUPABASE_URL`), `SUPABASE_SERVICE_ROLE_KEY` (or `SUPABASE_SECRET_KEY`) | Supabase memory and the Hangeul data (one project); must be the server-only secret key. The `hg-embed` URL is derived from `SUPABASE_URL` |
| Telegram | `TELEGRAM_BOT_TOKEN`, `TELEGRAM_ADMIN_CHAT_ID`, `TELEGRAM_WEBHOOK_SECRET` | Telegram bot |
| Scripts only | `JEANNIE_URL`, `JEANNIE_ACCESS_KEY`, `FFMPEG` | `upload-memory.mjs`, avatar scripts |

`NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` appears in `.env.example` but the app does not read it.
`HANGEUL_BASE_URL`, `HANGEUL_USERNAME`, `HANGEUL_PASSWORD`, `HANGEUL_REPORT_PATH` and `HANGEUL_STATUS_PATH` are
no longer read (Jeannie never talks to the portal); old values left in Vercel do nothing and can be deleted.
`NEXT_PUBLIC_DEPLOY_ENV` is set by `next.config.mjs` from `VERCEL_ENV` (preview-only QA picker).

## Vercel

- **Deploys:** every push builds. A branch gets a preview URL behind Vercel login; `main` is production.
- **Runtimes:**
  - Edge: `/api/chat`, `/api/session`, `/api/search`, `/api/status`.
  - Node.js: `/api/tts` (Edge TTS needs `ws`), `/api/memory`, `/api/hangeul` and `/api/hangeul/*`,
    `/api/telegram/webhook`.
- **Cron:** none. `vercel.json` schedules no job (the old daily `/api/hangeul` report push is gone); the
  Hangeul daily brief is `/report` in the Telegram admin chat, or the HUD's daily-report quick command.
- **Headers** (`next.config.mjs`, every path):
  - `X-Content-Type-Options: nosniff`;
  - `Referrer-Policy: strict-origin-when-cross-origin`;
  - `X-Frame-Options: DENY`;
  - `Permissions-Policy: camera=(self), microphone=(self), geolocation=()`.
- **Rollback:** Vercel → project → Deployments → the previous production deployment → ⋯ → **Promote**.
- **Secrets:** set in Vercel → Settings → Environment Variables. A changed value applies only after a redeploy.

## PWA and caching

- `src/app/manifest.ts` makes the app installable; `src/components/ServiceWorkerRegister.tsx` registers
  `public/sw.js`.
- `sw.js` (cache `jeannie-v4`):
  - `/api/*` is network only and never cached, so no student data ever enters this cache (the Hangeul copy
    lives in IndexedDB `jeannie-hg`);
  - `/avatar/*` and `/icons/*` are cache-first;
  - `/_next/static/*` is stale-while-revalidate;
  - pages are network-first, falling back to the cached shell offline;
  - transformers.js's own `transformers-cache` (the search model, the `/ort/` runtime) is left alone.
- Offline, the page shows a banner and disables the input (`OfflineBanner`, `useOnlineStatus`); Jeannie never
  answers from the device copy offline.
- Bump `VERSION` in `sw.js`, and `CLIP_VERSION` in `src/lib/avatar/clips.ts` and `scripts/avatar-clips/kling.mjs`
  when clips change, so phones fetch the new files.

## Supabase

Apply `supabase/migrations/*.sql` in order (Supabase SQL editor or CLI). They create the memory and audit tables
and the `hg_*` Hangeul tables (with `hg_sync`, which Hangeul BOT writes through, and `hg_match` /
`hg_changes_since`, which Jeannie reads through), all locked to the service-role key. `.mcp.json` points a
read-only Supabase MCP server at the project for maintenance.

The `hg-embed` Edge Function (`supabase/functions/hg-embed/`) is deployed by hand with
`supabase functions deploy hg-embed --no-verify-jwt` (the flag is required: the function checks the secret key
itself). Until it is deployed, a Hangeul search question that arrives without a vector from the device gets
"search not available"; structured answers never need it. Details and a smoke test: the README's "Hangeul
question embeddings" section.

## Checks before a release

There is no CI. Run locally before pushing:

```
npm run typecheck && npm run lint && npm test && npm run build
```

Avatar clip changes also go through the accept gate (`scripts/avatar-clips/gate.py`, see [python.md](python.md)).
