---
name: release
description: "Load when cutting a new drop-f release — version bump, tag, npm publish via GitHub Actions OIDC. Runs the pre-flight checklist interactively with Flare confirming each gate before proceeding. Triggers: 'cut a release', 'bump the version', 'tag and publish', 'release v0.x.y', 'ship drop-f'."
---

# Release Skill — drop-f

You are running a release for the `drop-f` npm package (repo `Flare576/drop`). This is a
**collaborative, step-by-step process** — run each check, report the result to Flare, and
confirm before proceeding. Do not batch steps silently.

**Always use the `git-master` skill for all git operations** (commit, tag, push).

---

## Step 0: Orient

Run in parallel, report all results to Flare before doing anything else:

```bash
node -e "console.log(require('./package.json').version)"
git branch --show-current
git status --short
git tag -l --sort=-version:refname | head -5
npm view drop-f version   # last version actually LIVE on the registry — may differ from git tags, see gotcha below
```

Suggest the next patch version unless Flare already gave a target. **Confirm the target
version AND the release codename with Flare before touching anything** — this project
tags every release with a name (e.g. `v0.0.2` "Drop Zone"), not just a bare semver.

---

## Pre-Flight Checklist (run in order — stop and report on any failure)

### Check 1 — Clean working tree
```bash
git status --short
```
Anything uncommitted unrelated to the version bump: STOP, ask Flare how to handle it.

### Check 2 — On main, up to date
```bash
git branch --show-current
git fetch origin && git status
```
Not on `main`, or behind origin: STOP. Never tag from a branch or a stale checkout.

### Check 3 — Docs cross-check (do this yourself; don't just ask)

"Did you update the docs?" as a verbal question already failed once — docs got updated
during the feature work but root `README.md` was never re-checked against the final
state before the release that shipped it. Do this as an active step, not a question:

1. Diff every doc file against the last tag to see what's *already* changed:
   ```bash
   git diff $(git describe --tags --abbrev=0)..HEAD --stat -- '*.md' 'docs/adr/**'
   ```
2. Independently list what actually changed in code since the last tag — new/removed
   CLI flags, new artifact shapes, renamed package, new skills, changed env vars:
   ```bash
   git diff $(git describe --tags --abbrev=0)..HEAD --stat -- cli/ shared/ web/ skills/ package.json
   ```
3. Cross-check step 2's list against **every** doc file, one by one, even ones you
   already touched earlier in the session — `README.md` (root), `cli/README.md`,
   `api/README.md`, `web/README.md`, `skills/drop/SKILL.md`, `skills/drop-diff/
   SKILL.md`, and any other `skills/*/SKILL.md`. Root `README.md` is the one most
   likely to be skipped, since feature work tends to touch the subsystem-specific
   READMEs directly and never circles back to the top-level overview — check it
   explicitly, don't assume "I updated docs during the feature" covered it.
4. Only after that cross-check, tell Flare what you found/fixed. Don't ask an open
   question and accept a verbal "yeah I think so" as the check passing.

### Check 4 — Full local test harness (same gate CI runs)
```bash
npm run test:all
```
This is `typecheck` + `test:bun` (`tests/bun/unit`, `cli`, `api`) + `test:browser`
(Playwright). The `api` suite spins up the Docker stack itself via `vroom -s`/`vroom -r`
(see `tests/bun/helpers/docker-stack.ts`) and tears it down after — no manual setup step,
but it does need Docker running locally. Any failure: STOP, fix before proceeding.

### Check 5 — Package manifest sanity
```bash
npm pack --dry-run
```
Confirm: correct package name, correct version in the tarball filename, and the file list
matches `package.json`'s `"files"` field (`cli/`, `shared/`, `skills/`, `README.md`,
`LICENSE` — nothing accidentally missing or extra). You'll see an
`npm warn publish "bin[drop-f]" script name … was invalid and removed` line — this is
**cosmetic, not a real removal** (see Gotchas below); confirm the live tarball's `bin`
field afterward if you want to be certain, don't treat the warning itself as a failure.

---

## Release Steps (only after Flare confirms all checks pass)

1. **Bump version** in `package.json` — update `"version"`.

2. **Regenerate both lockfiles** — this repo has two, and both embed the version:
   ```bash
   npm install --package-lock-only
   rm bun.lock && bun install
   ```
   (`bun install` alone often no-ops without the `rm` first — it doesn't always detect
   that only the version changed.)

