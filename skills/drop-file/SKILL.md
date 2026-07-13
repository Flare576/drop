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

## Running it

No local setup, no files to fetch — `bunx drop-f` pulls and runs the current
published `push.ts` directly, every time. Point it at the file to send with
`--input <path>`:

```sh
bunx drop-f --input <path>
```

This is the **only** invocation this skill uses — there is no curl/clone/copy
fallback. `push.ts` needs Bun specifically (Bun-only APIs, not just
TypeScript-without-a-build-step), and this tool's whole premise is running on
hardware that can freely reach the internet (see `skill://drop`'s "When to use
this") — so "npm/bunx unreachable" isn't a real constraint to design around here.
See the root `README.md`'s "Running drop-f" section for the fuller rationale
(including why a curl'd-down or globally-installed copy buys nothing over this).

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
