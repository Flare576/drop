---
name: drop-file
description: Push the raw bytes of an arbitrary file (a zip, a build artifact, a single generated document, a config bundle) through the drop relay so a human on another machine can pull, decrypt, and save it. Use when the user says something like "send this zip to the other machine", "push this build to the VDI", "get this file over to Elevance", or otherwise wants to hand off a specific existing artifact that isn't a git diff.
---

# drop-file

Concrete implementation of the `drop` relay (see `skill://drop` for the general
concept) for one specific artifact: the raw bytes of an arbitrary file at a
given path.

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

Point it at the file to send with `--input <path>`:

```sh
bun run drop/cli/push.ts --input <path>
```

(or `bunx drop-f --input <path>`, or `bun run cli/push.ts --input <path>` if working
inside the `drop` repo itself.)

The pushed filename defaults to the basename of `<path>`; override it with
`--filename <name>` if the recipient needs a different name than the source path
happens to have (e.g. the file lives at a temp path but should show up as
`release.zip` on the other side).

## What happens

- If `<path>` doesn't exist, it fails fast with a clear, specific error naming the
  missing file — that's expected behavior, not a bug; relay it back to the user rather
  than guessing at a workaround.
- Unlike `drop-diff`, there is no "nothing to push" skip: `--input` always pushes
  whatever bytes are at `<path>`, even an empty file. There's no ambiguity about "is
  there anything to send" the way there is with a git diff against a possibly-unchanged
  working tree.
- Otherwise it reads the file (binary-safe), encrypts it, and pushes it. On success it
  prints an `artifactId` and `expiresAt` — that's the receipt; nothing further is needed
  on this side.
- On failure it prints a specific, actionable reason (bad `DROP_AUTH`, rate-limited,
  network unreachable) — relay that message back to the user rather than guessing at
  the cause yourself.

## What the other side does

Not this side's concern to execute, but useful context: the human on the destination
machine visits the relay's web page, signs in with the same `DROP_USERNAME`/
`DROP_PASSPHRASE`, sees the pushed artifact in a list, downloads and decrypts it in
their browser, and is asked to confirm before it's deleted from the relay. There is
nothing for the pushing side to do to "complete" this — the push is the whole job.
