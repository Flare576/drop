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

## Getting `push.ts`

No install step, no package manager required. Two files, same relative layout, is all
this needs:

```sh
mkdir -p drop/cli drop/shared
curl -fsSL https://raw.githubusercontent.com/Flare576/drop/main/cli/push.ts -o drop/cli/push.ts
curl -fsSL https://raw.githubusercontent.com/Flare576/drop/main/shared/crypto.ts -o drop/shared/crypto.ts
```

(`push.ts` imports `../shared/crypto.ts` by relative path — both files must land in this
same relative arrangement, wherever you put the `drop/` folder.)

If the repo is already cloned locally (e.g. this skill is running from inside the
`drop` project itself), skip the `curl` step and just use `cli/push.ts` directly.

Alternatively, if `drop-f` has been published to npm, `bunx drop-f` runs the exact same
script without a local copy at all — check whether that's available before falling back
to `curl`.

## Running it

From inside the git repo whose changes should be sent:

```sh
bun run drop/cli/push.ts
```

(or `bunx drop-f`, or `bun run cli/push.ts` if working inside the `drop` repo itself.)

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
