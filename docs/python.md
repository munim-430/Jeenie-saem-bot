# Python programs

**In plain words:** the app itself has no Python in it; everything that runs on the website is TypeScript.
There is one Python tool of our own, used on a developer's computer to check new avatar videos before they
ship. A second Python file came bundled with a downloaded Claude skill. The office bot that reads the Hangeul
portal (Hangeul BOT) is a separate Python program on a Windows PC and is **not** in this repo.

| File | Ours? | Runs where / when |
|---|---|---|
| `scripts/avatar-clips/gate.py` | yes | Developer machine, by hand, for each new avatar clip |
| `.claude/skills/hyperframes-creative/scripts/extract-audio-data.py` | no (third-party skill) | Only if someone uses that skill for a video project |
| Hangeul BOT (`C:\Hangeul\BOT`) | separate project | Office Windows PC; not in this repo |

## `scripts/avatar-clips/gate.py`: the clip accept gate

**Purpose.** Every avatar clip must start and end on the same neutral pose (the NEUTRAL anchor image,
`assets/avatar/source/fullbody.png`) so the app can cut between clips without a visible jump. `gate.py`
measures that, and prepares the evidence for the human visual check. The rules are in
[`../CONTEXT.md`](../CONTEXT.md) ("Accept gate").

**Usage**

```
python3 scripts/avatar-clips/gate.py <class> <clip.mp4> <out_dir> [anchor.png]
# class: loop | oneshot | entry | exit
```

**What it does**

1. Decodes the clip to 720×1280 frames with ffmpeg (`FFMPEG` env var, else `ffmpeg` on PATH, else
   `imageio-ffmpeg`).
2. **Part 1, closure** (≥ 35 dB PSNR, by class):
   - one-shot: the first and last frames against NEUTRAL;
   - loop: the first frame against the last frame, and the first frame against NEUTRAL;
   - entry: the last frame against NEUTRAL;
   - exit: the first frame against NEUTRAL.
3. **Part 2, expression floor** (one-shots only): the lowest PSNR against NEUTRAL across the clip must be
   ≤ 34 dB, i.e. the clip really moves.
4. **Part 3, visual review:** writes the peak frame and a whole-body contact sheet (every 18th frame) to
   `out_dir`. A person must look at these; passing Parts 1–2 never means the clip ships.
5. Prints a JSON summary.

**Inputs / outputs.** Reads one mp4 and the anchor PNG; writes JPGs plus JSON to `out_dir`. No network, no
secrets, no personal data. Depends on `numpy` and ffmpeg.

## `extract-audio-data.py` (third-party)

Part of the installed `hyperframes-creative` Claude skill (`.claude/skills/`, see `THIRD_PARTY_NOTICES.md`).
It turns an audio or video file into per-frame loudness and frequency-band JSON for HyperFrames video
compositions. Nothing in the app calls it.

## Hangeul BOT (outside this repo)

A Python program on the office Windows PC that logs into the Hangeul admin portal (`hangeul.com.bd/admin`),
reads student and report pages, and builds reports. This repo only describes what it is asked to add, in
`.scratch/hangeul-cloud-context/hangeul-bot-prompt.md`. That work is **planned, not built**:

- Compute `gte-small` embeddings (`sentence-transformers`) of each record's text.
- Publish everything to Supabase through the `hg_sync` database function (`hg_runs`, `hg_records`,
  `hg_chunks`), with a `src.cloud.backfill` step for the first full upload.

What that data is and where it would go: [data-flow.md](data-flow.md#planned-hangeul-cloud-context-not-built).
