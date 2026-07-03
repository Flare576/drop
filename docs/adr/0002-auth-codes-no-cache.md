# 2. Auth codes: DB-backed, checked at call time, not cached

## Status
Accepted

## Context
POST (enqueue) needs a gate independent of encryption, to stop anonymous internet
traffic from filling the host's disk with garbage ciphertext under made-up userIds.
This went through two designs before landing:

1. **v1**: a single static `PUSH_TOKEN` config secret, `hash_equals()`-compared. Simple,
   but rotating it meant redeploying, and it was one value for the whole team forever.
2. **v2 (current)**: an `allowed_auth` table (`code VARCHAR(128) PRIMARY KEY`), checked
   via `isAuthCodeValid()` on every POST — a plain indexed lookup. Codes are inserted
   manually (e.g. via phpMyAdmin), never seeded in `schema.sql` or committed to git.

A caching layer on top of the DB lookup (to avoid a query on every POST) was proposed
mid-build and explicitly retracted before being built.

## Decision
No app-level cache for the auth-code check. Two reasons, both load-bearing:
- **PHP's shared-nothing request model.** Each request is a fresh process; there is no
  persistent in-process memory to cache into. A flat-file cache was considered and
  rejected — on this host, hitting disk for a cached JSON blob is not obviously faster
  than an indexed primary-key DB lookup, and adds a second thing (cache/DB) that can
  drift out of sync.
- **The DB already has its own buffer pool.** IONOS's MySQL almost certainly caches hot
  index pages itself; a `SELECT 1 FROM allowed_auth WHERE code = ?` on a small table is
  already about as cheap as a lookup gets.

## Consequences
- One DB round-trip per POST for the auth check, always. Acceptable at this project's
  traffic scale (a personal/small-team tool); would need revisiting if POST volume ever
  grows by orders of magnitude.
- This gate is intentionally low-stakes: a leaked or guessed code lets someone spam a
  mailbox with garbage ciphertext they can't read back out (the passphrase still gates
  actual content). It is not, and was never meant to be, a strong access-control layer
  — see also ADR 0001 for the broader "what's actually protected here" framing.
- Codes never land in git history (not in `schema.sql`, not in `config.php.template`) —
  if that changes (e.g. someone adds a seed row "for convenience"), that's a regression
  of this decision, not a neutral change.
