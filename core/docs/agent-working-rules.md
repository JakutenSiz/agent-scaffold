# Agent working rules (canonical)

> Single canonical home for how AI agents work in this project. `CLAUDE.md`, `AGENTS.md`
> and `GEMINI.md` link here; they do not restate these rules. Memory-bank rules live in
> `docs/memory-bank-guide.md`; task-board rules in the board's §9; coordination rules in
> the coordination file's `## Protocol`. One rule, one home — copies drift.

## 1. Delegation-first: the main agent is the architect

The expensive main model decides; cheaper workers do the grunt work. Only
decision-ready summaries enter the main context.

| Work | Who | Model tier |
|---|---|---|
| Multi-file exploration or reading (5+ files), "where is X", pattern sweeps | `scout` subagent | cheapest |
| Well-specified mechanical edits: repetitive multi-file changes, renames, boilerplate, i18n, fixtures | `worker` subagent | mid |
| Gate and test runs after a change | `verifier` subagent | mid |
| Second opinion from another model family, large diff sweeps | cross-model lane (Codex `codex exec`, or another CLI) on its strong default model | strong |
| Architecture, specs, final decisions, anything the human must trust | main agent | strongest |

Rules:

- The main agent does **not** read file after file itself. Past five reads in one turn it
  should already have delegated; the `read-guard` hook warns at `warnAfterReads` and denies
  at `denyAfterReads` (see `agent-scaffold.config.json`).
- Generic subagents inherit the main model unless told otherwise — always pass the mid
  model to a generic subagent unless the sub-task truly needs the top model.
- **The agent tree is single-level.** Only the main agent delegates. A subagent never
  spawns its own subagent; if the job is bigger than its brief, it stops and reports
  back, and the main agent decides how to split it. (Unrestricted workers recurse and
  loop; measured, not theoretical.)
- A brief to a worker is a spec: goal, files to touch, files NOT to touch, known traps,
  acceptance command, and an explicit "stop and report if X" threshold. A worker applies
  a wrong instruction as faithfully as a right one, so the architect never writes a
  guess as an instruction — uncertain points are marked "your call, by criterion Y".
- Commit authority is stated in the brief. If a worker may commit, say so and give the
  message; otherwise the main agent commits. Serialize jobs that touch the same file.

## 2. Where knowledge lives

| Kind of knowledge | Home | Not here |
|---|---|---|
| Permanent facts about a repo (structure, commands, patterns, traps) | that repo's `memory-bank/` | chat, private agent memory |
| Current work state, open decisions | `memory-bank/activeContext.md` + `progress.md` (sliding window) | task board |
| Task status, evidence, remaining work | the task board (`board.file`) | coordination file |
| Agent-to-agent messages, claims, hand-overs | the coordination file (`coordination.file`) | task board |
| Research syntheses worth keeping | `reports/YYYYMMDD-<topic>.md` | memory bank (until it becomes a permanent fact) |
| Implementation recipes for workers | `specs/YYYYMMDD-<job>/<part>.md` | reports |
| Repeated procedures | `.claude/skills/<name>/SKILL.md` | private memory |

Search `reports/` and `specs/` **before** exploring anew. Closed items move to
`_archive/` subfolders; nothing is deleted.

## 3. Skills are the shared memory for procedures

When the same procedure has been carried out **three** times (twice if the first run cost
a trap or a long discovery), the agent — not the human — writes
`.claude/skills/<name>/SKILL.md`: trigger phrases in the description, sources, ordered
steps, a "Done when" section, dated pitfalls. Test it in a fresh session **without naming
the skill**. A recipe that lives only in one agent's private memory is invisible to other
tools, workers and machines — wrong layer. Workers have the Skill tool and call the
matching skill before a ritual step. The recipe for writing one is the `new-skill` skill.

## 4. Sessions

1. Read the SessionStart note (Claude Code / Codex hook) or, without hooks, do what it
   does: pull, check for repos that are behind, read the coordination file, look at the
   size warning.
2. Before non-trivial work in a repo, read its `memory-bank/repoMap.md` and
   `activeContext.md`. The `map-guardian` hook injects the map on your first edit anyway.
3. Pick work from the task board. Claim it in the coordination file with the item code.
   No item? Add one first (code scheme `<MMDD>-<slug>`, authorization tag mandatory).
4. Before writing a shared piece (component, helper, client), check
   `memory-bank/reuse-registry.json`. The hook rejects re-implementing a registered piece.
5. When done: evidence into the board item (same edit updates the heading), claim to
   "Done" and archived in the same commit, `activeContext.md`/`progress.md` updated, new
   source files added to `repoMap.md` (the push gate rejects files it cannot find in the
   map).
6. Leaving work half-done: write a hand-over note in the coordination file's "Handed-over
   work" section. Half-done work is never ownerless.

## 5. Gates and pushes

- After every code change run the gates for that repo (the `gate-ritual` skill has the
  table). Never run the whole suite in parallel with other heavy runs: loaded machines
  give false reds. One run, serial, then trust it.
- Run **all** offline tests; skip only what needs a live external service, and say so.
  If no test exists for what you changed, write one.
- Pushing to a deploy branch triggers: behind-push check, repo-map check, secret scan
  (fail-closed when the scanner is missing), syntax gate, and a confirmation. The escape
  hatch env var exists for emergencies and is logged; using it to push a red build is
  forbidden.
- "Deploy succeeded" is verified by looking at the deploy evidence line, not inferred
  from the absence of errors. Deploy output can be misleading in both directions.

## 6. Guard-rails the human has set

Project-specific hard rules, one line each, dated and attributed ("Never touch `<dir>` —
<who>, <date>", "No runtime DDL against production", "No new features until further
notice"). The bootstrap fills this from the human's answers; later sessions append here
the moment the human states a rule. Keep the single line below until the first rule exists.

- None yet.

## 7. Communication

- Match the language of the file you edit; documents in the language the config says.
- Ask only what you cannot derive; when you ask, propose a default.
- Report outcomes faithfully: red is red, skipped is skipped, verified is verified.
- No notification, message or board item without a concrete action someone can take.
