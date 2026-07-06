# drop

Zero-knowledge, client-side-encrypted dead-drop relay. Push an artifact (a git diff,
today) from one machine, pull and decrypt it on another — the relay never sees
plaintext, the passphrase, or the derived key.

## Installing the CLI

```sh
npm install -g drop-f   # or: bunx drop-f (no install, runs the latest published version each time)
```

`npm install -g drop-f` (or the local `bunx drop-f` form) installs **only the push
side** — the `push.ts` CLI that encrypts and sends an artifact. It does not touch or
require `api/`, `web/`, or any local server; those exist purely so *this repo's*
maintainer can run/deploy the relay itself. Installing the CLI package elsewhere never
pulls in the API or web code.

Before running it, three environment variables must be set — the CLI fails immediately
with a named list of whatever's missing rather than attempting a partial push:

```sh
export DROP_USERNAME=your-username
export DROP_PASSPHRASE="a long random passphrase, not a real password"
export DROP_AUTH=team-shared-code-word
```

See `cli/README.md` for exactly how these are used (derivation, precedence vs CLI
flags, where to store them) and `skills/drop-diff/SKILL.md` for the agent-facing
version of this same setup.

## Layout

- `cli/` — Bun-native push CLI (`drop-f` on npm). See `cli/README.md`.
- `api/` — PHP/MySQL relay, deployed to flare576.com. See `api/README.md`.
- `web/` — vanilla-JS browser pull UI. See `web/README.md`.
- `shared/` — crypto module shared by `cli/` (TypeScript) and hand-ported to
  `web/crypto.js` (browsers can't run `.ts`).
- `skills/` — `drop`/`drop-diff`, the agent-facing docs coding harnesses actually read.
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
vroom api-lint    # php -l across every file in api/, no DB needed
vroom api-logs    # tail the api container's log
vroom api-shell   # shell into the api container
vroom stop        # pause containers without removing them
```
