# push.ts

Standalone Bun CLI that pushes an artifact — a git working-tree diff by default, or the
raw bytes of any file via `--input` — through the drop relay, so a coding harness
running on unrestricted hardware can hand it to a locked-down client VDI's browser to
pull down later. It has **zero knowledge of which harness invoked it** — a coding
agent calls it directly (see `skills/drop-diff/SKILL.md` and `skills/drop-file/
SKILL.md`) when it decides a push is warranted, or a human runs it by hand. There is
no automatic/background trigger; see `docs/adr/0003-skills-over-hooks.md` for why.

## Setup: credentials file

Config is read from CLI flags, then environment variables, then a config file at:

```
~/.doNotCommit.d/.doNotCommit.droprelay
```

This follows this machine's existing convention of keeping untracked secrets in
`~/.doNotCommit.d/.doNotCommit.<name>` files sourced from the shell profile — never
a repo-local `.env`, and never anything committed. The file is simple `KEY=value`
lines; an optional leading `export ` and surrounding quotes are both tolerated, so
the same file can be sourced by a shell profile if you want:

```sh
# ~/.doNotCommit.d/.doNotCommit.droprelay
export DROP_USERNAME=your-username
export DROP_PASSPHRASE="a long random passphrase, not a real password"
export DROP_AUTH=team-shared-code-word
# optional — defaults to https://flare576.com/drop/api if omitted
export DROP_API_BASE=https://flare576.com/drop/api
```

`DROP_USERNAME`/`DROP_PASSPHRASE` derive the AES-GCM key and the opaque userId (via
`generateUserId()` in `shared/crypto.ts`) — the relay never sees either value, only
the derived userId and encrypted `{iv, ciphertext}` blobs. `DROP_AUTH` is a separate,
unencrypted, shared **team gate** — not a per-user secret and unrelated to encryption —
checked by the relay against an `allowed_auth` DB table via the `X-Drop-Auth` header. A
leaked `DROP_AUTH` value lets someone spam the relay with garbage ciphertext under a
made-up userId; it cannot expose the contents of anything, which still requires the
passphrase. **Never commit this file or put these values in a repo-local `.env`.**

Precedence when a value is set in more than one place: CLI flag > environment
variable > this config file. Missing `DROP_USERNAME`/`DROP_PASSPHRASE`/
`DROP_AUTH` fails immediately with a named list of exactly what's missing —
there is no silent partial attempt.

## What it does

By default, computes and pushes a git working-tree diff. Pass `--input <path>` to push
the raw bytes of a file instead.

1. **Diff mode** (default): confirms the cwd is inside a git repo (`git rev-parse
   --show-toplevel`), then computes a full working-tree diff against `HEAD` — staged,
   unstaged, *and* untracked files, binary-safe — without leaving any trace in the
   real index or working tree. If the diff is empty, logs `Nothing to push (no working
   tree changes)` and exits `0` without any network call.
   **`--input <path>` mode**: never touches git. Reads the raw bytes of `<path>`
   instead. Always pushes, even if the file is empty — an explicit `--input` is
   unambiguous intent, unlike an unchanged working tree. Fails fast with a named error
   (`push.ts: --input file not found: <path>`) and exits `1` if `<path>` doesn't exist.
