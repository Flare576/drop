# 5. Multi-item inbox, not single-slot overwrite

## Status
Accepted

## Context
Both `ei` and `mylibrary`'s sync APIs are single-slot: one blob per userId, overwritten
on every POST (an upsert). That fits their use case (one current sync-state per user).
`drop`'s use case is different: a coding harness may push several times before a human
gets to a pull-side session, and each push is a distinct artifact — overwriting the
previous one would silently lose it.

## Decision
Key `drop_items` per-artifact (`PRIMARY KEY (user_id, artifact_id)`), not per-user.
POST always inserts a new row with a server-generated UUID (`generateArtifactId()`),
never overwrites. This required building a real inbox: `GET` (list), `GET` (fetch one),
`DELETE` (consume one) — a larger endpoint surface than `ei`/`mylibrary`'s GET/POST/HEAD
trio, and a genuine TTL/expiry mechanism (see ADR 0007), since nothing in the
single-slot model needed one (a fresh POST already discarded the old value).

## Consequences
- A mailbox can accumulate multiple pending artifacts; the pull-side UI lists all of
  them, not just "the current one."
- Filenames are server-generated-UUID-keyed, not derived from filename+timestamp (an
  earlier design floated this) — avoids collision handling and keeps the filename
  itself inside the encrypted envelope rather than server-visible (see ADR 0001).
- The optimistic-concurrency `ETag`/`If-Match` pattern `ei`/`mylibrary` use for their
  single-slot upsert doesn't apply here and was correctly not carried over — there's no
  concurrent-write-to-the-same-slot race to guard against when every push is its own
  row.
