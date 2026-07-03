# push.ts

Standalone Bun CLI that encrypts a git working-tree diff and pushes it to the drop
relay, so a coding harness running on unrestricted hardware can hand a diff to a
locked-down client VDI's browser to pull down later. It is invoked by a shell
command from a harness's hook config — it has **zero knowledge of which harness
called it**. The only harness-specific work lives in the hook config, not in this
file.

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

1. Confirms the cwd is inside a git repo (`git rev-parse --show-toplevel`).
2. Computes a full working-tree diff against `HEAD` — staged, unstaged, *and*
   untracked files, binary-safe — without leaving any trace in the real index or
   working tree.
3. If the diff is empty, logs `Nothing to push (no working tree changes)` and exits
   `0` without any network call.
4. Builds the envelope `{filename, patch}`. `filename` defaults to
   `<repo-basename>-<ISO8601 timestamp>.patch` (colons/dots sanitized to dashes) or
   uses `--filename <name>` if given. The relay never sees `filename` — it's inside
   the encrypted blob.
5. Derives the userId and AES-GCM key from the credentials, encrypts the envelope,
   and `POST`s `{iv, ciphertext}` to `${DROP_API_BASE}/${userId}` with header
   `X-Drop-Auth: <code>`.
6. Reports the result: a success receipt (`artifactId` + `expiresAt`), or a specific
   actionable error for 403 (unrecognized team-gate code), 429 (rate limited, with a
   human-readable retry time), 400 (malformed body — a bug in this script, not your
   config), or a network failure — never a raw stack trace. Exit code is non-zero on
   any failure, so a hook can branch on it.

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
--filename <name>   Override the derived patch filename
--username <u>      Overrides DROP_USERNAME
--passphrase <p>    Overrides DROP_PASSPHRASE
--drop-auth <code>  Overrides DROP_AUTH
--api-base <url>    Overrides DROP_API_BASE
```

## Running it

Three equivalent ways to invoke this, in order of "least setup required":

```sh
bunx f-drop                # once published to npm — no local clone needed at all
bun run drop/cli/push.ts   # curl'd down standalone (see skills/drop-diff/SKILL.md)
bun run cli/push.ts        # from inside this repo
```

All three run the exact same script — `bunx f-drop` resolves to `cli/push.ts` via the
`bin` field in `package.json`. Requires Bun either way (imports `../shared/crypto.ts`
directly — no build step, per the project's `shared/crypto.ts` being written to run
unmodified under Bun).

See `skills/drop/SKILL.md` and `skills/drop-diff/SKILL.md` for the model-facing version
of this doc — a coding agent invoking this on a user's behalf reads those, not this
file, to decide when and how to call `push.ts`.

---

## Hook integration

`push.ts` doesn't reimplement anything per-harness — every example below just shells
out to it. Reasoning for *when* to fire it: a push should happen once per meaningful
chunk of agent work, not on every tool call, so both integrations below use each
harness's end-of-turn/end-of-response event rather than a per-tool-call event.

### OpenCode / OhMyPi

OhMyPi hook modules live at `.omp/hooks/*.ts` and default-export a factory
`(pi: HookAPI) => void` that registers handlers via `pi.on(event, handler)` and
shells out via `pi.exec(...)`. The relevant event surface (per `omp://hooks.md`)
includes `agent_end` (agent/session finished) and `turn_end` (one model turn
finished). `agent_end` is the better fit here — it fires once when the whole agent
run concludes, matching "one push per meaningful chunk of work," where `turn_end`
would fire on every individual model turn inside a longer agent loop and could push
far more often than intended.

`.omp/hooks/push-to-drop.ts`:

```ts
import type { HookAPI } from "@oh-my-pi/pi-coding-agent/extensibility/hooks";

export default function hook(pi: HookAPI): void {
  pi.on("agent_end", async (_event, ctx) => {
    const result = await pi.exec("bun run cli/push.ts", { cwd: ctx.cwd });

    if (result.exitCode !== 0) {
      ctx.ui.setStatus("push-to-drop", `push failed: ${result.stderr?.trim() || "unknown error"}`);
    }
  });
}
```

(Adjust the `pi.exec` call signature/return shape to whatever your installed OMP
version's `HookContext` actually exposes — the shape above follows the documented
`pi.on(event, handler)` / `ctx.ui.setStatus` surface from `omp://hooks.md`; verify
against your local `HookAPI` type before relying on `result.exitCode`/`stderr`
field names.)

Where the env vars live: same as any other machine secret on this box — a local,
untracked env file such as `~/.doNotCommit.d/.doNotCommit.droprelay` (see above),
sourced by your shell profile or just left for `push.ts` to read directly. Nothing
OMP-specific is needed here since `push.ts` resolves its own config.

### Claude Code

Claude Code hooks are configured in a `settings.json` (`~/.claude/settings.json` for
all projects, or `.claude/settings.json` for one project) under a top-level `hooks`
key mapping an event name to matcher groups, each with one or more hook handlers.
**Verified against the current official Claude Code hooks reference
(`code.claude.com/docs/en/hooks`, fetched during this task) — not a guess.**

The relevant event is `Stop`: it fires once when the main agent finishes responding
for a turn (not on interrupts, not on every tool call), which is the closest
equivalent to OMP's `agent_end`/`turn_end` cadence for "push once per meaningful
chunk of work." `Stop` doesn't support a `matcher` field (it always fires), and a
command hook receives the event as JSON on stdin — `push.ts` doesn't need any of
that JSON, so the example below ignores stdin entirely.

`.claude/settings.json`:

```json
{
  "hooks": {
    "Stop": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "bun run cli/push.ts",
            "args": []
          }
        ]
      }
    ]
  }
}
```

Notes on this config, confirmed from the current docs:

- `args: []` (exec form) is used deliberately over shell form so no shell quoting
  is involved; `command` is resolved as an executable on `PATH`. Bun must be on
  `PATH` for the process Claude Code spawns.
- Exit code 2 from a `Stop` hook prevents Claude from stopping and continues the
  conversation — `push.ts` never exits 2, only 0 or 1, so it can never accidentally
  trap Claude Code in a stop loop; a push failure is just reported to the transcript
  as a non-blocking hook error (any non-zero, non-2 exit code) and the turn still
  ends normally.
- If you'd rather fire it once per subagent instead of once per top-level turn, the
  same handler shape applies under `SubagentStop`. `PostToolUse` (after every tool
  call) was intentionally not used here — it fires far more often than "once per
  meaningful chunk of work" and would spam pushes.

Where the env vars live: identical story to the OMP integration above — a local,
untracked env file (e.g. `~/.doNotCommit.d/.doNotCommit.droprelay`) that `push.ts`
reads itself. `settings.json` needs no secrets in it at all, so this file is safe to
commit to the repo if you want the hook wiring shared with a team, as long as no one
puts real credentials directly in `settings.json`.

### Harness-agnostic by construction

`push.ts` itself never branches on which harness invoked it. There is no
`--harness` flag; if you want a harness label visible in the pulled patch's
filename (purely cosmetic — the relay never reads or indexes it, since `filename`
lives inside the encrypted blob), pass one via `--filename`, e.g.
`--filename "omp-$(date -u +%Y-%m-%dT%H-%M-%SZ).patch"` in shell form (drop
`args: []`/use a plain `command` string so the shell expands `$(date ...)`).
Swap either hook config for a different one (a plain cron job, a git pre-push
hook, a manual terminal alias) and `push.ts` runs identically.
