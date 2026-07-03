# 8. Isolated SFTP account + database per app

## Status
Accepted

## Context
`drop` shares a physical host (flare576.com, IONOS shared hosting) with two sibling
personal projects, `ei` and `mylibrary`. The faster path to standing up `drop` would
have been reusing `ei`'s existing SFTP account and MySQL database — secrets already
exist, no new provisioning needed. The alternative, explicitly chosen instead: a new
SFTP account and a new MySQL database, provisioned specifically for this app.

## Decision
`drop` gets its own SFTP account (rooted at its own subfolder, mirroring how `ei`'s own
account is rooted at `/ei`) and its own MySQL database, with its own GitHub Actions
secrets (`SFTP_HOST`/`SFTP_USERNAME`/`SFTP_PASSWORD` at repo level, `DB_HOST`/
`DB_USERNAME`/`DB_PASSWORD`/`DB_DATABASE`/`DATA_PATH` at the `Prod` environment level —
all unprefixed, since GitHub secrets are already repo-scoped and don't need an
app-specific prefix for isolation). No credentials are shared with `ei` or `mylibrary`.

## Consequences
- Real cost paid up front: a second SFTP account and a second database had to be
  manually created in the IONOS panel, rather than reusing what already existed.
- Real benefit: `drop` carries client (Elevance) source code, a materially higher
  scrutiny bar than `ei`'s personal notes or `mylibrary`'s game-library data. A bug,
  compromise, or misconfiguration in `drop` cannot touch `ei`'s or `mylibrary`'s data,
  and vice versa — the blast radius of any incident in one app is contained to that
  app's own isolated storage. This also gives a clean, simple answer if anyone (R&P
  security, Elevance, an auditor) ever asks what infrastructure client code touches:
  a dedicated account and database, not a shared personal-project database with
  unrelated data alongside it.
- The tradeoff is provisioning overhead for any *future* sibling app under the same
  "drop" umbrella (e.g. a hypothetical `drop-zip` or `drop-file` variant per
  `skills/drop/SKILL.md`'s framing) — each would need this same isolated-infra decision
  revisited, not an assumption that they can piggyback on `drop`'s existing account.
