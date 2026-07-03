# 6. Git diff/patch, not git bundle, as the artifact format

## Status
Accepted

## Context
Early design discussion considered `git bundle` for the pushed artifact — it preserves
full ref history, is independently verifiable (`git bundle verify`), and handles
renames/binaries natively. But a `git bundle` requires committed refs; the typical
state of a coding-agent session is **uncommitted working-tree changes** (staged,
unstaged, and untracked files), which a bundle can't represent without forcing a commit
first — an unwanted side effect on the caller's repo.

## Decision
Use a plain `git diff HEAD --binary -M` patch instead — captures staged, unstaged, and
untracked changes (via the intent-to-add trick in `cli/push.ts`'s `captureDiff()`),
handles renames (`-M`) and binary files (`--binary`), and needs no commit. The
destination side is expected to review the patch (readable diff text) and `git apply`
it manually — not auto-apply — giving a human checkpoint before anything lands in the
target repo.

## Consequences
- No forced commits, no working-tree side effects on the source machine (verified: the
  intent-to-add + scratch `GIT_INDEX_FILE` approach leaves the real index and working
  tree byte-identical before/after).
- The destination side never gets a `git log`-style history — just a flat diff against
  whatever `HEAD` was at push time. If the destination repo's `HEAD` has since diverged,
  `git apply` may conflict; that's an accepted manual-review cost, not something the
  relay tries to solve automatically.
- If a future need arises to hand off *committed* history (e.g. several small commits
  that should land as-is, not squashed into one diff), that's a genuinely different
  artifact shape — a new sibling flow, not a change to `drop-diff` itself (see also the
  general `skills/drop/SKILL.md`'s framing of git-diff as one concrete flow among
  possible others).
