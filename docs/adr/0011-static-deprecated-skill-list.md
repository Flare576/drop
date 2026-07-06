# 11. Static deprecated-skill list, never dynamic diffing, for install cleanup

## Status
Accepted

## Context
`cli/install.ts`'s `installSkillsTo()` needs to remove a previously-installed skill
from a harness's skill directory when drop-f stops shipping it. The first attempt at
this (a `.drop-f-skills.json` manifest written after every install, diffed against
current source on the next run to infer what to remove) shipped with two real bugs,
both found by independent Beta reviews:

- **Path traversal (Critical).** A manifest entry was passed straight into `rm(join(
  targetDir, staleName), {recursive: true, force: true})` with no validation.
  `path.join()` normalizes `..` segments, so an entry like `"../../../outside-victim"`
  escaped `targetDir` entirely — an arbitrary recursive delete under the current
  user's permissions, driven by data the mechanism itself had written and later
  trusted on read.
- **Destructive false success (Important).** A source-read failure (unreadable or
  vanished `sourceDir`) was treated identically to "the skill was intentionally
  removed" — a transient failure silently wiped every previously-installed skill and
  wrote an empty manifest, without the install step ever throwing, so `runInstall()`
  reported success on a run that destroyed state instead of installing anything.

Both bugs share one root cause: inferring *what to delete* from runtime state (a
diff between "what does the manifest say I installed" and "what does source have
right now") turns two ordinary failure modes — a malformed/tampered file, a transient
read error — into a destructive operation. Any mechanism that decides deletions
dynamically from data that can be wrong, missing, or hostile carries this risk by
construction, not by a fixable implementation detail.

## Decision
Remove the dynamic mechanism entirely. `cli/install.ts` now maintains a static,
developer-committed constant:

```ts
const DEPRECATED_SKILL_NAMES: readonly string[] = [
  // e.g. "old-skill-name",
];
```

This is the *only* thing that ever removes a skill from a target directory.
`installSkillsTo()` unconditionally `rm`s every name in this list (via `basename()`
first, as defense-in-depth against a future typo even though these are compile-time
string literals, never runtime-controlled input) and otherwise never compares
`targetDir`'s contents against current source at all. When a skill is actually
retired from `skills/`, its name is added to this list in the *same commit* — a
deliberate, reviewed, human/agent-authored step, not an inference.

## Consequences
- Both bug classes are structurally impossible now, not merely patched: there is no
  runtime-read data that ever reaches an `rm()` target, and a source-read failure can
  only ever mean "installed nothing this run" — it has no path to a deletion at all.
- A skill that disappears from `skills/` without a matching `DEPRECATED_SKILL_NAMES`
  entry is left installed indefinitely in any target directory that already has it.
  This is an accepted tradeoff, not an oversight: the alternative (auto-detect and
  remove) is exactly the mechanism just removed for being unsafe. Retiring a skill is
  rare and deliberate enough that a one-line list entry in the same commit is a
  reasonable, explicit cost.
- `targetDir` may hold skills belonging to other tools entirely (shared discovery
  directories like `~/.claude/skills/` — `ei` installs into these same paths). This
  design never risks touching them, by construction: the only removal candidates are
  literal names a developer typed into drop-f's own source.
- If a future need arises for automatic cleanup of *drop-f's own* stale installs
  (e.g. because the deprecated-list maintenance burden becomes real), that is a new,
  explicit decision to revisit this ADR — any replacement must not reintroduce
  "infer deletions from data that can be wrong" as its mechanism.
