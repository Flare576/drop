# drop

Zero-knowledge, client-side-encrypted dead-drop relay. Push an artifact — a git diff,
or the raw bytes of any file — from one machine, pull and decrypt it on another — the
relay never sees plaintext, the passphrase, or the derived key.

## Running `drop-f`

**Requires [Bun](https://bun.sh)** — install with `curl -fsSL https://bun.sh/install | bash`
if you don't already have it. `push.ts` uses Bun-only APIs internally, not just Bun as
a convenient TypeScript-without-a-build-step runtime, so this isn't optional.

```sh
bunx drop-f
```

There is nothing to install for the CLI itself — `bunx drop-f` fetches and runs
`push.ts` directly, every time, always the latest published version. It's the
**only** thing `push.ts` needs on a machine to work; it doesn't touch or require
`api/`, `web/`, or any local server (those exist purely so *this repo's* maintainer
can run/deploy the relay itself).

(`npm install -g drop-f` also technically works, since npm just wires up a `drop-f`
command pointing at the same file — its own `#!/usr/bin/env bun` shebang is what
actually runs it, same as `bunx`. But it buys nothing here: no faster startup worth
noticing, no offline story that matters for a tool whose whole job is talking to a
live relay, and it freezes at whatever version you installed instead of always
resolving latest. There's no reason to prefer it over `bunx drop-f`.)

Before running it, three environment variables must be set — the CLI fails immediately
with a named list of whatever's missing rather than attempting a partial push:

```sh
export DROP_USERNAME=your-username
export DROP_PASSPHRASE="a long random passphrase, not a real password"
export DROP_AUTH=team-shared-code-word
```

See `cli/README.md` for exactly how these are used (derivation, precedence vs CLI
flags, where to store them), how `--install` places the agent-facing skills below onto
this machine, and `skills/drop-diff/SKILL.md`/`skills/drop-file/SKILL.md` for the
agent-facing version of pushing.

## Layout

- `cli/` — Bun-native push CLI (`drop-f` on npm). See `cli/README.md`.
- `api/` — PHP/MySQL relay, deployed to flare576.com. See `api/README.md`.
- `web/` — vanilla-JS browser pull UI. See `web/README.md`.
- `shared/` — crypto module shared by `cli/` (TypeScript) and hand-ported to
  `web/crypto.js` (browsers can't run `.ts`).
- `skills/` — `drop`/`drop-diff`/`drop-file`, the agent-facing docs coding harnesses
  actually read.
- `docs/adr/` — architecture decision records; read these before changing behavior
  that looks arbitrary. It probably isn't.

## Local development

No PHP or MySQL/MariaDB install on this machine is required — `api/` runs entirely in
Docker (see `docs/adr/0009-docker-for-local-php.md` for why). Everything is driven
through [`vroom`](https://github.com/flare576/vroom) via the `.vroom` file:

```sh
vroom -s   # bun install; generate api/config.php with dev DB credentials
vroom -r   # bring up the api + db containers (waits for both healthchecks)
vroom -d   # tear down containers, volume, and generated config — leaves no trace
```

Once running, the relay answers on `http://localhost:8080/drop/api/{userId}` exactly
like production (same router dispatch, same auth gates). A dev-only team-gate code,
`dev-local-only`, is seeded automatically for local `X-Drop-Auth` testing — it only
ever exists inside the throwaway container, never touches the real database.

Other targets:

```sh
vroom test        # bring up the stack (waits healthy) and run the full test:all suite
vroom api-lint    # php -l across every file in api/, no DB needed
vroom api-logs    # tail the api container's log
vroom api-shell   # shell into the api container
vroom stop        # pause containers without removing them
```
