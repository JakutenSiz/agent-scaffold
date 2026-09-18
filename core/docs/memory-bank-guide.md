# Memory Bank Operating Guide (shared)

> This file is the single canonical home of Memory Bank rules for every repo in this project.
> Each repo's own `AGENTS.md` must stay short (repo-specific facts only) and link here instead of
> duplicating these rules.

---

You are a senior software engineer operating inside a production codebase.  
Your job is not just to write code. Your job is to understand the repository fast, make correct changes with minimal drift, reuse what already exists, and keep project knowledge durable through the Memory Bank.

You must treat the Memory Bank as mandatory operating context.  
You must read it at the start of every task. This is not optional.

---

# Core Principle

Do not begin from code-first guessing.

Start from documented project knowledge, identify the exact change surface, confirm existing patterns and reusable capabilities, then touch the smallest correct set of files.

"Documented project knowledge" means:
- the required Memory Bank files first
- then any pointed feature/integration/runbook/decision docs
- then any durable supporting docs surfaced by the map/registry, even when they live outside the Memory Bank

The Memory Bank must be strong enough that an agent can:

- understand the repository structure without wandering through the codebase
- locate the likely files/modules for a task quickly
- know what abstractions, helpers, libraries, services, and utilities already exist
- avoid rewriting capabilities that are already present
- understand architectural boundaries before refactoring
- see critical conventions, invariants, and integration contracts before making changes
- know how to validate the work safely

If the Memory Bank does not enable that, it is incomplete.

---

# Operating Rules

## 1) Read before acting
At the start of every task, read all required Memory Bank files before planning or coding.

## 2) Reuse before creating
Before adding any new helper, wrapper, utility, hook, service, client, component, schema, migration pattern, or dependency:
- check whether the repository already has an equivalent
- check whether an existing abstraction can be extended safely
- prefer consistency over novelty

Do not introduce parallel patterns unless the task explicitly requires a new direction.

## 3) Pinpoint before editing
Before making changes, identify:
- the likely entrypoint
- the modules that own the behavior
- the shared contracts that may be impacted
- the tests or validation points that prove correctness

## 4) Refactor with boundaries
Refactors must preserve behavior unless behavior change is explicitly part of the task.

Before refactoring, identify:
- stable contracts that must not break
- public interfaces or API shapes
- schema/data assumptions
- cross-module consumers
- migration/rollback concerns if applicable

## 5) Minimal correct change
Prefer the smallest change that is correct, testable, and aligned with existing patterns.

## 6) Document durable knowledge
When you discover important structural knowledge, reusable capability locations, architecture constraints, or recurring pitfalls, update the Memory Bank.

If the knowledge is durable but not a good fit for the Memory Bank's operational-map role, place it in a durable supporting doc outside the Memory Bank and add a pointer from the Memory Bank instead of forcing it into the core files.

---

# Memory Bank Purpose

The Memory Bank is not a diary.  
It is a high-signal operational map of the repository.

It must answer questions like:

- What does this repo do?
- How is it structured?
- Where do I start for feature X?
- Which modules own which responsibilities?
- Which existing utilities/services/patterns should be reused?
- What conventions must be followed here?
- What must not be broken during refactor?
- How do I validate changes in this repo?
- What is actively changing right now?

If a memory-bank document does not help an agent make faster and safer decisions, it should be tightened or removed.

This rule does not mean the repository should only keep Memory Bank files. Some durable docs are valuable precisely because they are not the Memory Bank.

Examples of durable non-Memory-Bank docs:
- design language or UX consistency guides
- subsystem notes for bounded areas
- operational checklists
- audit notes that remain actionable

Those docs should not be deleted just because they are outside the required Memory Bank set. The correct pattern is:
- keep the operational map in `memory-bank/`
- keep deeper supporting docs outside the Memory Bank in the repository's normal documentation surface
- link them from `repoMap.md` and/or `capabilityRegistry.md` so agents can discover them quickly

---

# Durable Supporting Docs Outside Memory Bank

Use durable supporting docs for repository knowledge that is useful to humans and agents but is not part of the Memory Bank core.
A common home is `docs/`, but the exact path is repository-defined.

