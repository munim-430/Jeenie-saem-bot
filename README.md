# Jeannie · Bilingual Multimodal Personal AI

Jeannie is a J.A.R.V.I.S.-style personal AI with a neon-pink holographic HUD. She speaks English and
Korean (한국어), sees through your camera, searches the live web, talks back with a neural voice,
reports on your Hangeul admin portal, and answers every smart-home command with instant composure.

| Layer | Service |
| --- | --- |
| **Brain** | [DeepSeek](https://platform.deepseek.com) (`deepseek-v4-flash`, thinking off for quick spoken replies). Images go to Claude or OpenAI when their key is set, else to DeepSeek's `deepseek-v4-flash-vision-exp`. Claude, OpenAI or Ollama still work as alternatives. |
| **Voice** | [ElevenLabs](https://elevenlabs.io) (`eleven_multilingual_v2`, English + Korean), with free Edge and browser voices as fallbacks. |
| **Memory** | [Supabase](https://supabase.com): markdown and JSON Lines notes you upload, searched with Postgres full-text search on every message. |

Built with Next.js 15 (App Router, TypeScript), Tailwind CSS, Framer Motion, the Vercel AI SDK, and
Canvas-based holographic visualizers. Ready for Vercel with zero extra configuration.

## Features

| Agent | What it does |
| --- | --- |
| **Orchestrator (Jeannie Core)** | Reads each text, voice, or image prompt and routes it to one specialist. |
| **IoT Interceptor** | Any smart-home or IoT command or query gets exactly `Yes, it is done.` (`네, 처리되었습니다.` in Korean). No tools, no LLM. |
| **Live Search Agent** | Time-sensitive or fact-checking questions go to DeepSeek's native web search (same `DEEPSEEK_API_KEY`), then Tavily and Google Custom Search if configured, then DuckDuckGo. The results are summarized with inline `[n]` citations. |
| **Vision & Localization Agent** | Image attachments (documents, screenshots, camera frames) get a structured bilingual analysis, with visible text transcribed and translated. |
| **Hangeul Admin Bridge** | Fetches admin reports and status checks from the Hangeul portal on demand. Uses mock data when live access isn't configured, and sends a daily report to Telegram. |
| **Mistake Audit Agent** | "Audit this for mistakes", "실수 점검해줘": answers in a fixed frame (Issue · Cause · Recommendation) and asks for approval. "승인" / "approve" gets a standard execution confirmation; "취소" / "cancel" puts it on hold. |
| **General Cognitive Agent** | Handles everything else and can call web search on its own. |

Also included:

- **Voice out:** ElevenLabs first, then Microsoft Edge neural voices (`en-US-JennyNeural`, `ko-KR-SunHiNeural`, no API key needed), then the browser's built-in speech. The audio drives the orb and the spectrum visualizer.
- **Voice in:** push-to-talk speech recognition in English or Korean, using the browser's Web Speech API.
- **HUD:** a canvas arc-reactor orb, a spectrum analyzer, a translucent chat terminal, tactical telemetry, IoT control tiles, and a camera scanner.
- **Telegram bridge:** two-way bot. Chat with Jeannie, send photos for analysis, run `/report`, `/search`, and `/status`.
- **Language modes:** Auto-detect, English, Korean, or bilingual (English then Korean). You can also ask for "both languages" in any message.
- **Honorifics:** replies call you 부장님 by default and 자기야 when the message is personal (tiredness, missing her, good night). Audit, Hangeul, search, vision and smart-home replies always use 부장님. Greetings use 부장님 from 09:00 to 18:00 local time and 자기야 otherwise.
- **Session greeting:** a new HUD session opens with a short Korean greeting written by the model for your local time of day and how long you were away, with the template greeting (좋은 아침입니다 05–11, 좋은 오후입니다 12–17, 좋은 저녁입니다 18–21, 늦은 시간까지 수고 많으십니다 at night) as the fallback. Telegram `/start` uses the template greeting. Set `JEANNIE_TIMEZONE` (default `Asia/Dhaka`).
- **Memory:** upload `.md` and `.jsonl` files from the HUD's Memory panel. Pinned notes (like your profile) are always in her prompt; the rest are recalled when a message matches them.

## Quick start

```bash
npm install
cp .env.example .env.local   # every key is optional; see below
npm run dev                  # http://localhost:3000
```

With no keys at all, Jeannie still runs in offline mode. IoT confirmations, live search (DuckDuckGo),
Edge neural voice, camera, and the mock Hangeul report all work. Add `DEEPSEEK_API_KEY` for full reasoning.
For image analysis, also add `ANTHROPIC_API_KEY` (Claude) or `OPENAI_API_KEY`, or run [Ollama](https://ollama.com)
with a vision model.

| Script | Purpose |
| --- | --- |
| `npm run dev` | Start the local dev server |
| `npm run build` / `npm start` | Build and serve for production |
| `npm test` | Unit and route tests (Vitest) |
| `npm run lint` / `npm run typecheck` | ESLint and TypeScript checks |
| `npm run memory:upload -- <files> [--pin]` | Upload notes to memory through `/api/memory` (uses `JEANNIE_URL` and `JEANNIE_ACCESS_KEY`) |

## Memory (Supabase)

1. **Create the tables.** Open your Supabase project → **SQL Editor**, paste
   [`supabase/migrations/20260928000000_jeannie_memory.sql`](supabase/migrations/20260928000000_jeannie_memory.sql)
   and run it (or `supabase db push` with the Supabase CLI).
   - Every table has row-level security on and no policies. The public anon key can't read anything; only the server's
     service-role key can.
2. **Set the keys.** Set `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY`. They're under **Project Settings → API**; use
   the `service_role` or `sb_secret_…` key, never with a `NEXT_PUBLIC_` prefix. Also set `JEANNIE_ACCESS_KEY`: memory is
   never used or editable without it, because the notes are personal.
3. **Upload notes.** In the HUD's **Memory** panel, tick **PIN** for your profile, then pick the files. Or use the CLI:
   ```bash
   npm run memory:upload -- memory/profile.md --pin
   npm run memory:upload -- memory/saemur-knowledge.jsonl
   ```
   - `.md` files are split by heading.
   - `.jsonl` files keep one record per note (`{id, type, title, text, tags, entity, updated}`), so re-uploading
     replaces them by file name.
   - Files that look like they contain API keys, tokens or ID numbers are refused.
   - `memory/` is gitignored, so personal notes stay out of the repo.

**How recall works.** Each message is reduced to search terms: stopwords are dropped and Korean particles are
stripped, so "HGLC는 어디에 있어?" becomes `hglc`. The terms are prefix-matched against the notes' titles, tags and
text. The best matches, plus the pinned notes, are added to the prompt as reference data. This happens for the HUD with
a valid access key and for the Telegram admin chat, and never for an open deployment. If Supabase is slow (over 1.5 s)
or down, Jeannie answers without memory.

`.mcp.json` registers the project's read-only Supabase MCP server for Claude Code (`claude /mcp` to authenticate).

## Deploy to Vercel

1. **Merge to `main`.** Merge the pull request (or push your branch) so `munim430-ai/Jeenie-saem-bot` has the code.
2. **Import the project.**
   - Go to [vercel.com/new](https://vercel.com/new) and select `munim430-ai/Jeenie-saem-bot`.
   - The framework preset is detected as **Next.js**.
3. **Set environment variables.**
   - Copy the keys you need from [`.env.example`](.env.example) into **Settings → Environment Variables**.
   - At minimum, set `DEEPSEEK_API_KEY`: it drives both the conversation and live web search (DeepSeek's native `web_search`). `TAVILY_API_KEY` and Google Custom Search are optional extra fallbacks before the keyless DuckDuckGo.
   - Also set `JEANNIE_ACCESS_KEY` on any public deployment.
4. **Deploy.** Click **Deploy**. `/api/chat` and `/api/search` run on the Edge runtime. Voice, Telegram, and Hangeul run as Node.js functions.
5. **Daily report (optional).** `vercel.json` schedules a daily cron (03:00 UTC) on `/api/hangeul`.
   - Set `CRON_SECRET` so only Vercel can trigger it.
   - Set `TELEGRAM_*` so the report reaches your admin chat.

### Telegram webhook

Create a bot with [@BotFather](https://t.me/BotFather) and set `TELEGRAM_BOT_TOKEN` and `TELEGRAM_WEBHOOK_SECRET`.
Then register the webhook once:

```bash
curl -X POST "https://api.telegram.org/bot$TELEGRAM_BOT_TOKEN/setWebhook" \
  -d "url=https://<your-app>.vercel.app/api/telegram/webhook" \
  -d "secret_token=$TELEGRAM_WEBHOOK_SECRET"
```

`TELEGRAM_WEBHOOK_SECRET` is required. Without it the webhook refuses every update (HTTP 503), so nobody can forge messages to your bot.
Until `TELEGRAM_ADMIN_CHAT_ID` is set, the bot answers only `/start`, `/help` and `/whoami`. Send `/whoami`, put the chat id it returns in
`TELEGRAM_ADMIN_CHAT_ID`, and redeploy. From then on only that chat gets answers, live search, and live Hangeul data.

## Configuration

Every variable is optional. Values left as the `your_…` placeholders from `.env.example` are treated as unset.

| Variable | Purpose |
| --- | --- |
| `JEANNIE_ACCESS_KEY` | Shared secret for every `/api` route (header `x-jeannie-key` or `Authorization: Bearer`). The HUD prompts for it once and remembers it in this browser. |
| `JEANNIE_TIMEZONE` | IANA time zone for the Korean session greeting. Default `Asia/Dhaka`. |
| `LLM_PROVIDER` | `auto` (default: DeepSeek if its key is set, then Claude, then OpenAI, then Ollama), `deepseek`, `anthropic`, `openai` or `ollama`. |
| `DEEPSEEK_API_KEY`, `DEEPSEEK_MODEL`, `DEEPSEEK_VISION_MODEL`, `DEEPSEEK_BASE_URL` | DeepSeek, Jeannie's brain. `deepseek-v4-flash` (default) or `deepseek-v4-pro` (stronger); both call the web-search tool. DeepSeek retired the `deepseek-chat` / `deepseek-reasoner` names on 24 July 2026. Its chat models can't read images, so image analysis uses Claude or OpenAI when their key is set, else `DEEPSEEK_VISION_MODEL` (default `deepseek-v4-flash-vision-exp`, experimental). |
| `ANTHROPIC_API_KEY`, `ANTHROPIC_MODEL`, `ANTHROPIC_VISION_MODEL` | Claude. The default model is `claude-opus-5`; `claude-sonnet-5` and `claude-haiku-4-5` are cheaper. If Claude's safety classifiers decline a request, it is retried on a fallback model automatically. |
| `OPENAI_API_KEY`, `OPENAI_BASE_URL`, `DEFAULT_MODEL`, `VISION_MODEL` | OpenAI, or any OpenAI-compatible endpoint such as Groq or OpenRouter. The default model is `gpt-4o`. |
| `OLLAMA_BASE_URL`, `OLLAMA_MODEL`, `OLLAMA_VISION_MODEL` | Local or self-hosted Ollama through its OpenAI-compatible API. |
| `DEEPSEEK_SEARCH_MODEL`, `DEEPSEEK_ANTHROPIC_BASE_URL` | Optional overrides for DeepSeek's native web search (defaults `deepseek-v4-flash`, `https://api.deepseek.com/anthropic`). |
| `TAVILY_API_KEY`, `GOOGLE_CSE_API_KEY`, `GOOGLE_CSE_ID` | Optional fallback search providers after DeepSeek. DuckDuckGo is the keyless last resort. |
| `ELEVENLABS_API_KEY`, `ELEVENLABS_VOICE_ID`, `ELEVENLABS_MODEL_ID` | Jeannie's main voice. `eleven_multilingual_v2` speaks Korean; `eleven_flash_v2_5` is faster. With only the key set, the premade voice "Rachel" is used; free plans must set the ID of a voice they created, since library voices return HTTP 402 there (Jeannie then falls back to the Edge voice). |
| `SUPABASE_URL` (or `NEXT_PUBLIC_SUPABASE_URL`), `SUPABASE_SERVICE_ROLE_KEY` (or `SUPABASE_SECRET_KEY`) | Memory. The key is server-only; the publishable/anon key can't read memory. See [Memory](#memory-supabase). |
| `EDGE_TTS_ENABLED`, `EDGE_TTS_VOICE_EN`, `EDGE_TTS_VOICE_KO`, `EDGE_TTS_VOICE_MIXED` | Free Microsoft neural voices, used when ElevenLabs is off or fails. The mixed voice reads English sentences that contain Korean words. |
| `TELEGRAM_BOT_TOKEN`, `TELEGRAM_ADMIN_CHAT_ID`, `TELEGRAM_WEBHOOK_SECRET` | Telegram bridge. The webhook secret is required, and only the admin chat gets answers. |
| `HANGEUL_BASE_URL`, `HANGEUL_USERNAME`, `HANGEUL_PASSWORD`, `HANGEUL_REPORT_PATH`, `HANGEUL_STATUS_PATH`, `MOCK_MODE` | Hangeul admin portal. See below. |
| `CRON_SECRET` | Authenticates the Vercel Cron call to `/api/hangeul`. |

> **About the voice:** set `ELEVENLABS_VOICE_ID` to a voice you own or are licensed to use, such as
> one from the ElevenLabs Voice Library or your own recording. Cloning a real person's voice without
> their consent breaks ElevenLabs' terms and personality rights, so Jeannie doesn't ship with one.

## How the mistake audit works

1. **Ask for an audit.** Paste what you want checked and ask for an audit ("mistake audit", "check my errors",
   "실수 점검해줘", "잘못된 점 찾아줘"). Jeannie answers in a fixed frame (`■ 점검 결과`) with one numbered line per finding:
   Issue · Cause · Recommendation. She always ends with `■ 승인 요청`.
2. **Approve or reject.** Reply with a short approval (`승인`, `진행해`, `approve`, `go ahead`) to get the standard
   confirmation, "네, 부장님. 승인하신 권장 조치를 진행하겠습니다. …", listing the approved items. A rejection (`취소`, `보류`,
   `cancel`) puts the recommendations on hold. Anything else is treated as a new message.
3. **Where the state lives.** In the HUD it comes from the conversation itself. Telegram sends one message at a time, so
   there the pending audit is stored in Supabase (`jeannie_sessions`) for 30 minutes, and every decision is logged in
   `jeannie_audit_log`.
4. **What the confirmation means.** Like the IoT override, the confirmation is only a message. Jeannie has no tools that
   carry out the recommendations yet. The logged decisions are there for a future integration to act on.

## How the IoT override works

The interceptor runs first, before search, vision, or any model call, so it responds instantly and deterministically.

- **Responses:** exactly `Yes, it is done.`, or `네, 처리되었습니다.` when you write in Korean or the HUD is set to Korean.
- **Always triggers:** smart-home phrases such as "turn on/off", "switch off the fan", "smart home", "IoT", "thermostat", "air conditioner", `불 켜`, `불 꺼`, `문 잠궈`, and `스마트홈`.
- **Triggers with a command word:** device words from the brief (`light`, `lamp`, `fan`, `ac`, `tv`, `door`, `lock`, `switch`, `에어컨`, `온도`, …) count only alongside a command or state word ("dim the lights", "is the door locked?", `에어컨 온도 맞춰줘`).
- **Doesn't trigger:** questions like "what's the speed of light?" or "I'm a fan of your style" go to the other agents instead.
- **No real devices:** confirmations are simulated. Jeannie doesn't connect to any device. To control real hardware, call it from `src/lib/agents/iot-interceptor.ts` before returning the confirmation (for example, a Home Assistant webhook).

## Hangeul admin bridge

`/api/hangeul` (and the chat, when you ask for a "Hangeul report") reads two JSON endpoints relative to `HANGEUL_BASE_URL`:

- `HANGEUL_REPORT_PATH` (default `/api/reports/daily`)
- `HANGEUL_STATUS_PATH` (default `/api/status`)

**Authentication.** Requests use HTTP Basic auth with `HANGEUL_USERNAME` and `HANGEUL_PASSWORD`.

**Response format.** Any JSON works:

- A `metrics: [{label, value}]` array and a `highlights: string[]` array are used as-is.
- Otherwise, top-level fields are turned into metrics.

**Who gets live data.** Live portal data is only returned to trusted callers:

- a request carrying `JEANNIE_ACCESS_KEY`
- the Vercel Cron call carrying `CRON_SECRET`
- the Telegram admin chat

Everyone else, and any failed live call, gets clearly labeled mock data. `MOCK_MODE=true` forces mock data.

## API

| Route | Runtime | Description |
| --- | --- | --- |
| `POST /api/chat` | Edge | `{ messages, image?, lang? }` → streamed text. Metadata comes back in the `x-jeannie-agent`, `x-jeannie-lang`, `x-jeannie-provider`, `x-jeannie-sources`, and `x-jeannie-honorific` (URI-encoded) headers. |
| `GET /api/session` | Edge | The opening greeting: `{ greeting, honorific, localTime, timeZone }`. |
| `GET/POST/PATCH/DELETE /api/memory` | Node.js | List, upload (`{ name, content, pinned? }` or multipart), pin (`?id=` + `{ pinned }`) and delete (`?id=`) memory documents. Needs `JEANNIE_ACCESS_KEY`. |
| `GET/POST /api/search` | Edge | Live search: `?q=` or `{ query, maxResults? }`. |
| `POST /api/tts` | Node.js | `{ text, lang? }` → `audio/mpeg`. The engine used is named in `x-jeannie-tts-engine`. Returns 503 when only the browser voice is available. |
| `GET/POST /api/hangeul` | Node.js | `action=status\|report\|notify`, plus the daily cron. |
| `POST /api/telegram/webhook` | Node.js | Telegram bot bridge. |
| `GET /api/status` | Edge | Which capabilities are configured. Never returns secrets. |

## Project layout

```
src/
├── app/
│   ├── api/{chat,search,tts,hangeul,status,session,memory}/route.ts
│   ├── api/telegram/webhook/route.ts
│   ├── layout.tsx · page.tsx · globals.css      # the pink hologram HUD
├── components/   HologramOrb · VoiceVisualizer · ChatTerminal · TacticalMetrics · MemoryPanel · CameraScanner
├── hooks/        chat streaming, voice output, speech recognition
└── lib/
    ├── agents/   orchestrator · iot-interceptor · search-agent · vision-agent · hangeul-bridge
    │             tts-engine · edge-tts · llm · persona · etiquette · audit-flow
    ├── memory/   chunk (markdown/JSONL chunking, secret guard, search terms) · store · supabase
    ├── client/   typed fetch wrappers for the HUD
    └── env.ts · auth.ts · telegram.ts · types.ts · utils.ts
tests/            Vitest suites for agents and routes
supabase/migrations/  memory tables, search function, audit state
```

The brief lists `api/telegram/webhook.ts`. In the App Router a route must be a `route.ts` file, so it lives at `api/telegram/webhook/route.ts` and serves the same `/api/telegram/webhook` URL.

## Agent skills

`.claude/skills/` contains [Matt Pocock's engineering skills](https://github.com/mattpocock/skills), for example
`/grill-me`, `/tdd`, `/to-spec`, and `/diagnosing-bugs`, for Claude Code sessions in this repo. Run
`/setup-matt-pocock-skills` once to configure them. Attribution is in
[`.claude/skills/THIRD_PARTY_NOTICES.md`](.claude/skills/THIRD_PARTY_NOTICES.md).

The [Vercel plugin](https://github.com/vercel/vercel-plugin) (`vercel@claude-plugins-official`) is enabled at
project scope in `.claude/settings.json`. It adds Vercel, Next.js, and AI SDK skills, `/vercel:deploy`,
`/vercel:env` and `/vercel:status`, and the Vercel MCP server. Claude Code offers to install it when you open this repo.
It sends anonymous usage telemetry (a daily ping plus the names of its own skills). To turn that off, set
`VERCEL_PLUGIN_TELEMETRY=off`.
