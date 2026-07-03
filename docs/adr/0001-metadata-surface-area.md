# 1. Metadata surface area is acceptable

## Status
Accepted

## Context
The relay's core promise is zero-knowledge: the server never sees plaintext, the
passphrase, or the derived key. But a *list* endpoint (`GET /drop/api/{userId}`) is
needed so a pull-side client can show "here's what's waiting" without fetching and
decrypting every pending artifact just to render a list. Something has to be
server-visible to make that list useful at all.

What actually is server-visible, per `api/drop.php` (`handlePost`/`handleGetList`):
`artifactId` (server-generated UUID), `createdAt`/`expiresAt` (server clock, not
client-supplied), and `sizeBytes` (`strlen($data['ciphertext'])` — literal ciphertext
byte count). `filename` is deliberately **not** metadata — it lives inside the
encrypted envelope (`{"filename": ..., "patch": ...}`), so the server can't report or
log a value it never had.

## Decision
Accept that push timing, push frequency, and rough artifact size are observable to
the relay (and thus to a DB dump, a malicious host admin, or IONOS itself) for a given
mailbox, in exchange for a list endpoint that doesn't require decrypting everything
just to enumerate it. Full metadata opacity (encrypting the list itself) was considered
and rejected — it would mean the *only* way to know what's pending is fetch-and-decrypt
every item, defeating the purpose of a lightweight list call.

## Consequences
- Server compromise (DB dump or disk read) yields: "this mailbox pushed N times, at
  these timestamps, of roughly these sizes" — not content, not filenames, not the
  passphrase or key. This is the accepted residual exposure.
- If this ever needs to tighten (e.g. carrying something where push *timing* itself is
  sensitive, not just content), that's a real design change, not a config flag — flag
  it explicitly rather than assuming the current model quietly covers it.
