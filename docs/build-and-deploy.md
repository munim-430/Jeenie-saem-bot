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
| Tests | Vitest; PGlite + pgvector run the SQL migrations in memory |
| Hosting | Vercel (functions + one cron) |
| Database | Supabase Postgres (only for memory and audit state today) |

## npm scripts

| Command | What it does |
|---|---|
| `npm run dev` | Local dev server on `http://localhost:3000` |
| `npm run build` / `npm start` | Production build / serve it locally |
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
   Hangeul shows demo data.
3. `npm run dev`

## Environment variables (names only)

Read by `src/lib/env.ts`; the full descriptions are in the README's Configuration table.

| Group | Variables | Used for |
|---|---|---|
| App | `NEXT_PUBLIC_APP_NAME`, `NEXT_PUBLIC_VOICE_NAME` | Display names |
| Access | `JEANNIE_ACCESS_KEY` | The shared secret for every `/api` route except `/api/status` |
| Access | `CRON_SECRET` | Lets Vercel Cron call `/api/hangeul` |
| Time | `JEANNIE_TIMEZONE` | Greeting time of day (default `Asia/Dhaka`) |
| Language model | `LLM_PROVIDER`; `DEEPSEEK_API_KEY`, `DEEPSEEK_MODEL`, `DEEPSEEK_VISION_MODEL`, `DEEPSEEK_BASE_URL`; `ANTHROPIC_API_KEY`, `ANTHROPIC_MODEL`, `ANTHROPIC_VISION_MODEL`; `OPENAI_API_KEY`, `OPENAI_BASE_URL`, `DEFAULT_MODEL`, `VISION_MODEL`; `OLLAMA_BASE_URL`, `OLLAMA_MODEL`, `OLLAMA_VISION_MODEL` | Which model answers. With no `LLM_PROVIDER`: DeepSeek, then Claude, then OpenAI, then Ollama, whichever has a key |
| Search | `DEEPSEEK_ANTHROPIC_BASE_URL`, `DEEPSEEK_SEARCH_MODEL`, `TAVILY_API_KEY`, `GOOGLE_CSE_API_KEY`, `GOOGLE_CSE_ID` | Live web search chain |
| Voice | `ELEVENLABS_API_KEY`, `ELEVENLABS_VOICE_ID`, `ELEVENLABS_MODEL_ID`, `EDGE_TTS_ENABLED`, `EDGE_TTS_VOICE_EN`, `EDGE_TTS_VOICE_KO`, `EDGE_TTS_VOICE_MIXED` | Server voice |
| Memory | `SUPABASE_URL` (or `NEXT_PUBLIC_SUPABASE_URL`), `SUPABASE_SERVICE_ROLE_KEY` (or `SUPABASE_SECRET_KEY`) | Supabase memory; must be the server-only secret key |
| Telegram | `TELEGRAM_BOT_TOKEN`, `TELEGRAM_ADMIN_CHAT_ID`, `TELEGRAM_WEBHOOK_SECRET` | Telegram bot |
| Hangeul | `HANGEUL_BASE_URL`, `HANGEUL_USERNAME`, `HANGEUL_PASSWORD`, `HANGEUL_REPORT_PATH`, `HANGEUL_STATUS_PATH`, `MOCK_MODE` | Admin-portal report (demo data when unset) |
| Scripts only | `JEANNIE_URL`, `JEANNIE_ACCESS_KEY`, `FFMPEG` | `upload-memory.mjs`, avatar scripts |

`NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` appears in `.env.example` but the app does not read it.
`NEXT_PUBLIC_DEPLOY_ENV` is set by `next.config.mjs` from `VERCEL_ENV` (preview-only QA picker).

## Vercel

- **Deploys:** every push builds. A branch gets a preview URL behind Vercel login; `main` is production.
- **Runtimes:**
  - Edge: `/api/chat`, `/api/session`, `/api/search`, `/api/status`.
  - Node.js: `/api/tts` (Edge TTS needs `ws`), `/api/memory`, `/api/hangeul`, `/api/telegram/webhook`.
- **Cron:** `vercel.json` calls `/api/hangeul` daily at `0 3 * * *` (03:00 UTC, 09:00 in Dhaka) with
  `Authorization: Bearer $CRON_SECRET`; the route sends the report to the Telegram admin chat.
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
- `sw.js` (cache `jeannie-v3`):
  - `/api/*` is network only and never cached;
  - `/avatar/*` and `/icons/*` are cache-first;
  - `/_next/static/*` is stale-while-revalidate;
  - pages are network-first, falling back to the cached shell offline.
- Bump `VERSION` in `sw.js`, and `CLIP_VERSION` in `src/lib/avatar/clips.ts` and `scripts/avatar-clips/kling.mjs`
  when clips change, so phones fetch the new files.

## Supabase

Apply `supabase/migrations/*.sql` in order (Supabase SQL editor or CLI). They create the memory and audit tables
and the planned `hg_*` Hangeul tables, all locked to the service-role key. `.mcp.json` points a read-only
Supabase MCP server at the project for maintenance.

## Checks before a release

There is no CI. Run locally before pushing:

```
npm run typecheck && npm run lint && npm test && npm run build
```

Avatar clip changes also go through the accept gate (`scripts/avatar-clips/gate.py`, see [python.md](python.md)).
