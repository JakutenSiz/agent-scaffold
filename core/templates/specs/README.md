# Specs — implementation recipes (goal files handed to workers)

When a large job is split into parts, ONE spec file is written per part; the worker
agent (a `worker` subagent or a cross-model lane) takes that spec as its **goal** and
applies it literally. The main agent (architect) writes the spec — design decisions go
into the spec, the worker does not decide.

## Rules

- Location: `{{SPECS_DIR}}/YYYYMMDD-<job-name>/<part>.md` (one job = one folder, one file per part).
- Every spec contains:
  1. **Goal** — what will be true when this part is done (one sentence).
  2. **Files to touch (file ownership)** — explicit list; files NOT to touch are listed too (another part's or agent's area). Parts running in parallel own disjoint files.
  3. **Watch list** — known traps, invariants to preserve (distilled from the memory bank and the coordination file).
  4. **Acceptance** — the NARROW command that means "done": one test file, a syntax check, or the touched file. The worker runs only this; the full gates run once on the combined tree, not per part.
  5. **Decision rights and protocol** — details the architect is NOT sure about are never written as instructions: a worker applies a wrong instruction as faithfully as a right one, and a guessed instruction is the most expensive kind of mistake. Mark uncertain points explicitly: "your call here, choose by criterion X". Add a task-specific stop threshold when needed: "if X appears, stop and report, do not continue".
  6. **Commit authority** — may the worker commit? With which message? Default: no.
  7. **Acceptance tour** — MANDATORY for every user-visible feature (for pure backend/infrastructure work write "none — <reason>"). Once the feature is live: who clicks what, and what they must see. A feature with no entry point a user can reach does not count as shipped. See the template below.
- **"Start" freezes the part.** A change that arrives after a part was started becomes a NEW numbered part; it is never written into the spec of the part that is already running.
- When the job is fully done the folder moves to `_archive/` or is deleted with a reference from the task-board evidence.

## Template

```markdown
# <part name> — <job name>

**Goal:** …
**Files to touch:** …
**Do NOT touch:** …
**Watch list:** …
**Acceptance:** `<command>` passes; …
**Decision rights:** … / **Stop if:** …
**Commit:** no | yes, message: "…"

## Acceptance tour
- **Entry point:** where does the user reach the feature (menu path / button / URL)?
- **Scenario:** who does what, step by step, and what must be visible at each step (including reopening the page and a saved draft, if any).
- **Evidence line:** `Acceptance tour done <date> -> <report path>` (or failed; a failed tour keeps the item from being marked done).
```