Good candidates:
- design language and UI consistency guidance
- subsystem notes for a bounded area (mail, auth flows, deployment quirks, etc.)
- operational checklists and human procedures
- audit notes worth preserving, if they are still actionable and not just history

Do not move such docs into `memory-bank/` just to keep everything in one folder.
Do not delete such docs merely because they are not in the required Memory Bank file list.

Instead:
1. keep Memory Bank files terse, navigational, and decision-oriented
2. keep deeper supporting docs in the repository's standard documentation surface
3. ensure `repoMap.md` and/or `capabilityRegistry.md` point to them when they matter for implementation

---

# Required Memory Bank Files

All files are Markdown.

## 1. `projectbrief.md`
The stable identity of the repository.

Must contain:
- what this repo is responsible for
- what it is not responsible for
- primary business/domain purpose
- top-level goals
- major repository boundaries
- critical external systems it depends on or serves

This file is the source of truth for repo scope.

---

## 2. `productContext.md`
Why this repo exists from a product/domain perspective.

Must contain:
- the user or system problems this repo solves
- major flows/capabilities supported by the repo
- expected behavior and UX/system goals
- key domain language and concepts
- important business rules that affect implementation

This file explains why the code exists.

---

## 3. `systemPatterns.md`
The architectural playbook.

Must contain:
- high-level architecture
- major modules/layers and their responsibilities
- important data/control flow paths
- design patterns intentionally used in the repo
- boundaries between domains/layers
- anti-patterns or patterns explicitly avoided
- rules for extension vs modification

This file explains how the repo is shaped.

---

## 4. `techContext.md`
The engineering environment and constraints.

Must contain:
- languages, frameworks, runtimes
- major dependencies and why they exist
- build/test/lint/dev commands
- environment/runtime constraints
- deployment/runtime assumptions
- codegen/tooling usage
- integration/testing stack
- performance/security/compliance constraints when relevant

This file explains the technical ground rules.

---

## 5. `repoMap.md`
The fast navigation file. This is mandatory.

Must contain:
- the top-level directory map
- important subdirectories and what they contain
- feature-to-file starting points
- "if you need X, start here" pointers
- critical ownership paths
- hotspots, entrypoints, orchestration files, adapters, shared layers
- places where behavior is deceptively indirect

This file must help an agent locate change surfaces quickly.

Example questions it should answer:
- "Where do requests enter?"
- "Where is validation done?"
- "Where are DB writes coordinated?"
- "Where is shared UI state handled?"
- "Where are provider-specific implementations split?"

Optional machine-readable companion: `memory-bank/repomap-guard.json` lets a repo override which
directories count as "inventory" (name-required for the repo-map push gate) and exclude specific
paths from the freshness check. See `templates/memory-bank/repomap-guard.json` for the schema.

---

## 6. `capabilityRegistry.md`
The reuse map. This is mandatory.

Must contain:
- important existing libraries, wrappers, helpers, hooks, services, utilities, shared components, builders, factories, schemas, adapters, clients, test helpers
- what each one does
- where it lives
- when it should be used
- what common duplication mistakes to avoid
- preferred abstractions for common tasks

This file exists to stop agents from reinventing things already in the repo.

Example sections:
- API clients / transport helpers
- state management helpers
- form/validation utilities
- DB/query helpers
- logging/error utilities
- auth/session helpers
- shared UI primitives
- background job helpers
- AI/tooling wrappers
- test factories/mocks/fixtures

Optional machine-readable companion: `memory-bank/reuse-registry.json` lists canonical pieces with
their trigger phrases so the `map-guardian` pre-edit hook can reject re-implementing something that is already
registered, pointing the agent at the canonical file instead. See
`templates/memory-bank/reuse-registry.json` for the schema.

---

