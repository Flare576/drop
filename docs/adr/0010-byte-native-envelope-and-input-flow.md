# 10. Byte-native envelope, generalized artifact shape, `--install`

## Status
Accepted (generalizes ADR 0006, does not reverse it)

## Context
Two real gaps surfaced once the actual deployment scenario was examined closely rather
than assumed:

1. **The destination machine often has no git relationship to the origin's repo at
   all.** ADR 0006 (diff/patch as the artifact format) assumed the destination side had
   a matching checkout that might, at worst, have "diverged" from origin's `HEAD`. The
   real target audience — a locked-down client VDI receiving a deliverable "built
   somewhere else" — frequently has *no* checkout of the relevant repo whatsoever. A
   `git diff` against a `HEAD` the destination has never seen is inert data; there is
   nothing to `git apply` it onto. Nothing in this codebase ever invoked `git apply`
   anyway — the web pull-UI's entire job stopped at "decrypt, then save bytes to disk"
   (`triggerDownload` in `web/app.js`), so "the destination applies it manually" was
   always a documented human expectation, never an assisted or even instructed step.
2. **`shared/crypto.ts`'s `encrypt`/`decrypt` were string-only**, round-tripping
   plaintext through `TextEncoder`/`TextDecoder`. This silently corrupts genuinely
   binary content — a zip file's bytes are not valid UTF-8 in general, and
   `TextDecoder.decode()` on non-UTF8-valid bytes produces mangled output, not a
   byte-for-byte round trip. Any artifact shape other than text (a diff, always valid
   UTF-8) was fundamentally broken by this, independent of the envelope's JSON shape.

Both gaps blocked the same underlying need: handing off an artifact that isn't a git
diff — a zip of a built app, a single generated file, a document — to a destination
that may share no context with the origin beyond the drop relay itself.

## Decision
Generalize the artifact layer without touching the relay API (`api/`), which was
already fully artifact-agnostic (opaque `{iv, ciphertext}` blobs, per ADR 0001).

- **`shared/crypto.ts` (and its hand-ported sibling `web/crypto.js`) become
  byte-native**: `encrypt(data: Uint8Array, …): Promise<EncryptedPayload>` and
  `decrypt(payload, …): Promise<Uint8Array>`. No `TextEncoder`/`TextDecoder` at the
  crypto boundary — `crypto.subtle.encrypt`/`decrypt` already operate on raw bytes, so
  this removes a lossy conversion rather than adding one.
- **The JSON envelope `{filename, patch}` is replaced by a header-plus-raw-bytes
  framing**: the plaintext fed to `encrypt()` is `TextEncoder.encode(JSON.stringify({
  filename }) + "\0")` concatenated with the raw content bytes, unseparated by
  anything but that one null byte. Filenames cannot contain null bytes on any real
  filesystem, so the delimiter is always unambiguous. `crypto.ts` itself has zero
  knowledge of this framing — it only ever encrypts/decrypts opaque bytes; the envelope
  is built and parsed entirely by the producer (`cli/push.ts`) and consumer
  (`web/app.js`).
- **`cli/push.ts` gains `--input <path>`** as a sibling to its existing (unchanged)
  default git-diff-computation behavior: read raw file bytes instead of computing a
  diff, same encrypt-and-push flow otherwise, same env vars, same flags, same error
  handling. Filename defaults to the input path's basename, still overridable via
  `--filename`.
- **`cli/push.ts` gains `--install`** as a top-level mode, checked before any
  credential/network/git logic runs: detect which coding harnesses are present
  (Claude Code, OMP, OpenCode — matching `ei`'s own `installSkillsTo` targets) and copy
  `skills/drop/` and `skills/drop-file/`/`skills/drop-diff/` into each detected
  harness's skill-discovery directory. This is the actual reason the npm package
  exists at all — `push.ts` needs no persistent client-side install to *run* (`bunx
  drop-f` works standalone, no state), so the only thing an install step ever needed to
  accomplish was getting the skill markdown somewhere a harness could find it. Modeled
  directly on `~/Projects/Personal/ei/src/cli/install.ts`'s `installSkillsTo` pattern,
  scoped down to skill-copying only (no MCP registration, no hooks, no extensions —
  drop-f has none of those).
- **The web pull-UI becomes a pure byte-writer**: `triggerDownload` drops its hardcoded
  `text/plain` MIME type and hands the browser whatever bytes were inside the envelope,
  under the filename that traveled inside the encrypted blob. No content-type
  inspection, no diff-specific handling.

## Consequences
- ADR 0006's decision (git diff/patch, not bundle, for the diff-specific flow) is
  **unchanged** — `bunx drop-f` with no `--input` still computes a plain `git diff
  HEAD --binary -M` exactly as before, and the destination is still expected to
  manually `git apply` it in a repo that shares history with origin. That flow remains
  correct for its own narrow case (an existing, shared-base repo; incremental sync).
  This ADR does not reverse it — it generalizes the artifact/crypto layer *underneath*
  both the diff flow and a new file/zip flow, and adds `--input` as a documented
  sibling for the case ADR 0006 never covered: no shared base at all.
- The gap named above — nothing in the UI ever instructed a human what to *do* with a
  downloaded `.patch` file — is **still open** after this change. This ADR does not
  add apply-instructions or an in-browser diff viewer; it only fixes the artifact/byte
  layer so a non-diff artifact (which needs no "apply" step at all — it's just a file
  to use) is no longer corrupted or impossible to express. If the diff flow's
  missing-instructions gap needs closing, that's a separate, explicit decision.
- `skills/drop/SKILL.md`'s two concrete flows (`drop-diff`, `drop-file`) now both
  exist; the "not yet implemented" framing for non-diff artifacts is gone.
- No backward compatibility was preserved for the old `{filename, patch}` JSON
  envelope or the old string-based `encrypt`/`decrypt` signatures — nothing was
  deployed or in use yet, so this was a clean cutover, not a migration.
