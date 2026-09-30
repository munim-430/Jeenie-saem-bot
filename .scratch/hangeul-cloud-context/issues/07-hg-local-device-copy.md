# hg-local: the device copy, local search and the model check

Status: ready-for-agent (the PWA work on saem/hangeul-context-reader)

Ticket 7 of the spec's §10. See spec §6 (local store, local search, embed-model check, settings), D9, D12, D13, D14.
Blocked by: none (ticket 4's routes and ticket 5's isomorphic answer code are done).

## What to build (`src/lib/client/hg-local/`)

- **Store** (`db.ts`): IndexedDB database `jeannie-hg` with `records` (`[kind, key]` → `HgRecord`), `chunks`
  (`[kind, key, ord]` → `{content, embedding: Float32Array}`) and `meta` (`max_seq`, `embed_model`, `synced_at`),
  behind an interface so tests use an in-memory Map. Call `navigator.storage.persist()`.
- **Sync** (`sync.ts`): first sync pages `GET /api/hangeul/snapshot` (follow `next` until null; keep the first page's
  `max_seq`), with progress and consent before starting on mobile data (tens of MB with the OCR text; the live dump
  is about 28-30 pages of ~3 MB). Then `GET /api/hangeul/changes?since=<max_seq>` on open, on focus and every 5 min
  while open, looping while `more`; an upsert replaces the record and all its chunks (a chunk with no `content` has
  its record's `content`), a delete drops the record and its chunks. Formats: ticket 4, "Wire formats".
- **Search** (`search.ts`): brute-force cosine over the local `Float32Array` vectors (`cosine` and `decodeVector` in
  `src/lib/hangeul/vectors.ts`). gte-small scores sit close together (unrelated rows still score ~0.86): rank by the
  gap to the best hit, not a fixed threshold (the server keeps hits within 0.04 of the best).
- **Embedding** (`embed.worker.ts`): transformers.js (`@huggingface/transformers`, the one allowed new dependency,
  pinned to an exact version) loading `Supabase/gte-small` in a Web Worker, mean pooling and normalising (384-d).
  `next.config.mjs` needs `config.resolve.alias` `{"sharp$": false, "onnxruntime-node$": false}`.
- **Model check** (`check.ts`): on first sync, embed three stored chunk texts and compare with their stored vectors;
  cosine below 0.98 logs it and falls back to the server (`POST /api/hangeul/ask` without an embedding, which uses
  hg-embed and hg_match). Compare vectors, never the `embed_model` string (the bot's is
  `thenlper/gte-small@17e1f347…`, not `Supabase/gte-small`).
- **Answering.** Send `{question, embedding, hits: [{kind, key}]}` (at most 24 hits) to `POST /api/hangeul/ask`, or
  as `hangeul: {embedding, hits}` beside `messages` in `POST /api/chat`: the server re-reads those records from
  current rows. Structured plans can render straight from the device copy with the same code:
  `readersFromRecords({records, runs?})` (`src/lib/hangeul/memory-readers.ts`), `planFor`, `runPlan`, `renderAnswer`
  (`src/lib/hangeul/answer.ts`); plans in `SERVER_ONLY_INTENTS` (`changes_since`, `data_status`) and every "as of"
  that needs `hg_runs` go to the server (the device keeps no runs).
- **Settings** panel "Hangeul data" in `TacticalMetrics` children (copy `MemoryPanel`): "Re-sync everything" and
  "Delete local copy" (confirm first), the only way to remove the data from a device.

## Tests

`tests/hg-local.test.ts`: sync applies upserts and deletes from a fake changes feed; cosine search returns the right
record; a model mismatch falls back to the server. Synthetic data only.

## Comments
