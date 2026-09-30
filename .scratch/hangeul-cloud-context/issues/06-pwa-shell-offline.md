# PWA shell: offline banner and disabled input

Status: ready-for-agent (the PWA work on saem/hangeul-context-reader)

Ticket 6 of the spec's §10. See spec §6 (first two bullets) and D10. Blocked by: none (tickets 4 and 5 are done).

## What exists already

Most of the installable shell came with `.scratch/ani-companion/issues/01-pwa-installable.md`:

- `src/app/manifest.ts` (served as `/manifest.webmanifest`, not a file in `public/` as the spec says): name
  "Jeannie", `display: standalone`, portrait, the HUD's theme colour, three icons in `public/icons/`.
- `public/sw.js` (`VERSION` "v3"): `/api/*` network-only and never cached; avatar clips and icons cache-first;
  `/_next/static` stale-while-revalidate; page navigations network-first with the `/` shell cached; cross-origin
  requests untouched; `activate` deletes only caches whose name starts with `jeannie-`, so a transformers.js model
  cache (ticket 7) survives.
- `src/components/ServiceWorkerRegister.tsx` (production only), mounted in `src/app/layout.tsx`.

## What is missing

1. **Reachability.** A hook (e.g. `src/hooks/useOnlineStatus.ts`): `navigator.onLine` plus the `online` / `offline`
   events, plus API reachability (an `ApiRequestError` with status 0 from `src/lib/client/api.ts` means unreachable;
   re-probe `GET /api/status` until it answers).
2. **Banner.** "Offline: Jeannie needs a connection" (and the Korean line), `role="status"`, on the HUD
   (`src/app/page.tsx`) and on the phone's `AvatarScreen`. No offline answers (D10): the device copy of ticket 7 is
   for speed while online, not for answering offline.
3. **Disabled input while offline.** Every send goes through `chat.send` in `page.tsx` (composer, quick commands,
   IoT tiles, voice), so guard it there; `ChatComposer` needs a `disabled` prop (textarea and SEND button, with the
   offline line as the placeholder), `AvatarScreen` an `offline` prop for the hold-to-talk button.
4. **No data in the service worker.** Keep `/api/*` network-only, and assert it for `/api/hangeul/*` in
   `tests/pwa.test.ts` (which evaluates `sw.js` in `node:vm`). Bump `VERSION` if `sw.js` changes.

## Tests

`tests/pwa.test.ts` for the service-worker rule. The hook and the banner are React code; the repo has no DOM test
setup (vitest `environment: "node"`), so keep any logic worth testing in a pure module.

## Comments
