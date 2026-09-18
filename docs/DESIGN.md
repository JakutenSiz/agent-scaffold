# Design — why each mechanism exists

This package was distilled from a multi-repo product that was developed with AI agents
for most of a year. Every mechanism below earned its place by a measured failure; the
lessons are stated without the product's names. If you drop a mechanism, drop it knowing
what it was protecting against.

## The two layers

**Fixed layer** (`core/`): process that does not depend on the project. **Generated
layer** (`core/templates/`, filled by the agent): everything that does. The split is what
makes the package generic: a new project changes the facts, not the rules. The single
config file `agent-scaffold.config.json` is the bridge — hooks and scripts read it, so
none of them hardcodes a repo name, a branch or a ceiling.

## One rule, one home

Four repos once carried byte-identical 560-line copies of the memory-bank guide. They
drifted apart on their own within weeks; nothing read three of them. The rule now: shared
rules live in exactly one file (`docs/agent-working-rules.md`, `docs/memory-bank-guide.md`,
board §9, coordination `## Protocol`) and every other file links there. `AGENTS.md` per
repo is capped at ~40 lines of repo-specific facts for the same reason.

## Delegation-first and the single-level agent tree

A main-model exploration of 130k tokens comes back from a cheap scout as a 1.5k summary.
The expensive model is kept for decisions; workers on cheaper models do reading, mechanical
edits and gate runs. The `read-guard` hook enforces it: past N reads in a turn the main
session is denied further reads until it delegates.

The tree is single-level because unrestricted workers were observed recursing and looping:
a worker spawned workers that spawned workers. Now a subagent that finds its job too big
stops and reports; the split is the architect's decision. The hook denies subagent → subagent
spawns as a second line of defense behind the agent definitions.

## Memory bank per repo

Agents forget between sessions; humans forget between weeks. The memory bank is the
repo's operational map, and its two most valuable files are `repoMap.md` ("if you want to
do X, start here") and `capabilityRegistry.md` (what already exists). Three date pickers
were written in seven months because nothing enforced reuse; `reuse-registry.json` plus the
`map-guardian` hook now reject a new implementation of a registered piece. The same hook
injects the repo map on the first edit in a repo, so an agent cannot claim it did not see it.

`repoMap.md` is kept honest by the push gate: a new source file that cannot be found in
the map blocks the push (`repomap-check.mjs`).

## Sliding window, never delete

`activeContext.md`/`progress.md` are not session diaries. Entries older than the window
with no pending marker move **verbatim** to `memory-bank/archive/`. The board and the
coordination file follow the same rule with their `-archive.md` twins. The size sentinel
(`md-size-watch.mjs`) warns, never blocks, because a block on a size limit produces
deletions; a warning produces archiving. The coordination file once reached 7,600 lines
because "archive on close" was written as a rule but not surfaced at session start; the
SessionStart hook now prints the warning line every session.

## Task board mechanics

One canonical list; derived views are forbidden because a hand-maintained second file was
always the stale one. The compact item template forces evidence to be **replaced**, not
appended, and the heading to change in the same edit as the body — the most common rot was
a 🔴 heading over a body that said "shipped". Item codes are `<MMDD>-<slug>` because two
concurrent sessions kept picking the same sequential number. Every open item carries an
authorization tag (`[DEV]`/`[ANY]` by default) so an agent knows whether it may finish the
item alone or must hand the last step to the human. The staleness sentinel
(`board-staleness.mjs`) flags items whose body sounds done while the heading says open.

## Coordination file and claims

Several sessions (and several tools) work on the same checkout. Claims prevent duplicate
work; the index table plus the claim block is a single mechanism because running two in
parallel produced eighteen dead table rows. Claims age: an "active" claim from a session
that no longer exists locked two large items for days. The protocol therefore says: check
the owner is alive before treating a claim as real, but look at the commits first — a
session id can change without the work being abandoned. Live tool-to-tool messages are
allowed for time-critical questions but leave no record, so the outcome is written to the
file immediately.

## Guards on the way to production

- **Behind-push gate**: pushing a branch that is behind its remote produced silent
  overwrites in a shared checkout. Now denied.
- **Deploy-branch confirm**: pushing to a deploy branch *is* the deploy; the hook asks.
- **Secret scan, fail-closed**: a private key once reached a rented machine through an
  env file. The pre-push hook runs a scanner on the pushed range and refuses to run when
  the scanner is missing, because "scanner not installed" was the root cause of one leak.
  The escape hatch is an env var that is logged loudly; using it to push red is forbidden
  by the rules, not by code.
- **Edit-check**: a syntax or type error found seconds after the edit costs nothing; found
  at deploy it costs a rollback. The hook runs the cheapest correct check for the file type.
- **Test-runner guard**: parallel browser test runs on one machine gave false reds and
  left orphan headless processes; the hook caps workers and refuses to start when too many
  are alive.

## Gates: serial, complete, honest

Suites run one at a time because a loaded machine gives false reds. All offline tests run;
only what needs a live external service is skipped, and the skip is named. Counts are
compared with a dated baseline because a wrong runtime version or a missing env once
silently shrank a suite to a fraction and everything was "green". A green obtained with a
skip or isolation flag is forbidden.

## Skills as shared procedure memory

Seven recurring recipes were found living only in one agent's private memory — invisible
to other tools, workers and machines. The rule: three runs (two if the first hit a trap)
and the **agent** writes the skill, then tests it in a fresh session without naming it. The
house style (access note → table → ordered flow → dated pitfalls → baseline → done-when)
exists so every skill reads the same way.

## Reports and specs

Research syntheses go to `reports/` so the next session searches before exploring. Specs
are how the architect hands work to a worker: the worker applies a wrong instruction as
faithfully as a right one, so uncertain points are marked "your call" instead of guessed.
Commit authority is stated in every brief because a worker that was not told either way
left dirty trees behind.

## Multi-tool parity

One canonical hook and skill source (`.claude/`) is linked into `.codex/` and `.agents/`
by `ensure-agent-compat`, Codex profiles mirror the three roles, and Gemini gets a thin
delta file listing what it must do by hand because it has no hooks. The pre-push git hook
is tool-independent so the secret scan never depends on which agent pushed.

## What was deliberately left out

Product policies, server names, ports, credentials, branch names and named people. They
are parameters (config) or generated content (templates), never part of `core/`.
