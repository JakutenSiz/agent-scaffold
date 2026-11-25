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

Spawn one `scout` per area (mechanical search) or one `analyst` (deep flow understanding,
root cause, impact analysis) with a verbatim question list and a line budget. Ask for
`path:line` anchored decision summaries, not dumps. Save each result under
`reports/YYYYMMDD-<job>-<area>.md` if it will be needed again.

## 2. Synthesis (main agent, decisions only)

From the summaries decide: the split into parts, the order (what blocks what), which parts
touch the same files (serialize them), what is uncertain (goes into the spec as "your
call, criterion X" or as a stop threshold — never as a guessed instruction).

Read the `Better path:` line of every worker report. Each one that is not `none` either
enters the design, or the spec records in one sentence "not adopted because …". A rejected
idea carries `Reopen if: <condition>`: a rejection is evidence, not a lock.

## 3. Specs

One folder `specs/YYYYMMDD-<job>/`, one file per part, using the template in
`specs/README.md`: goal, files to touch, files NOT to touch, watch list, acceptance
command, decision rights, commit authority. Add a board item for the job (code
`<MMDD>-<slug>`) and claim it in the coordination file. Split parts so that no two touch the same file.

## 4. Distribution

- Independent parts → parallel `worker` subagents (or cross-model lanes) with disjoint file ownership, each with its spec path as the whole brief plus the "do not touch" list.
- Parts sharing a file → the same worker, in order.
- State commit authority explicitly in every brief (default: no commit). A worker that may not commit leaves the tree; the orchestrator commits per part with a scoped `git add` of the listed files.

## 5. Verification

A worker runs only its spec's narrow acceptance (one test file, a syntax check) and fixes
its own red while its context is warm; do not call the verifier per part. When all parts
are merged, ONE full-gate run on the combined tree (one `verifier` per changed repo,
serially, with the `gate-ritual` skill). Exception: if part B builds on part A, A's narrow
test is green before B starts. Red → back to the worker with the file:line, not to the
orchestrator's own hands. Green → evidence into
the board item, claim to done, spec folder archived, `activeContext.md`/`progress.md`
updated, `repoMap.md` updated for new files.

## Pitfalls

- A worker that finds the job bigger than its brief must stop and report; the split is the orchestrator's decision. Workers never spawn workers.
- A worker killed by a rate limit or timeout: measure the tree (`git status`, `git diff --stat`) before starting a replacement; brief the replacement with the measured state and a do-not-touch list.
- Two workers on the same file = merge damage. Serialize.
- The checkout is shared: briefs forbid `git stash`, `git reset --hard`, `git checkout -- <path>`, `git restore <path>`, `git clean -f`, `--autostash`.
- "Start" freezes a part: a later change becomes a new numbered part, never an edit to a running spec.
- Do not accept "done" without the acceptance command's output.

## Done when

Every part's acceptance passed under a verifier, the board item holds the evidence, the
claim is archived, the memory bank is current. Not done: "all workers reported success".
