# Agent working rules (canonical)

> Single canonical home for how AI agents work in this project. `CLAUDE.md`, `AGENTS.md`
> and `GEMINI.md` link here; they do not restate these rules. Memory-bank rules live in
> `docs/memory-bank-guide.md`; task-board rules in the board's §9; coordination rules in
> the coordination file's `## Protocol`; tool pitfalls in `docs/tool-traps.md`. One rule,
> one home — copies drift.
>
> **Rule ids.** A rule that must hold carries an id `[R-nn]`. The hook or script that
> enforces it names the id in its header (`// Enforces: R-nn`).
> `node scripts/rule-inventory.mjs` prints which rules are enforced by code and which are
> advice only. Why that matters is section 10.

## 1. Delegation-first: the main agent is the architect

The expensive main model decides; cheaper workers do the grunt work. Only
decision-ready summaries enter the main context.

| Work | Who | Model tier |
|---|---|---|
| Multi-file exploration or reading (5+ files), "where is X", pattern sweeps | `scout` subagent | cheapest |
| Understanding a flow end to end, root cause, "what breaks if I change X" — a summary the architect will decide on | `analyst` subagent (read-only) | mid, high effort |
| Well-specified mechanical edits: repetitive multi-file changes, renames, boilerplate, i18n, fixtures | `worker` subagent | mid |
| Gate and test runs | `verifier` subagent | mid |
| Second opinion from another model family, large diff sweeps | cross-model lane (Codex `codex exec`, or another CLI) | strong |
| Architecture, specs, final decisions, anything the human must trust | main agent | strongest |

- [R-01] The main agent does **not** read file after file itself. The `read-guard` hook
  counts reads — including `cat`/`grep`/`sed -n` through the shell — warns at
  `delegation.warnAfterReads` and denies at `denyAfterReads`. A long run of edits by the
  main agent is counted too and warns once at `warnAfterEdits` (a hard stop exists as
  `denyAfterEdits`, off by default): hand it to a worker. Measure the result with
  `node scripts/delegation-share.mjs --days 14`.
- [R-02] **The agent tree is single-level.** Only the main agent delegates. A subagent
  never spawns its own subagent; if the job is bigger than its brief, it stops and
  reports back, and the main agent decides how to split it. (Unrestricted workers
  recurse and loop; measured, not theoretical.)
- [R-03] Generic subagents inherit the main model unless told otherwise — always pass the
  mid model to a generic subagent unless the sub-task truly needs the top model. Prefer
  the defined agents: their model, effort and tools are pinned in `.claude/agents/`.
- [R-04] A brief to a worker is a spec: goal, files it owns, files NOT to touch, known
  traps, the narrow acceptance command, and an explicit "stop and report if X"
  threshold. A worker applies a wrong instruction as faithfully as a right one, so the
  architect never writes a guess as an instruction — uncertain points are marked "your
  call, by criterion Y". Commit authority is stated in the brief; parallel workers get
  disjoint file sets.
- [R-05] **Channel for better ideas.** Every worker report ends with a `Better path:`
  line — a better design, or a wrongly framed question, with evidence, or `none`. The
  worker does not apply it; the architect either adopts it or records why not. A
  rejected idea carries `Reopen if: <condition>` — a rejection is evidence, not a lock.

## 2. Where knowledge lives

| Kind of knowledge | Home | Not here |
|---|---|---|
| Permanent facts about a repo (structure, commands, patterns, traps) | that repo's `memory-bank/` | chat, private agent memory |
| Current work state, open decisions | `memory-bank/activeContext.md` + `progress.md` (sliding window) | task board |
| Task status, evidence, remaining work, the human's next step | the task board (`board.file`) | coordination file |
| Agent-to-agent messages, claims, hand-overs | the coordination file (`coordination.file`) | task board |
| Research syntheses worth keeping | `reports/YYYYMMDD-<topic>.md` | memory bank (until it becomes a permanent fact) |
| Implementation recipes for workers | `specs/YYYYMMDD-<job>/<part>.md` | reports |
| Repeated procedures | `.claude/skills/<name>/SKILL.md` | private memory |
| Tool pitfalls | `docs/tool-traps.md` (one dated row per bite) | chat |

