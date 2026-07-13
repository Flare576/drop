# 12. Single invocation mechanism: `bunx drop-f`, no curl'd-down standalone mode

## Status
Accepted

## Context
The agent-facing skills (`skills/drop-diff/SKILL.md`, `skills/drop-file/SKILL.md`)
accumulated a second way to run `push.ts`, alongside `bunx drop-f`: `curl` down
`cli/push.ts` + `shared/crypto.ts` into a scratch `drop/` directory and `bun run` it
directly. This wasn't a deliberate design decision — no prior ADR argued for it — it
accreted while the tool and skills were being built iteratively, before `drop-f` was
published to npm.

It broke in practice: `push.ts` gained a top-level `import { runInstall } from
"./install.ts"` (used only behind `--install`, but a static import still has to
resolve the module at load time regardless of which branch runs). The curl
instructions only listed two files, so a curl'd-down invocation failed immediately
with `Cannot find module './install.ts'` even for a plain push that never touches
`--install`. Reproduced directly: a two-file curl layout fails; adding the third file
fixes it.

Patching the docs to list three files instead of two treats the symptom, not the
disease. `push.ts`'s module graph is an implementation detail that can change shape
again at any time (another local helper file tomorrow), and a doc that enumerates
exactly which files a script needs is a maintenance trap — it silently goes stale the
moment the graph changes, with no compiler or test to catch it. The root `README.md`
already reflects a stronger, correct stance: `bunx drop-f` fetches and runs the
current published package in one step, every file it needs, every time, and even
`npm install -g drop-f` is called out as buying nothing over it. The skills and
`cli/README.md` had drifted from that stance.

The scenario a curl'd-down fallback would hypothetically protect against — Bun
installed, but the npm registry unreachable — also contradicts this tool's own stated
deployment model: the *pushing* side is explicitly "hardware that can freely reach the
internet" (`skills/drop/SKILL.md`, "When to use this"); the restricted-network side is
the human's browser on the *pulling* end, which never runs any CLI at all. There is no
real-world case in this tool's intended use where the push side has Bun but not npm
registry access.

## Decision
One invocation mechanism for running `push.ts`, full stop:

```sh
bunx drop-f                # the only way the agent-facing skills ever invoke this
bun run cli/push.ts        # dev loop only: testing unreleased changes, from inside
                            # a real clone of this repo — not a documented "skill" flow
```

No curl/clone/copy-down fallback is documented or recommended anywhere in
`skills/drop/SKILL.md`, `skills/drop-diff/SKILL.md`, `skills/drop-file/SKILL.md`, or
`cli/README.md`. `--install` remains a separate, unrelated concern (copying this
package's `skills/` into local harness directories) — it doesn't change which command
runs a push.

## Consequences
- Any future change to `push.ts`'s local imports (new helper file, refactor) can never
  break the documented invocation path — `bunx drop-f` always fetches the real,
  current package, so there's nothing for a doc to enumerate or get stale.
- If a genuine offline/registry-blocked scenario ever shows up on the pushing side,
  that's new information contradicting this ADR's Context section — revisit this
  decision then, with that evidence, rather than speculatively re-adding a fallback
  now.
- A maintainer testing unreleased `push.ts` changes still uses `bun run cli/push.ts`
  from a full clone (which naturally has every file, no manual enumeration needed) —
  this is unaffected by removing the curl-a-few-files shortcut, which only ever
  applied to the published-package consumer path.
