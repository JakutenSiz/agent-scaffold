# Memory Bank Operating Guide (shared)

> Single canonical home of the Memory Bank rules for every repo in this project. A repo's own
> `AGENTS.md` stays short (repo-specific facts only) and links here. Full former text (per-file
> "must contain" lists, workflows, examples): `memory-bank-guide-appendix.md` — open it only when
> creating or restructuring a memory-bank file.

## Purpose
The Memory Bank is not a diary: it is a high-signal operational map of a repo. An agent entering
cold should learn from it where to look, what to reuse, what not to break and how to validate. A
file that does not help an agent decide faster and safer is tightened or removed. Do not begin from
code-first guessing: read the documented knowledge, find the change surface, then touch the
smallest correct set of files.

## Files (`memory-bank/`, name from `memoryBank.dir`)
| File | Holds | Update when |
|---|---|---|
| `projectbrief.md` | stable identity: scope, non-scope, goals, boundaries | the repo's scope changes |
| `productContext.md` | why it exists: problems, flows, domain language, business rules | a flow or business rule changes |
| `systemPatterns.md` | architecture, layers, boundaries, extension rules | ownership, boundaries or conventions change |
| `techContext.md` | languages, dependencies, commands, env, deploy constraints | build/test/deploy/runtime constraints change |
| `repoMap.md` | MANDATORY navigation: directory map, "start here" table, hotspots | a feature, module or source file is added/moved/removed |
| `capabilityRegistry.md` | MANDATORY reuse map of existing helpers/services/components | a reusable piece is introduced or relocated |
| `activeContext.md` | current working state (sliding window) | after any meaningful work |
| `progress.md` | delivery status (sliding window) | after any meaningful work |
| `reuse-registry.json` | canonical pieces + trigger phrases for the pre-edit guard | with `capabilityRegistry.md` |
| `repomap-guard.json` | optional inventory-dir / freshness overrides | the inventory dirs change |
| `archive/` | entries moved out of the window, verbatim | by the archive script only |

Optional: `features/`, `integrations/`, `runbooks/`, `decisions/` (ADRs), `testingGuide.md`.
Durable supporting docs (design guides, subsystem notes, checklists) stay in `docs/` and are linked
from `repoMap.md` / `capabilityRegistry.md`; never duplicate them into the Memory Bank.

## Read by task (do NOT read all eight files)
Always: `repoMap.md` + `activeContext.md` + `capabilityRegistry.md`. Then only what the task needs:
| Task | Also read |
|---|---|
| scope unclear, new to the repo | `projectbrief.md` |
| user flow or business rule changes | `productContext.md` |
| layers, shared pieces, data flow, refactor | `systemPatterns.md` |
| build/test/env/deploy work | `techContext.md` |
| delivery status, handoff, pending gates | `progress.md` |
| adding a shared helper/component | `reuse-registry.json` |
| feature/integration/runbook/ADR work | the matching `features/`, `integrations/`, `runbooks/`, `decisions/` doc the map points to |
Then read the supporting docs `repoMap.md` / `capabilityRegistry.md` point to; do not crawl docs.
If docs and code disagree, trust the code, then repair the docs. One durable fact has one home plus links.

## Working rules
1. Reuse before creating: check for an existing equivalent (helper, hook, service, schema, dependency) and prefer consistency over novelty; no parallel patterns without an explicit new direction.
2. Pinpoint before editing: entrypoint, owning modules, affected shared contracts, validating tests.
3. Refactor with boundaries: preserve behavior; name stable contracts, public shapes, schema assumptions, consumers, rollback concerns first.
4. Minimal correct change.
5. Record durable discoveries (structure, capability locations, constraints, recurring pitfalls) in the Memory Bank; if it does not fit the map role, put it in a supporting doc and link it.
6. Update triggers: feature/subsystem added or reshaped, new reusable piece, ownership change, new integration behavior, changed build/test/deploy constraint, changed convention, or an explicit "update memory bank" (then review every required file). After meaningful work re-check `activeContext.md` and `progress.md`.
7. Anti-drift: no new abstractions that merely look cleaner, no dependency without checking existing ones, no unexplained deviation from established patterns, no broad refactor without named contracts, no undocumented structural discovery.
8. Done means: code correct, repo patterns followed, existing capabilities reused, contracts respected, validation done, Memory Bank updated with durable knowledge, status in `activeContext.md`/`progress.md`.

## Sliding window
`activeContext.md` and `progress.md` are newest-first, dated `## YYYY-MM-DD <title>` entries. Entries
older than `memoryBank.windowDays` (default 14) with no pending marker move IN FULL to
`memory-bank/archive/` — never deleted. An entry containing any `memoryBank.pendingPhrases`
(waiting on a push/deploy/migration, a flag still off) stays regardless of age. Durable facts that
archival would lose (a trap, an invariant, an env var name, an ordering rule) are promoted to
`systemPatterns.md` / `techContext.md`. Size ceiling: `memoryBank.ceiling` lines /
`memoryBank.ceilingBytes` bytes per file.
```bash
node scripts/memory-bank-archive.mjs <repo>            # dry run
node scripts/memory-bank-archive.mjs <repo> --write    # apply
node scripts/memory-bank-archive.mjs --all --write     # every repo
node scripts/md-size-watch.mjs                         # ceiling check
```

## Keeping the map honest
Adding a source file or module means adding it to that repo's `repoMap.md`; the push gate rejects a
push whose new files cannot be found there (`node scripts/repomap-check.mjs <repo>` audits).
Before writing a shared piece, check `reuse-registry.json`; the pre-edit guard rejects
re-implementing a registered canonical piece.

## What does NOT go here
Session diaries and task status belong on the board; messages between agents belong in the
coordination log. Stable architecture is not repeated in `activeContext.md`.

## Schema and check
Required headings per file live in `memory-bank-schema.json` (path: `docs.memoryBankSchema`).
`node scripts/memory-bank-check.mjs [<repo-dir>] [--line]` reports missing files, missing headings
and unfilled template placeholders; it exits 1 when anything is missing.

Your memory does not persist between sessions; the Memory Bank is your operational memory. If it
cannot quickly tell you where to look, what to reuse, what to avoid breaking and how to validate,
improve it.