2. Builds the envelope: a small JSON header (`{"filename": "..."}`) followed by a
   single null byte, followed by the raw content bytes (the diff, UTF-8 encoded, or the
   input file's bytes as-is) — see `docs/adr/0010-byte-native-envelope-and-input-flow.md`
   for why it's shaped this way. `filename` defaults to `<repo-basename>-<ISO8601
   timestamp>.patch` (diff mode) or the input path's basename (`--input` mode), either
   overridable via `--filename <name>`. The relay never sees `filename` — it's inside
   the encrypted blob.
3. Derives the userId and AES-GCM key from the credentials, encrypts the envelope
   bytes, and `POST`s `{iv, ciphertext}` to `${DROP_API_BASE}/${userId}` with header
   `X-Drop-Auth: <code>`.
4. Reports the result: a success receipt (`artifactId` + `expiresAt`), or a specific
   actionable error for 403 (unrecognized team-gate code), 429 (rate limited, with a
   human-readable retry time), 400 (malformed body — a bug in this script, not your
   config), or a network failure — never a raw stack trace. Exit code is non-zero on
   any failure, so a calling script or agent can branch on it.

### On the git sequence specifically

The task's diff sequence is conceptually `git add -A -N` (intent-to-add, stages
paths without content) → `git diff HEAD --binary -M` → `git reset` (undo staging).
Run literally against a repo that already has pre-existing staged changes, a bare
`git reset` at the end unstages *everything*, including those pre-existing staged
changes — that fails the "leave the index exactly as found" requirement.

`captureDiff()` in `push.ts` gets the same diff output by copying the real
`.git/index` to a scratch file, pointing `GIT_INDEX_FILE` at the copy for the
`add -N`/`diff` steps, and deleting the copy — the real index is never opened for
writing. Verified via `shasum .git/index` before/after against a repo with
simultaneous staged + unstaged + untracked changes: identical hash both times.

```
--filename <name>   Override the derived filename
--input <path>      Push this file's raw bytes instead of computing a git diff
--username <u>      Overrides DROP_USERNAME
--passphrase <p>    Overrides DROP_PASSPHRASE
--drop-auth <code>  Overrides DROP_AUTH
--api-base <url>    Overrides DROP_API_BASE
```

## Running it

Three equivalent ways to invoke this, in order of "least setup required":

```sh
bunx drop-f                # once published to npm — no local clone needed at all
bun run drop/cli/push.ts   # curl'd down standalone (see skills/drop-diff/SKILL.md)
bun run cli/push.ts        # from inside this repo
```

All three run the exact same script — `bunx drop-f` resolves to `cli/push.ts` via the
`bin` field in `package.json`. Requires Bun either way (imports `../shared/crypto.ts`
directly — no build step, per the project's `shared/crypto.ts` being written to run
unmodified under Bun).

See `skills/drop/SKILL.md` and `skills/drop-diff/SKILL.md` for the model-facing version
of this doc — a coding agent invoking this on a user's behalf reads those, not this
file, to decide when and how to call `push.ts`.

## Installing skills (`--install`)

```sh
bunx drop-f --install
```

Copies this package's `skills/` (currently `drop`, `drop-diff`, `drop-file`) into every
detected coding harness's skill-discovery directory on this machine — Claude Code
(`~/.claude/skills/`, always attempted), OMP (`~/.omp/agent/skills/`, only if an OMP
install is detected), and OpenCode (`~/.config/opencode/skills/`, only if an OpenCode
install is detected). This is the *only* thing installing this package needs to
accomplish — `push.ts` itself needs no persistent client-side state to run (`bunx
drop-f` works standalone every time), so the sole job of an "install" step is getting
the skill markdown somewhere a harness can find it. No network, git, or crypto is
touched in this mode — see
`docs/adr/0010-byte-native-envelope-and-input-flow.md`.

If a skill is ever retired from `skills/`, its name is added to `DEPRECATED_SKILL_NAMES`
in `cli/install.ts` in the same commit — that static, developer-maintained list is the
only thing that ever removes a previously-installed skill from a target directory.
`installSkillsTo()` deliberately never infers removal candidates from runtime state
(a manifest, a diff against current source) — see
`docs/adr/0011-static-deprecated-skill-list.md` for why.

## Filename labeling (optional)

`push.ts` never branches on who or what invoked it — there's no `--harness` flag. If
you want a label visible in the pulled patch's filename (purely cosmetic; the relay
never reads or indexes it, since `filename` lives inside the encrypted blob), pass one
via `--filename`, e.g. `--filename "manual-$(date -u +%Y-%m-%dT%H-%M-%SZ).patch"`.
