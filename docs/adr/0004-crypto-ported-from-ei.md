# 4. Client-side crypto ported from Ei

## Status
Accepted

## Context
Two prior personal projects (`~/Projects/Personal/ei`, `~/Projects/Personal/mylibrary`)
had already built and battle-tested a client-side PBKDF2+AES-GCM pattern: a
zero-knowledge sync scheme where the server only ever sees a derived, opaque `userId`
and encrypted blobs, never the username/passphrase/key. `mylibrary` had itself already
copied this pattern from `ei` (with an explicit "Ei pattern" comment), confirming it
generalizes rather than being accidentally coupled to Ei's specific domain.

## Decision
Port `ei`'s `src/storage/crypto.ts` into `shared/crypto.ts` near-verbatim: PBKDF2
(SHA-256, 310,000 iterations, static non-secret salt) deriving an AES-GCM-256 key from
`username:passphrase`; `generateUserId()` (fixed all-zero IV encrypting a fixed
plaintext, for determinism); `encrypt()`/`decrypt()` (fresh random IV per call, chunked
base64 to avoid a known stack-overflow bug on large payloads that `ei` had already hit
and fixed). Changed only the `SALT` and `ID_PLAINTEXT` constants, so derived IDs never
collide with `ei`'s own `flare576.com/ei` namespace if the two ever shared
infrastructure.

## Consequences
- Inherited, not re-derived: `ei`'s documented gotchas apply here too — the zero-IV
  construction must never be reused for anything but the one fixed identity plaintext;
  base64 conversion must stay chunked for large payloads; a leaked/guessed userId
  cannot be used to decrypt anything without the underlying passphrase.
- **Two independent implementations must stay logically identical.** `shared/
  crypto.ts` (TypeScript, consumed directly by `cli/push.ts` under Bun) and `web/
  crypto.js` (hand-copied, type-annotation-stripped, since browsers can't execute `.ts`
  syntax and this project has a no-bundler constraint) are two files with one source
  of truth. If `shared/crypto.ts` ever changes, `web/crypto.js` must be updated to
  match, or the push side and pull side will silently derive different userIds/keys
  from the same credentials with no error message — just an artifact that never shows
  up in the list. There is no automated check enforcing this today.