3. **Typecheck once more** as a fast sanity check after the bump:
   ```bash
   npm run typecheck
   ```

4. **Commit** (package.json + both lockfiles together — they're one atomic change):
   ```bash
   git add package.json package-lock.json bun.lock
   git commit -m "chore: bump version to {VERSION}"
   git push origin main
   ```

5. **Tag** — annotated, with the codename as the message:
   ```bash
   git tag -a v{VERSION} -m "{Codename}"
   git push origin v{VERSION}
   ```

6. **Watch both workflows** (`Publish to npm`, `Deploy to flare576.com`) to completion:
   ```bash
   gh run list --branch=v{VERSION} --json workflowName,status,conclusion
   ```
   Poll until both show `"status":"completed"`. Report the `conclusion` of each to Flare.
   Don't declare the release done on a queued/in_progress read.

7. **Confirm live**:
   ```bash
   npm view drop-f version
   ```
   Should match `{VERSION}`.

---

## Gotchas (hard-won, from v0.0.1 → v0.0.2)

- **A published version can never be reused, even after a CI failure that happened
  after the publish succeeded.** If `npm publish` succeeds (manually or via CI) and
  something *else* downstream fails, you cannot re-push the same tag/version — npm
  rejects it with `403 You cannot publish over the previously published versions`.
  The only fix is bumping to the next version and re-tagging. `npm view drop-f version`
  is more trustworthy than the latest git tag for "what's actually live," since a tag
  can exist whose publish job failed.

- **First-ever publish of a brand-new package name must happen manually, once**, from
  a local machine (`npm login && npm publish --access public`) — npm's trusted
  publishing (OIDC) can only be configured for a package that already exists on the
  registry. Every release after that first bootstrap goes through CI normally. If this
  package's name ever changes again, this bootstrap step repeats from scratch.

- **npm's package-name similarity blocker is fuzzy and unpredictable.** It rejected
  `f-drop` as "too similar" to an existing `fdrop`, and will plausibly reject other
  near-transpositions too (we got lucky with `drop-f`). There's no way to check this
  in advance — `npm view <name>` only tells you if the exact name is taken, not
  whether publish will be blocked on similarity. You only find out by attempting the
  publish.

- **Trusted Publisher config on npmjs.com must match the workflow's `environment:`
  field EXACTLY** — package Settings → Trusted Publisher → GitHub Actions requires the
  repo, workflow filename (`publish.yml`, not the full path), and **environment name**
  to match what's actually declared in the workflow YAML
  (`.github/workflows/publish.yml`'s `environment: NPM` job key). A mismatch here
  doesn't fail loudly with a clear "wrong environment" error — it surfaces as a bare
  `404 Not Found - PUT .../drop-f` on the publish step, which looks identical to an
  auth failure or a missing package. This is exactly what broke the v0.0.2 first
  attempt: npmjs.com was configured for `prod`, the workflow said `NPM`. Fixed by
  changing the npmjs.com config to match the workflow, not the other way around,
  since other release infra (ei) already used `NPM` as the convention.

- **The `bin[drop-f]" script name … was invalid and removed` warning during publish is
  a false alarm.** It fires because npm's `secureAndUnixifyPath` normalizes
  `"./cli/push.ts"` to `"cli/push.ts"` (stripping the leading `./`) and then logs any
  value it had to change as "invalid and removed" — misleading wording for what's
  actually just normalization. Verify the real behavior instead of trusting the
  wording: `npm view drop-f bin` and/or `bunx drop-f` from a scratch directory.

- **Never set `NODE_AUTH_TOKEN`** (even to an empty string) in the publish job's env
  when relying on OIDC trusted publishing — its mere presence makes npm try classic
  token auth instead of the OIDC exchange. `publish.yml` doesn't currently set this;
  keep it that way.

- **Both lockfiles (`package-lock.json`, `bun.lock`) embed the root package version**
  and go stale independently — `npm install --package-lock-only` won't touch
  `bun.lock`, and `bun install` alone frequently no-ops on a version-only change
  without deleting `bun.lock` first. Regenerate both, every version bump, or CI's
  `npm ci` (which reads `package-lock.json`) and local `bun test` (which reads
  `bun.lock`) can silently diverge on what "the package" even is.
