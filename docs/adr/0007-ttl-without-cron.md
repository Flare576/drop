# 7. TTL expiry is lazy + probabilistic, not cron

## Status
Accepted

## Context
Artifacts should expire (`TTL_HOURS = 48`) so encrypted blobs don't sit indefinitely on
third-party-fronted infrastructure. The natural implementation is a cron job sweeping
expired rows. This host's SFTP account has restricted (`rssh`) shell access and cannot
reliably run cron — confirmed via a real deploy-time incident on the sibling `ei`
project on the same host (the SFTP action's default mode tries to `mkdir` over SSH,
which `rssh` rejects; a documented gotcha this project inherited awareness of).

## Decision
Make expiry self-healing from ordinary HTTP traffic instead of relying on a scheduled
job:
- **Lazy, per-mailbox** (`expireUserItems()`): every read (list/fetch/head) for a given
  `userId` deletes that user's own expired rows + blob files before answering.
- **Probabilistic, global** (`sweepExpiredGlobally()`): every `POST` has a
  `EXPIRY_SWEEP_PROBABILITY = 0.05` (5%) chance of additionally sweeping *all* expired
  rows/files across every mailbox, so mailboxes that are pushed-to but never read still
  eventually get cleaned up.

## Consequences
- **No upper bound on staleness in the worst case.** A mailbox pushed to exactly once
  and never read again has no per-mailbox lazy trigger (nothing ever reads it) and
  depends entirely on the 5%-per-POST global sweep firing — which requires *some other
  mailbox* to receive a POST. In a low-traffic deployment, this could in principle leave
  an orphaned artifact well past 48 hours. This is an accepted tradeoff for a
  personal/small-team-scale tool, not a guarantee — do not represent "48 hour TTL" as a
  hard bound to a client or in any compliance-facing documentation without this caveat.
- If this ever needs a real bound (e.g. a compliance requirement for guaranteed
  deletion within a fixed window), that requires either finding a way to run scheduled
  cleanup on this host after all, or moving off a host that can't run cron — not a
  bigger `EXPIRY_SWEEP_PROBABILITY` value, which only narrows the gap, never closes it.