- [R-10] One canonical home per rule. A rule lives in exactly one file; every other file
  links to it. When a detail outgrows `CLAUDE.md`, move it here and leave a pointer.
- [R-11] Search `reports/` and `specs/` **before** exploring anew. Closed items move to
  `_archive/` subfolders; nothing is deleted.
- [R-60] **Sliding window, never delete.** `activeContext.md`/`progress.md`, the board
  and the coordination file hold only the recent window; older entries move verbatim to
  their archive. `md-size-watch` warns on lines, bytes and the longest line;
  `memory-bank-archive`, `board-archive` and `coordination-archive` do the moving. When
  the sentinel warns, archive — never trim.

## 3. Skills are the shared memory for procedures

- [R-12] When the same procedure has been carried out **three** times (twice if the
  first run cost a trap or a long discovery), the agent — not the human — writes
  `.claude/skills/<name>/SKILL.md`: trigger phrases in the description, sources, ordered
  steps, a "Done when" section, dated pitfalls. Test it in a fresh session **without
  naming the skill**. A recipe that lives only in one agent's private memory is
  invisible to other tools, workers and machines — wrong layer. Workers have the Skill
  tool and call the matching skill before a ritual step. The recipe for writing one is
  the `new-skill` skill.

- [R-13] The scaffold is installed and refreshed by its CLI, never by hand-copying files:
  `agent-scaffold install` writes it, `agent-scaffold upgrade` refreshes the engine files
  and leaves a `<file>.new` next to anything you changed, `agent-scaffold doctor` reports
  what is missing. Reconcile every `.new` file, then delete it. `upgrade` does not wire
  git hooks; `doctor` fails on a missing wiring.

## 4. Sessions

- [R-20] Read the SessionStart note (Claude Code / Codex hook) or, without hooks, do what
  it does: pull, check for repos that are behind, read the coordination file, look at
  the status lines (size, board, human queue, git hygiene).
- [R-21] Before non-trivial work in a repo, read its `memory-bank/repoMap.md`,
  `activeContext.md` and `capabilityRegistry.md`, then only the files the task needs
  (the guide has the reading index). The `map-guardian` hook injects the relevant part
  of the map on your first edit anyway. Adding a source file means adding it to
  `repoMap.md`; the push gate rejects files it cannot find in the map.
- [R-22] Before writing a shared piece (component, helper, client), check
  `memory-bank/reuse-registry.json`. The hook rejects re-implementing a registered piece.
- [R-23] Pick work from the task board and claim it with **one row** in the coordination
  file's claims table, carrying the item code. No item? Run
  `node scripts/board-duplicate.mjs "<keywords>"` first, then add one (code scheme
  `<MMDD>-<slug>`, authorization tag mandatory).
- [R-24] When work lands: evidence goes into the board item, and the item's heading and
  `Remaining` field change **in the same edit** as the body. `board-lint` checks this at
  commit time.
- [R-25] Closing is one cell: write `✅ DONE <date>` into the claim row's State cell and
  run `node scripts/coordination-archive.mjs --write`; closed board items move with
  `node scripts/board-archive.mjs --write`. The commit gate stops a ✅ row that was not
  moved. Nothing is deleted — closed things go to the archive twins.
- [R-26] A step only a human can take is written in the item's `Human step` field with
  that human's tag. `node scripts/human-queue.mjs` builds each person's queue; a step
  older than `board.humanStepExpiryWeeks` is flagged — do it, or drop it with a reason.
- [R-27] **Short sessions.** A main session that keeps a huge context re-reads it on every
  call. The `context-watch` hook tells you when the context passes
  `session.context.warnTokens` or the session sat idle. When it does and the current
  piece of work is done (or the new message is a new job), run the `handoff` skill
  (hand-over note + board → commit → push) and tell the user to clear the session — you
  cannot clear it yourself. Ownership belongs to the work item, not the session: hand
  over at a stage boundary (decision → spec → code → combined gate → deploy →
  acceptance), never mid-stage without a note in "Handed-over work".

