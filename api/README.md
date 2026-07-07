# drop relay — server-side API

An encrypted dead-drop relay. This directory is the **zero-knowledge relay** half of the
system: it lets an R&P coding harness (running on unrestricted hardware) push encrypted
code artifacts, and a locked-down client VDI (browser-only) pull and decrypt them, without
this server — or flare576.com's hosting provider, or anyone who dumps the database — ever
being able to read the contents.

## Why this is load-bearing, not incidental

The payload this relay carries is **client (Elevance) source code**, a materially higher
scrutiny bar than a personal notes app. The entire reason it's acceptable to route that
code through a third-party-fronted PHP host is the guarantee below. If any of the four
points stops being true, this system is no longer safe to use for that purpose — treat
this doc, not a code comment buried in a handler, as the source of truth for that
guarantee.

1. **The server never receives the username or passphrase.** Both the push CLI and the
   pull-side web UI derive everything locally, in-browser or in-process, via
   `shared/crypto.ts`. Only the following ever cross the wire to this API:
   - `userId` — a PBKDF2-derived (310k iterations), deterministic, unguessable mailbox
     token, computed independently by both sides from `username:passphrase`. It doubles
     as the read/list/delete auth credential: possession of the correctly-derived ID is
     the only thing this server checks for those operations (see "Auth model" below).
   - `{iv, ciphertext}` — AES-GCM-256 output. `iv` is random per artifact; `ciphertext` is
     opaque bytes to this server.
2. **The encryption key never exists server-side, even transiently.** It is derived
   client-side via PBKDF2 and marked `extractable: false` in the Web Crypto API — it
   cannot be exported even by a compromised caller in the same JS context, let alone sent
   over the network.
3. **Filenames are inside the envelope, not metadata.** The encrypted plaintext is a
   small JSON header (`{"filename": "..."}`) followed by a null byte and the raw
   content bytes — not fixed to any one artifact shape (a git diff, a zip, an arbitrary
   file); see `docs/adr/0010-byte-native-envelope-and-input-flow.md`. This API only
   ever sees the ciphertext of that whole blob — it cannot report or log a filename it
   never had. The only server-observable metadata is what's inherent to opaque bytes:
   `artifactId` (server-generated UUID), `createdAt`/`expiresAt` (server clock), and
   `sizeBytes` (ciphertext byte length).
4. **Compromise of this server (DB dump, disk read, or a malicious host admin) yields only
   opaque blobs.** Without the shared `username:passphrase`, the ciphertext is
   AES-256-GCM output with no known-plaintext leverage — there's nothing here to brute
   force faster than the passphrase itself.

## Auth model

Two independent credentials, deliberately not conflated:

- **`X-Drop-Auth`** (POST only) — a shared team-gate code, checked against the
  `allowed_auth` table (`code VARCHAR(128) PRIMARY KEY` — a plain indexed lookup, no
  app-level caching layer; the DB's own buffer pool already makes this cheap, and PHP's
  shared-nothing request model means an in-process cache would just be re-populated
  every request anyway). It gates *who may enqueue artifacts at all* and has nothing to
  do with encryption — a leaked code lets someone spam a mailbox with garbage
  ciphertext, but grants no ability to read anything back (they'd still need the
  passphrase to decrypt whatever anyone pushed). Codes are inserted manually (e.g. via
  phpMyAdmin), not seeded in `schema.sql`, so a code never lands in git history.
  Unrecognized or missing code → `403`.
- **`userId` in the URL path** (GET/HEAD/DELETE) — the zero-knowledge model. Since it's a
  PBKDF2-derived, effectively unguessable value, knowing it is treated as proof you also
  know the underlying `username:passphrase`. There is no separate password/session layer
  on top of this for read/list/delete, by design — adding one wouldn't strengthen the
  model (you'd still need to distribute *that* secret out-of-band too) and would just be
  another credential to keep in sync between the harness and the VDI.

## Storage model

Hybrid MySQL + flat files, matching the pattern proven by the sibling `ei` app on this
same host:

- **MySQL (`drop_items`, `drop_rate_limits`)** — metadata only: which artifacts exist, when
  they expire, observed ciphertext size, and (in a separate table, since `drop_items` is
  1-row-per-artifact) the rolling POST-timestamp window per `userId` used for rate
  limiting.
- **Filesystem (`DATA_PATH/{userId[0:2]}/{userId}/{artifactId}.json`)** — the actual
  `{iv, ciphertext}` blob, sharded by the first two characters of `userId` so no single
  directory accumulates every mailbox on the host.

## Expiry without cron

This IONOS host's SFTP account has restricted (`rssh`) shell access and cannot reliably run
a cron job. Expiry is therefore fully self-healing from ordinary HTTP traffic instead:

- **Lazy, per-mailbox:** every read for a given `userId` (list/fetch/head) first deletes
  that user's own expired rows + blob files before answering.
- **Probabilistic, global:** every `POST` has a small (`EXPIRY_SWEEP_PROBABILITY`, default
  5%) chance of additionally sweeping *all* expired rows/files across every mailbox, so
  mailboxes that are pushed-to but never read still eventually get cleaned up.

## Base path

The literal string `/api/` is hardcoded in `index.php` rather than derived from
`$_SERVER['SCRIPT_NAME']`/`PATH_INFO`. This is intentional, not a shortcut: a prior sibling
app on this same host went through repeated churn trying to make its base path
"self-discovering" across different Apache rewrite configurations. Don't refactor this to
be dynamic — if the deploy path ever changes, update the constant. Production is reachable
at `https://drop.flare576.com/api`.
