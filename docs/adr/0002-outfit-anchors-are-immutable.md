# ADR 0002: Outfit anchors are immutable

Status: accepted (2026-10-02)

## Context

Jeannie can wear four outfits besides the pink suit: sweater, tube top, grey suit and orange
two-piece. Each one is a still image of her in the NEUTRAL pose (ADR 0001) with only the clothing
changed, made by an image edit of the NEUTRAL frame:

| Outfit | Anchor file | Higgsfield image job |
|---|---|---|
| sweater | `assets/avatar/source/outfit-sweater.png` | `222d63f2-b0a3-4bb9-84d7-8bd59ab1789e` |
| tube | `assets/avatar/source/outfit-tube.png` | `e062b33e-e4c7-46d2-bc0d-4de786b5d065` |
| modest | `assets/avatar/source/outfit-modest.png` | `53b7621f-bac5-4f86-a94c-76e6b60e8d36` |
| orange | `assets/avatar/source/outfit-orange.png` | `9b7e574e-2b46-4950-83c9-7fa6765bfa68` |

Each outfit's clips are pinned to its anchor (first and last frame), the way every pink clip is
pinned to NEUTRAL.

## Decision

Once an outfit has an accepted clip, its anchor is never regenerated. A new look is a new outfit
with a new anchor, not an edit of an old one.

## Consequences

- Every clip of an outfit loops and hands over cleanly on that anchor.
- The gate (`gate.py <class> <clip> <out> <anchor>`) measures an outfit clip against its own anchor,
  not NEUTRAL.
- The anchors share NEUTRAL's pose and framing (background within ~35–45 dB, body landmarks within a
  few px). The face and edges were redrawn by the edit, so a cut between outfits is not seamless on
  its own: the app hides it under a short sparkle.