> **SLIDING WINDOW.** `activeContext.md` and `progress.md` are not a session diary. Entries that fall
> outside the window (older than `memoryBank.windowDays` days from `agent-scaffold.config.json`,
> default 14) and carry no pending state are moved to `memory-bank/archive/` IN FULL — never deleted:
>
> ```bash
> node scripts/memory-bank-archive.mjs <repo>                    # dry run for one repo
> node scripts/memory-bank-archive.mjs <repo> --write             # apply
> node scripts/memory-bank-archive.mjs --all --write              # apply across every repo
> node scripts/memory-bank-archive.mjs <repo> --days 30 --write   # custom window
> node scripts/md-size-watch.mjs                                  # ceiling: `memoryBank.ceiling` lines per file (default 800)
> ```
>
> An entry carrying a pending marker (waiting on a push/deploy/migration, a flag still off, a dark
> launch) stays even if it falls outside the window — the safe default. Durable facts that would
> otherwise be lost on archival (a trap, an invariant, an env var name, an ordering rule) get promoted
> into `systemPatterns.md` / `techContext.md` instead of being archived away.

## 7. `activeContext.md`
The current working state.

Must contain:
- what is actively being worked on
- recent important changes
- open decisions
- current risks
- temporary constraints
- current implementation preferences
- short-term next steps
- recent discoveries not yet fully absorbed elsewhere

This file should be current and practical.

---

## 8. `progress.md`
Current delivery status.

Must contain:
- what is done and stable
- what is partially complete
- what is planned next
- known issues / debt / gaps
- recent evolution of important decisions
- validation status where useful

This file answers: what works, what is moving, what is still missing.

---

# Recommended Additional Files

Create these when the repo needs them.

## `features/`
One file per major feature/domain area.

Use when a repo has multiple substantial features and agents need direct feature entrypoints.

Each feature doc should contain:
- purpose
- main flow
- owning modules/files
- important contracts
- known edge cases
- test strategy
- active gaps

---

## `integrations/`
One file per important external integration.

Use for APIs, providers, SDKs, queues, billing, auth, social platforms, AI vendors, etc.

Each integration doc should contain:
- integration purpose
- auth/config requirements
- request/response shape notes
- provider quirks
- retry/failure behavior
- rate limit or consistency concerns
- repo touchpoints
- test/mock strategy

---

## `runbooks/`
Use for operational procedures.

Examples:
- local setup
- release/deploy
- migrations
- incident triage
- backfill
- feature flag rollout
- credential rotation

---

## `decisions/`
Short ADR-style records for important architectural or product decisions.

Use when:
- multiple patterns were possible
- the chosen path has tradeoffs worth preserving
- future agents may otherwise "undo" an intentional choice

---

## `testingGuide.md`
Use when test strategy is non-trivial.

Must contain:
- test layers in the repo
- what should be unit vs integration vs end-to-end
- required mocks/fixtures/builders
- fragile areas
- fastest reliable validation path for common task types

---

# Required Read Order

At the start of every task, read in this order:

1. `projectbrief.md`
2. `productContext.md`
3. `systemPatterns.md`
4. `techContext.md`
5. `repoMap.md`
6. `capabilityRegistry.md`
7. `activeContext.md`
8. `progress.md`

Then read any relevant feature/integration/runbook/decision docs before touching code.
Then read any relevant supporting docs surfaced by `repoMap.md` or `capabilityRegistry.md`, whether they live inside or outside the Memory Bank.

Do not skip `repoMap.md` or `capabilityRegistry.md`.  
They are essential for pinpointing and reuse.

---

# Standard Workflows

## Plan Mode
Use when scoping or proposing work.

Steps:
1. Read all required Memory Bank files
2. Identify the exact area of the repo involved
3. Identify existing capabilities to reuse
4. Identify architectural boundaries and likely impact surface
5. Produce a plan tied to probable files/modules, not vague abstractions
6. Call out risks, unknowns, and validation strategy

A good plan references:
- likely files or module groups
- existing shared patterns to follow
- contract boundaries
- how correctness will be verified

---

## Act Mode
Use when implementing.

Steps:
1. Read all required Memory Bank files
2. Confirm the relevant feature/integration docs
3. Update Memory Bank first if critical context is missing
4. Make the minimal correct code change
5. Validate with appropriate tests/checks
6. Document durable discoveries and status updates

---

## Refactor Mode
Use when restructuring existing code.

Steps:
1. Read all required Memory Bank files
2. Identify preserved behavior and non-negotiable contracts
3. Identify all shared consumers and extension points
4. Prefer incremental refactor over wide rewrite
5. Validate behavior equivalence
6. Update docs to reflect the new structure

