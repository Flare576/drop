# 3. Skills over hooks (and over slash commands) for triggering a push

## Status
Accepted (supersedes an earlier in-repo design)

## Context
The original `cli/README.md` documented `push.ts` wired to a lifecycle hook — OMP's
`agent_end` and Claude Code's `Stop` event — firing automatically after every agent
run, no human in the loop. On reflection this was wrong for the actual use case: it
pushes whatever's dirty in the working tree regardless of whether the user intended to
ship it yet, gives no review checkpoint before client (Elevance) code leaves the
machine, and contradicts "send *specific* artifacts" (a hook has no concept of
"specific," it just diffs everything dirty every time it fires).

Slash commands were also considered and explicitly rejected, on stated preference, not
a technical constraint: invoking a named command reads as directing the agent
imperatively, which isn't the interaction model wanted here — the preference is for
the agent to decide it's time, or for the human to *ask* conversationally, not issue a
command.

## Decision
Expose `push.ts` via two skill files (`skills/drop/SKILL.md`, `skills/drop-diff/
SKILL.md`) — passive markdown, read into context on invocation, describing when and how
to call the CLI. No hook wiring shipped as the primary path. The CLI itself
(`cli/push.ts`) stays a plain standalone script with zero knowledge of *why* it was
invoked — the trigger mechanism is entirely a documentation-layer choice, not a code
change, which is what made this decision cheap to reverse if it turns out wrong.

## Consequences
- Nothing pushes without either the agent deciding contextually or the human asking —
  no silent background pushes of work-in-progress.
- Skills are model-facing documentation, not enforced behavior — a coding agent could
  still choose to push more or less often than intended, since there's no code-level
  gate on invocation frequency (unlike, say, the server's rate limiter, which *is*
  enforced). This is an accepted tradeoff of the "passive markdown" skill model, not an
  oversight.
- If a future harness genuinely needs an automatic trigger (e.g. a CI pipeline pushing
  build artifacts on a schedule), that's a new, explicit decision to revisit this ADR —
  not a silent reversion to the old hook-based design.
