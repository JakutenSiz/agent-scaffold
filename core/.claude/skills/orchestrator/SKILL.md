---
name: orchestrator
description: "Full orchestrator (CEO) mode for large, multi-part work — the main agent writes no code and reads no files itself, it only directs. Flow: parallel discovery workers → synthesis → spec files → distribution to workers / cross-model lanes → verification. Use for 'orchestrator mode', 'manage this job', 'let it run overnight', or any multi-part feature/refactor. Do NOT use for small jobs."
---

# Orchestrator mode (large jobs)

> **Access requirement:** subagents (`scout`, `worker`, `verifier`) available, or a
> cross-model CLI for lanes. Without either, this mode degrades to "write the specs, then
> apply them yourself one at a time" — still worth it for the specs.

## When

- The job touches 3+ areas or 2+ repos, or would take more than one session.
- The main agent's context would otherwise fill with file reads.

## 1. Discovery (parallel, cheap)

Spawn one `scout` per area with a verbatim question list and a line budget. Ask for
`path:line` anchored summaries, not dumps. Save each result under
`reports/YYYYMMDD-<job>-<area>.md` if it will be needed again.

## 2. Synthesis (main agent, decisions only)

From the summaries decide: the split into parts, the order (what blocks what), which parts
touch the same files (serialize them), what is uncertain (goes into the spec as "your
call, criterion X" or as a stop threshold — never as a guessed instruction).

## 3. Specs

One folder `specs/YYYYMMDD-<job>/`, one file per part, using the template in
`specs/README.md`: goal, files to touch, files NOT to touch, watch list, acceptance
command, decision rights, commit authority. Add a board item for the job (code
`<MMDD>-<slug>`) and claim it in the coordination file.

## 4. Distribution

- Independent parts → parallel `worker` subagents (or cross-model lanes), each with its spec path as the whole brief plus the "do not touch" list.
- Parts sharing a file → the same worker, in order.
- State commit authority explicitly in every brief. A worker that may not commit leaves the tree; the orchestrator commits per part with a scoped `git add` of the listed files.

## 5. Verification

One `verifier` per changed repo, serially, with the `gate-ritual` skill. Red → back to
the worker with the file:line, not to the orchestrator's own hands. Green → evidence into
the board item, claim to done, spec folder archived, `activeContext.md`/`progress.md`
updated, `repoMap.md` updated for new files.

## Pitfalls

- A worker that finds the job bigger than its brief must stop and report; the split is the orchestrator's decision. Workers never spawn workers.
- A worker killed by a rate limit or timeout: measure the tree (`git status`, `git stash list`) before starting a replacement; brief the replacement with the measured state and a do-not-touch list.
- Two workers on the same file = merge damage. Serialize.
- Do not accept "done" without the acceptance command's output.

## Done when

Every part's acceptance passed under a verifier, the board item holds the evidence, the
claim is archived, the memory bank is current. Not done: "all workers reported success".
