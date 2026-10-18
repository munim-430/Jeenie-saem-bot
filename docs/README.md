# Jeannie project docs

**In plain words:** these pages explain how Jeannie is built, how she runs, what information she handles
and where it goes. Each page starts with a short plain-language summary, then gives the technical detail
for whoever changes the code.

| Page | Read it for |
|---|---|
| [overview.md](overview.md) | What Jeannie is and the moving parts, in one picture |
| [build-and-deploy.md](build-and-deploy.md) | Stack, scripts, environment variables, Vercel, the PWA, rollback |
| [structure.md](structure.md) | What every folder in the repo holds |
| [site-map.md](site-map.md) | The page, its screens, and every API route |
| [python.md](python.md) | Every Python program, and the Hangeul BOT that lives outside this repo |
| [data-flow.md](data-flow.md) | What is collected, where it goes, why, and the risks |
| [codebase.md](codebase.md) | Module-by-module reference and end-to-end request traces |

Existing references these pages link to rather than repeat:

- [`../CONTEXT.md`](../CONTEXT.md): avatar glossary (NEUTRAL, clip classes, idle sequence, accept gate).
- [`adr/0001-neutral-anchor-is-immutable.md`](adr/0001-neutral-anchor-is-immutable.md): why the avatar's anchor
  image is never recreated.
- [`agents/`](agents/): how issues, triage labels and domain docs are kept.
- `.scratch/ani-companion/spec.md` and `.scratch/hangeul-cloud-context/spec.md`: feature specs.