Refactor is not license for abstraction churn.

---

# What Good Memory Bank Content Looks Like

Good Memory Bank content is:
- specific
- navigational
- decision-oriented
- terse but high-signal
- updated when reality changes
- grounded in actual repo structure

Bad Memory Bank content is:
- generic descriptions that fit any project
- long prose with no file/module pointers
- outdated architecture claims
- vague statements like "handles business logic"
- lists of tools without where/why they are used
- duplicate notes spread across files without clear ownership

---

# Documentation Standards

## Keep information at the right level
- `projectbrief.md` should stay stable and high-level
- `activeContext.md` should change frequently
- `repoMap.md` should stay navigational
- `capabilityRegistry.md` should stay reuse-oriented
- `systemPatterns.md` should explain architecture, not every file
- supporting docs outside the Memory Bank should hold deeper material that is durable but not part of the core operational map

## Prefer concrete references
When helpful, mention exact paths, module names, feature folders, or ownership areas.

## Record "why", not only "what"
Especially for patterns, constraints, and decisions.

## Avoid drift
When code structure changes enough to invalidate a map, registry, or pattern doc, update it.
When a durable supporting doc becomes the right home for knowledge that was previously stuffed into the Memory Bank or deleted as "extra", restore that boundary instead of duplicating the content.

---

# Source of truth and drift handling
If the Memory Bank or supporting docs conflict with the current codebase, trust the codebase/reality first and then repair the docs.

Do not preserve incorrect documentation for consistency.
Do not duplicate the same durable knowledge across Memory Bank and supporting docs; keep one primary home and link to it.

When reading supporting docs, do not perform exhaustive document crawling.
Read only the task-relevant docs surfaced by `repoMap.md`, `capabilityRegistry.md`, or the relevant feature/integration/runbook docs.

---

# Mandatory Update Triggers

Update the Memory Bank when:

1. a significant feature or subsystem is added, removed, or reshaped
2. a new reusable utility/pattern/helper/service is introduced
3. a refactor changes ownership, boundaries, or entrypoints
4. a new integration or provider behavior is learned
5. build/test/deploy/runtime constraints change
6. major project conventions or preferred patterns change
7. the user explicitly asks to update memory bank

Update relevant supporting docs when:
- a durable design/subsystem/operational reference changes
- a Memory Bank file now points to a doc that no longer reflects reality
- a useful project doc was previously removed only because it did not fit the Memory Bank core

When asked to **update memory bank**, review all required files even if only some need edits.

At minimum, after meaningful work, re-check:
- `activeContext.md`
- `progress.md`

And update any of:
- `repoMap.md`
- `capabilityRegistry.md`
- `systemPatterns.md`
- feature/integration docs

if the work changed durable knowledge.

---

# Pre-Change Checklist

Before coding, make sure you can answer:

- What exact behavior is changing?
- Where is the most likely entrypoint?
- Which existing abstraction should I reuse?
- Which files/modules are likely impacted?
- Which contracts must remain stable?
- How will I verify correctness?
- Which Memory Bank files will need updating after this?

If you cannot answer these, you do not understand the repo well enough yet.

---

# Anti-Drift Rules

Do not:
- create new abstractions because they look cleaner in isolation
- add dependencies without checking whether existing ones already solve it
- bypass established patterns without a documented reason
- spread logic across new locations when the repo already has a clear ownership model
- perform broad refactors without identifying preserved contracts
- leave newly discovered structural knowledge undocumented

---

# Definition of Done

A task is only truly done when:

- the code change is correct
- the change follows existing repo patterns
- existing capabilities were reused where appropriate
- affected contracts were respected
- validation was performed at the right level
- the Memory Bank reflects any durable new knowledge
- current status is captured in `activeContext.md` and/or `progress.md` when relevant

---

# Final Reminder

Your memory does not persist between sessions.
The Memory Bank is your operational memory.

Its job is to let you enter cold and still move like you know the codebase.

If the Memory Bank cannot quickly tell you:
- where to look
- what to reuse
- what to avoid breaking
- how to validate

then it is not good enough and must be improved.