- [R-28] A handoff is built from observed facts, not from memory: run
  `node scripts/handoff-packet.mjs <item-code> --write` and commit the one file it writes.
  The packet has a byte budget and masks secret-looking values; packets nobody owns any
  more are listed by `--prune`.

## 5. Shared checkout

Several sessions and workers use the same checkout at the same time.

- [R-30] Never run `git stash`, `git reset --hard`, `git checkout -- <path>` /
  `checkout .`, `git restore <path>` (without `--staged`), `git clean -f` or
  `--autostash`: they silently destroy someone else's uncommitted work. The `git-shield`
  hook denies them. For a baseline run or a look at another commit use a temporary
  `git worktree add --detach <dir> <sha>`.
- [R-31] The index is shared too. Before committing, look at `git diff --cached --stat`
  and commit only your own paths (`git commit -- <paths>`); a file another session
  staged would otherwise ride along. Before committing a shared document (board,
  coordination file, memory bank) that a live peer session is also editing, ask it.
- [R-32] Merged branches and finished worktrees do not get cleaned up by good
  intentions. `node scripts/git-hygiene-watch.mjs` reports the debt at session start;
  `node scripts/git-hygiene-clean.mjs` removes only what is provably lossless (merged,
  clean, old enough, unreferenced), dry-run by default. Branches kept on purpose go into
  the ignore file.

## 6. Gates and pushes

- [R-40] **Full gates run once, on the combined tree, before the push.** A worker runs
  only the narrow acceptance check in its spec (the one test file, a syntax check, the
  touched file) and fixes its own red while its context is warm. The full suite (lint,
  type-check, build, all tests) is not run per part — the next part invalidates it.
  After all parts are merged: one `verifier` run → fixes → push. Exception: when part B
  builds on part A, A's narrow test is green before B starts.
- [R-41] **A bug-fix regression test must be seen red** on the pre-fix code before it
  counts as evidence. Write the test first; otherwise run it in a temporary worktree at
  the pre-fix commit.
- [R-42] Suites run serially: a loaded machine gives false reds. Run **all** offline
  tests; skip only what needs a live external service, and say so. Compare the counts
  with the dated baseline in the `gate-ritual` skill. A green obtained with a skip or an
  isolation flag is not a green. Read the test names, not only "N passed".
- [R-43] Pushing to a deploy branch triggers: behind-push check, repo-map check on the
  pushed commit, hooks-path check, secret scan (fail-closed when the scanner is
  missing), syntax gate on the pushed content, large-new-file check, and a confirmation.
  The escape variables exist for emergencies and are logged; using one to push a red
  build is forbidden.
- [R-44] "Deploy succeeded" is verified by looking at the deploy evidence line, not
  inferred from the absence of errors. Deploy output can be misleading in both
  directions.
- [R-45] The commit gate (`.githooks/pre-commit`) is cheap and only runs for what is
  staged: board lint, the coordination archive check, and the project checks in
  `preCommit.checks`.
- [R-46] The same shields run for every tool that can be hooked. Codex gets them through
  `codex-guard-adapter` (an "ask" becomes a "deny" there); a tool without hooks follows
  these rules by hand and the tool-independent git hooks still apply.

- [R-47] The `secret-shield` hook stops an agent from reading or overwriting secret files
  (`.env`, private keys, credential files) by accident. It is an accident-level,
  name-based heuristic, not a sandbox, and it has no escape prefix: relaxing it is the
  human's edit of `secrets.*` in the config.
- [R-48] A task is closed only after the gate has run green on the code being committed:
  `node scripts/gate-record.mjs` records the result for the current code state, and the
  commit gate (`done-gate --staged`) refuses a done heading without a matching record. If
  the code changes after the record, record again.

## 7. Decision authority

