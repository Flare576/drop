---
name: drop-diff
description: Push the current git working-tree diff (staged, unstaged, and untracked changes) through the drop relay so a human on another machine can pull, decrypt, and apply it. Use when the user says something like "send this to the other machine", "push this to Elevance", "get this diff over to the VDI", or is otherwise happy with the current changes and wants to hand them off.
---

# drop-diff

Concrete implementation of the `drop` relay (see `skill://drop` for the general
concept) for one specific artifact: a git diff.

## Prerequisites

Three environment variables must already be set (the user sets these once, out of band
— do not generate or guess values for them):

```
DROP_USERNAME
DROP_PASSPHRASE
DROP_AUTH
```

If any are missing, running the script below will fail with a clear, specific message
naming exactly which one — that's expected behavior, not a bug. Point the user at
setting them (e.g. in `~/.doNotCommit.d/.doNotCommit.droprelay` or their shell profile,
whatever this environment already uses for secrets) rather than trying to work around
the failure.

## Running it

No local setup, no files to fetch — `bunx drop-f` pulls and runs the current
published `push.ts` directly, every time, from inside the git repo whose changes
should be sent:

```sh
bunx drop-f
```

This is the **only** invocation this skill uses — there is no curl/clone/copy
fallback. `push.ts` needs Bun specifically (Bun-only APIs, not just
TypeScript-without-a-build-step), and this tool's whole premise is running on
hardware that can freely reach the internet (see `skill://drop`'s "When to use
this") — so "npm/bunx unreachable" isn't a real constraint to design around here.
See the root `README.md`'s "Running drop-f" section for the fuller rationale
(including why a curl'd-down or globally-installed copy buys nothing over this).

## What happens

- If there are no working-tree changes at all, it prints `Nothing to push` and exits
  `0` — no network call is made. This is a safe no-op, not an error; don't retry or
  investigate further.
- Otherwise it captures the full diff (staged + unstaged + untracked, binary-safe),
  encrypts it, and pushes it. On success it prints an `artifactId` and `expiresAt` —
  that's the receipt; nothing further is needed on this side.
- On failure it prints a specific, actionable reason (bad `DROP_AUTH`, rate-limited,
  network unreachable) — relay that message back to the user rather than guessing at
  the cause yourself.

## What the other side does

Not this side's concern to execute, but useful context: the human on the destination
machine visits the relay's web page, signs in with the same `DROP_USERNAME`/
`DROP_PASSPHRASE`, sees the pushed artifact in a list, downloads and decrypts it in
their browser, and is asked to confirm before it's deleted from the relay. There is
nothing for the pushing side to do to "complete" this — the push is the whole job.
