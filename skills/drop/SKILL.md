---
name: drop
description: Zero-knowledge encrypted dead-drop relay for handing an artifact (a diff, a file, a zip) to a human on a machine you can't otherwise reach — e.g. an AI coding agent on unrestricted hardware handing work to a person on a locked-down VDI with no shared filesystem. Use when the user wants to send code changes, a document, or a bundle to "the other machine" and asks for help wiring that up.
---

# drop

`drop` is a client-side-encrypted relay. One machine encrypts an artifact locally and
pushes the ciphertext to a small server; a human on a completely different machine logs
into a web page, pulls the ciphertext, and decrypts it locally. The relay server never
sees plaintext, the passphrase, or the encryption key — only opaque bytes.

This is deliberately general: the relay doesn't know or care whether the artifact is a
git diff, a zip, a single file, or something else. It's a mailbox for encrypted blobs.

## When to use this

The user is working with you (an AI coding agent) on hardware that can freely reach the
internet, but the *destination* — the person who needs the result — is on a machine you
cannot reach directly: no shared filesystem, no direct network path, often a locked-down
corporate VDI. `drop` is the bridge.

## The mechanism, in short

1. Both ends share three secrets out of band (Slack, a password manager, however this
   team already shares things): a username, a passphrase, and a team auth code.
2. The pushing side derives a mailbox ID from `username:passphrase` (PBKDF2), encrypts
   the artifact with a key derived the same way (AES-GCM), and `POST`s the ciphertext to
   the relay's API, authenticated by the shared team auth code (`X-Drop-Auth` header —
   this just gates who may push at all, it has nothing to do with encryption).
3. The pulling side visits the relay's web page, enters the same username+passphrase,
   which independently derives the same mailbox ID, lists what's pending, and decrypts
   client-side in the browser.
4. Nothing at any point sends the passphrase itself over the wire. Compromising the
   relay server yields only ciphertext.

## Concrete flows

Two concrete implementations of the push side exist:

- **`drop-diff`** — pushes the current git working-tree diff (staged, unstaged, and
  untracked changes). Use this when the user is happy with their current uncommitted
  changes and just wants to hand them off as-is. See `skill://drop-diff` for the actual
  mechanics (what to run, what env vars are needed, what the output looks like).
- **`drop-file`** — pushes the raw bytes of an arbitrary existing file (a zip, a build
  output, a single generated document, a config bundle) that isn't a git diff. Use this
  when the user wants to send a specific existing artifact rather than "my current
  changes." See `skill://drop-file` for the actual mechanics.

Both are the same underlying script and follow the same shape: encrypt locally, push to
the same relay API, same auth model, same env vars — they differ only in what bytes get
captured before encryption. If the user needs an artifact shape neither of these covers,
that's new work, not a documented flow — say so rather than guessing at unbuilt
behavior.

## What you do NOT need to do

- You do not need to install anything system-wide, run an installer, or configure a
  package manager. `drop`'s pieces are plain files — copy or `curl` down what you need
  (see `drop-diff` for the exact files a git-diff push requires).
- You do not need to reimplement the encryption. It's a single self-contained script;
  invoke it, don't rewrite it.