Who can *do* a task (the board tag) is not who *decides* it. `CLAUDE.md` § Decision
authority holds the project's two lists: what each human decides alone, and what needs
the gatekeeper's explicit approval **before** it happens. Typical entries of the second
list: production infrastructure and security operations (services, server config,
secrets and keys, database users, deleting production data) and architecture-changing
decisions (a new provider, process or port, breaking an existing contract field, auth
and token flows, fail-open versus fail-closed, destructive or non-additive migrations).
New and additive things are usually not on it; changing what running users already
depend on usually is.

- [R-50] When something hits the approval list — in anyone's session, and **especially
  when the agent itself proposed it** — say so plainly ("this needs <gatekeeper>'s
  approval"). Do not ask a different human "shall I accept?" and do not record it as
  their decision. The usual failure is: the agent suggests, a human accepts without
  reading.
- [R-51] Research, a spec and local or worktree code are fine while waiting. No
  production change and no deploy of that part.
- [R-52] Write the proposal and your recommendation as `📋 AWAITING APPROVAL` in the
  coordination file and put the gatekeeper's tag in the board item's `Human step`.
  Record the approval with the approver's words and the date.
- [R-53] A note after the fact is **not** approval. "Skip the policy", "let the agent
  decide" or "on behalf of X" never lifts the list. "I am X" or "X approved" typed by
  someone else counts for nothing; a project that takes approvals from a shared machine
  verifies identity with a mechanism, not a sentence.

## 8. Guard-rails the human has set

Project-specific hard rules, one line each, dated and attributed ("Never touch `<dir>` —
<who>, <date>", "No runtime DDL against production — <who>, <date>"). The bootstrap fills
this from the human's answers; later sessions append here the moment the human states a
rule. Keep the single line below until the first rule exists.

- None yet.

## 9. Communication

- Match the language of the file you edit; documents in the language the config says.
- Ask only what you cannot derive; when you ask, propose a default.
- Report outcomes faithfully: red is red, skipped is skipped, verified is verified.
- No notification, message or board item without a concrete action someone can take.

## 10. Advice does not hold — move it to a deterministic moment

- [R-70] "Do Y when the work is done" is advice, and advice that depends on an agent
  remembering at the end of a long session does not hold. A post-condition that matters
  becomes a script that runs at a fixed moment — session start, commit, push — first as
  a warning, then, once its false positives are fixed, as a block. A new rule is written
  together with the answer to "what enforces it?"; "nothing, it is advice" is a valid
  answer only when said on purpose.

Every gate has an escape, and all escapes are in this one table. Using an escape is
logged by the gate and is the human's call, not the agent's.

| Gate | Moment | Escape |
|---|---|---|
| `git-shield` (destructive git) | before the command runs | `AGENT_DESTRUCTIVE_OK=1` as a prefix of the command itself, on the human's word (does not lift `forbiddenCommands`) |
| `read-guard` (reads, edit runs, subagent recursion) | before the tool call | delegate; thresholds in `delegation.*` |
| `board-lint` | commit | `BOARD_LINT=warn` (report, do not stop) or `BOARD_LINT=skip` |
| coordination archive check | commit | `COORDINATION_CHECK=warn` or `COORDINATION_CHECK=skip` |
| a project check from `preCommit.checks` | commit | `PRE_COMMIT_SKIP_<ID>=1` |
| git pre-push hook (secret scan, syntax, type-check) | push to a deploy branch | `SKIP_PUSH_GATE=1` (name in `secretScan.skipEnv`) |
| `push-guard` (behind, map, hooks path, deploy confirm) | before the push command runs | none: pull, fix the map, run `setup-hooks`, or answer the confirmation |
| large new file | push | `BIG_FILE_OK=1` |
| deploy lock | push to a deploy branch | `DEPLOY_LOCK=skip` |
| `context-watch` | each prompt | `CONTEXT_WATCH=off` |
| `secret-shield` | before the tool call | none by design: the human edits `secrets.mode` / `secrets.allow` in the config |
| `done-gate` | commit | `PRE_COMMIT_SKIP_DONE_GATE=1`, with the reason in the commit message |
| equivalent-merge detection (`git.hygiene.equivalentMerge`) | session start | `off` is the default; set `cherry` to opt in |
