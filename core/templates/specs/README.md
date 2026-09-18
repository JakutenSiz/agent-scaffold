# Specs — implementation recipes (goal files handed to workers)

When a large job is split into parts, ONE spec file is written per part; the worker
agent (a `worker` subagent or a cross-model lane) takes that spec as its **goal** and
applies it literally. The main agent (architect) writes the spec — design decisions go
into the spec, the worker does not decide.

## Rules

- Location: `{{SPECS_DIR}}/YYYYMMDD-<job-name>/<part>.md` (one job = one folder, one file per part).
- Every spec contains:
  1. **Goal** — what will be true when this part is done (one sentence).
  2. **Files to touch** — explicit list; files NOT to touch are listed too (another part's or agent's area).
  3. **Watch list** — known traps, invariants to preserve (distilled from the memory bank and the coordination file).
  4. **Acceptance** — which command/test passing means "done".
  5. **Decision rights and protocol** — details the architect is NOT sure about are never written as instructions: a worker applies a wrong instruction as faithfully as a right one, and a guessed instruction is the most expensive kind of mistake. Mark uncertain points explicitly: "your call here, choose by criterion X". Add a task-specific stop threshold when needed: "if X appears, stop and report, do not continue".
  6. **Commit authority** — may the worker commit? With which message? Default: no.
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
```
