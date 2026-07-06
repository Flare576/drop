# 9. Docker for local PHP tooling, not a host install

## Status
Accepted

## Context
`api/` is plain PHP with no framework, no Composer dependency, and no PHPUnit suite —
by design (see the sibling ADRs on this host's constraints). But QA and development
still need to actually *run* it: lint for syntax errors, and exercise real HTTP
requests against a live relay + MySQL-compatible database to verify auth gates, path
validation, and TTL/expiry behavior — the kind of finding that reading source alone
can't surface (see Consequences: this exact setup caught a real bug on first use).

Installing PHP + MySQL/MariaDB directly on the host was the alternative. Rejected:
this is a single-purpose personal project's dev dependency, not something that should
permanently occupy space in `brew list` or need version-matching against whatever
PHP/MySQL versions flare576.com's IONOS hosting actually runs. Docker was already
present on the host machine (used elsewhere in `~/Projects/RP` — see `tailboard-
server`'s `.vroom`) and needed no new tooling investment.

## Decision
`docker-compose.yml` (repo root) defines two throwaway services: `db` (`mariadb:11`,
schema auto-loaded from `api/schema.sql` + a dev-only auth-code seed from
`docker/seed-dev.sql` on first boot) and `api` (`php:8.3-cli-alpine`, installs
`pdo_mysql` at container start, serves `api/` via PHP's built-in server through
`docker/dev-router.php` — a dev-only router mirroring `api/.htaccess`'s rewrite rule).
`api/config.php` is generated locally from `api/config.php.template` (same mechanism
CI uses for the real deploy, just with dev credentials substituted) via `vroom setup`,
and is gitignored exactly like the production version already was.

Driven through `.vroom`, not raw `docker compose` invocations, so the same lifecycle
verbs (`vroom -s` / `vroom -r` / `vroom -d`) work here as everywhere else in this
project's family of repos: `setup` generates config + installs JS deps, `run` brings
the stack up (`--wait` for both healthchecks), `stop` pauses it, `destroy` tears
everything down including the anonymous MySQL volume and the generated config. A
custom `api-lint` target runs `php -l` across every file in `api/` without needing the
DB dependency (`--no-deps`).

Everything Docker-related lives outside `api/` (`docker-compose.yml` at repo root,
`docker/dev-router.php`, `docker/seed-dev.sql`) so none of it is ever at risk of being
swept into the production SFTP deploy, which ships `api/` verbatim.

## Consequences
- No PHP, MySQL, or MariaDB ever needs to be installed on the host machine. `vroom -d`
  leaves zero trace (containers, network, and the anonymous data volume are all
  removed together; config.php is deleted).
- **This setup found a real, previously-shipped bug on its very first run**: `api/
  drop.php` was missing its docblock's opening `/**` (line 3), making the entire file
  a PHP syntax error — meaning the relay's route handlers have been unparseable, and
  every request has 500'd, since the file was first committed. `deploy.yml`'s `test`
  job only runs `npm test`; nothing in CI has ever actually parsed the PHP. Fixed
  alongside this ADR (see the commit that introduced this file). This is the concrete
  argument for why "point Docker at real PHP" beats "read the PHP and trust it parses."
- The dev auth code (`dev-local-only` in `docker/seed-dev.sql`) is not a secret and
  must never be treated as one — it only exists inside a throwaway local container,
  never touches the real `allowed_auth` table on flare576.com (see ADR 0002 for why
  that table is never seeded from a committed file in the first place).
- `vroom`'s auto-detection (`configure_type` in the vroom script itself) would default
  this repo to `type=compose` purely because `docker-compose.yml` exists at the root —
  wrong, since `drop-f`'s primary consumable artifact is the npm package, not the PHP
  stack. `.vroom` pins `vroom_type = npm` explicitly and exposes the Docker lifecycle
  as scoped custom targets (`api-lint`, `api-logs`, `api-shell`) plus overridden `run`/
  `stop`/`destroy`, rather than letting auto-detection pick for us.
