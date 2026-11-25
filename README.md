# agent-scaffold

A generic, project-independent working structure for AI coding agents. It packages the
practices that made one long-running multi-repo product work well with agents —
delegation-first roles, a memory bank per repo, a task board, a coordination file,
guards on reads, edits, git and pushes, commit and push gates, session-start sentinels,
sliding-window archives and a skill house style — into a template an agent can install
around **any** project in one run.

The idea behind most of it: a rule that depends on an agent remembering something at the
end of a long session does not hold. What must hold is moved to a deterministic moment —
session start, commit, push — and enforced there. `docs/DESIGN.md` has the measured
failure behind each mechanism.

## Quick start

Requirements: Node ≥ 18 and git.

1. Put your project into `proje/` (a source tree, a git clone, several repos side by
   side, or just a `proje/PROJECT.md` describing what you want to build). Another
   directory works too; below, `proje/` stands for it.
2. Open your agent (Claude Code, Codex, Gemini CLI, …) in this folder and say:

   > Read `START.md` and do what it says.

   The agent discovers the project, asks the few facts it cannot derive (language, deploy
   branches, who instructs agents and who must approve what), writes the config and runs
   `node bin/agent-scaffold.mjs install proje`, then fills the blanks that are left.
   Round 2 of its questions comes after generation: model ids, a command it could not
   find, what a deploy script does. What you skip becomes a task on the board.
3. Check the result: `node bin/agent-scaffold.mjs doctor proje` prints PASS, WARN or FAIL
   per row and exits 1 on any FAIL.

You can also fill `agent-scaffold.config.json` yourself and run `install` without an
agent; `install --dry-run` lists what it would write and never overwrites an existing
file (it writes `<file>.new` instead). `upgrade` applies a newer package later; see
`docs/CUSTOMIZING.md`. A generated example is in [`examples/minimal`](examples/minimal)
(regenerate with `npm run example`).

## Profiles

`"profile"` in the config picks how strict the gates are; a value you write yourself
always wins. Fixed in every profile: the destructive-git denial, the subagent-recursion
denial, the secret scan fail-closed, the secret-file shield.

| Profile | For | What changes |
|---|---|---|
| `minimal` | trying the scaffold, small projects | board lint off, repo-map and deploy-confirm gates off, no read/edit denial, context warning at 600k tokens, done gate off |
| `standard` (default) | most teams | board lint warns, reads denied after 10, large files warn, repo-map, hooks-path and deploy-confirm gates on |
| `strict` | repositories where a bad push is expensive | board lint blocks, reads denied after 6 and edits after 25, large files block at 1 MB, one test worker, done gate blocks |

The complete table is under "Gates" below and in `docs/CUSTOMIZING.md` § Profiles.

## Where to work afterwards

When the bootstrap is done, move `proje/` to its permanent place (or, for an existing
repo, install straight into your clone) and open your agent **at that project's root** —
the directory that holds `agent-scaffold.config.json` and `.claude/`. Hooks resolve
their paths from the directory the agent is opened in; opened in a subfolder such as
`src/`, nothing fires and nothing warns. For a multi-repo layout the root is the
umbrella directory that contains the repos.

## What you get inside `proje/`

| Piece | Purpose |
|---|---|
| `CLAUDE.md`, `AGENTS.md`, `GEMINI.md` | Project facts for agents, including who decides what; rules are linked, not copied |
| `docs/agent-working-rules.md` | The canonical working rules, each with an id (`[R-nn]`): delegation-first, single-level agent tree, sessions, shared checkout, gates, decision authority, and the one table of gate escapes |
| `docs/memory-bank-guide.md` | The memory-bank rulebook in ~90 lines with a "what to read for which task" table; long detail in the appendix, required headings in a JSON schema |
| `docs/tool-traps.md` | Tool pitfalls, one dated row per bite |
| `memory-bank/` per repo | 8 files: brief, product context, system patterns, tech context, **repo map**, **capability registry**, active context, progress + `reuse-registry.json`, `repomap-guard.json` |
| `task-board.md` + archive | Single task list with status markers, compact item template with a `Human step` field, authorization tags |
| `coordination.md` + archive | Claims (one table row each), messages and hand-overs between agents |
| `reports/`, `specs/` | Durable research syntheses; recipes handed to workers |
| `.claude/agents/` | `scout` (cheap explorer), `analyst` (read-only flow and root-cause analysis), `worker` (mechanical edits), `verifier` (gates). Every report ends with a `Better path:` line |
| `.claude/hooks/` | `session-context` (pull, freshness, config-driven status lines), `context-watch` (tells the agent to hand over when the context grows), `read-guard` (forces delegation; counts shell reads too), `git-shield` (denies `stash`/`reset --hard`/`checkout --`/`clean -f` in a shared checkout), `map-guardian` (injects the relevant part of the repo map, blocks duplicate shared pieces), `edit-check`, `push-guard` (behind-push, repo-map, hooks-path, deploy-lock and deploy-branch gates), `test-runner-guard`, `secret-shield` (blocks reading or overwriting `.env`, keys and credential files by accident; see Gates below), `ensure-agent-compat`, `codex-guard-adapter` (the same shields for Codex) |
| `.claude/skills/` | `gate-ritual`, `orchestrator`, `handoff`, `new-skill` |
| `scripts/` | Sentinels and movers (plus `gate-record`, `done-gate`, `handoff-packet`): `md-size-watch`, `memory-bank-archive`, `memory-bank-check`, `repomap-check`, `board-staleness`, `board-lint`, `board-archive`, `board-duplicate`, `human-queue`, `coordination-archive`, `git-hygiene-watch`, `git-hygiene-clean`, `orphan-process`, `rule-inventory`, `delegation-share`, `pre-commit-check`, `pre-push-check` + shared helpers in `lib/` |
| `.githooks/`, `setup-hooks.*` | Tool-independent gates: pre-commit (board lint, coordination check, your own checks — only for what is staged), pre-push (secret scan and syntax gate on the pushed content for deploy branches, large-new-file check) |
| `.codex/` | Codex profiles mirroring the roles, hook wiring |
| `agent-scaffold.config.json` | Every parameter in one place: repos, commands, ceilings, deploy branches, labels, humans, status lines, gate modes, language |

Requirements: Node ≥ 18 for hooks and scripts (documents work without it), git.
Optional: `gitleaks` for the secret scan (the pre-push gate fails closed without it by
design; set `secretScan.failClosed=false` to change that).

New gates ship in warning mode (`board.lint.mode`, `pushGate.bigBlobMode`) and the
branch/worktree cleaner only reports (`git.hygiene.autoClean: false`). Raise them when
the warnings have proven to be real — that is how they were introduced in the source
project too.

## Status

v0.3 (November 2026). The fixed layer has a test suite (`npm test`, Node's built-in
runner, no dependencies; the tests live in `tests/` and are not copied into projects).

What v0.3 adds over v0.2: the `install`, `upgrade` and `doctor` commands with a file
manifest; profiles; the secret shield; the done gate; equivalent-merge recognition in git
hygiene; the handoff packet; the generated gate table below; `examples/minimal`; CI.
The new commands and gates are covered by the test suite. They have not yet been used on
a project other than the one they came from.

What v0.2 added over v0.1, all taken from two and a half more months of the source
project: the `analyst` role and the `Better path:` channel; `git-shield`; shell reads
counted by `read-guard`; a commit gate; pushed-content (not working-tree) checks, the
hook-environment fix, hooks-path, large-file and deploy-lock gates; board lint, board
archive, human queue and duplicate check; claims as single table rows with a scripted
archive; git hygiene watch and clean; context watch and the `handoff` skill; config-driven
session-start lines; rule ids and the rule inventory; decision authority for more than
one human; the short memory-bank guide with a checked schema; the Codex guard adapter;
several bug fixes in the v0.1 scripts (a main-module check that silently did nothing
under a symlinked path, an archive script that added a blank line on every run).

What was verified: the test suite on macOS with Node 22, and an end-to-end install into
a scratch project with the hooks driven by synthetic payloads. v0.1 was bootstrapped
end to end on two projects (a small Node service and a Python/uv research repo); the
v0.2 bootstrap procedure has not yet been re-run by a fresh agent on a new project. Not
exercised by hand: a multi-repo layout end to end, Codex actually dispatching the adapter
(it must trust the project hooks first), Gemini as the bootstrapping agent. CI runs the
tests on Linux and macOS (`.github/workflows/test.yml`). Windows has not been tried.

Upgrading a project installed from v0.1: see `docs/CUSTOMIZING.md` § Updating the
package itself.

## License

MIT. See `LICENSE`.

## Layout of this package

```
START.md      the procedure the agent follows (tool-agnostic)
bin/           the CLI: install, upgrade, doctor
examples/     a generated example installation (examples/minimal)
proje/        your project goes here; the output is generated inside it
core/         the fixed layer, copied into the project unchanged
  docs/  scripts/  .claude/  .codex/  .githooks/  setup-hooks.*
  agent-scaffold.config.example.json
  templates/  filled by the agent, never copied raw
tests/        tests of core/ (npm test); not copied
docs/
  DESIGN.md        why each mechanism exists (the lessons behind them)
  CUSTOMIZING.md   what to change for your team, and how to update the package
```

## Languages

Templates and rules are English. Set `language` in the config and the agent writes the
prose of every generated document in that language; file names, headings and markers
that scripts parse, keys and commands stay English so the tooling keeps working. Board
field names and memory-bank headings can be translated too — through `board.fields` and
`docs/memory-bank-schema.json`.

---

## Türkçe kısa özet

Bu paket, ajanlarla iyi çalışan bir proje yapısını (memory bank, görev panosu,
koordinasyon dosyası, delegasyon rolleri, kalkanlar ve kapılar, kayan pencere arşivi,
skill'ler) her projeye kurulabilir hale getirir. Projeni `proje/` klasörüne koy, ajana
"`START.md`'yi oku ve dediğini yap" de, sorduğu birkaç soruyu cevapla. Bitince `proje/`
yapının tamamını içeren hazır projendir; dil için `language: "tr"` seçersen üretilen
belgeler Türkçe olur. Temel fikir: "iş bitince şunu yap" türü tavsiyeler tutmaz; tutması
gereken kural oturum başı, commit ya da push anında koşan bir betiğe bağlanır.

## Gates

What each gate does under the three profiles, generated from the code (`node core/scripts/gate-table.mjs --write`; a test keeps it in sync).

<!-- gates:begin -->
| Gate | Where | minimal | standard | strict | Escape |
| --- | --- | --- | --- | --- | --- |
| `git-shield` destructive git commands (reset --hard, checkout --, restore, clean -f, stash, --autostash) | PreToolUse Bash\|PowerShell | block | block | block | prefix the command with AGENT_DESTRUCTIVE_OK=1 |
| `git-shield-forbidden` project-defined forbidden commands (git.shield.forbiddenCommands) | PreToolUse Bash\|PowerShell | off | off | off | edit git.shield.forbiddenCommands |
| `git-shield-worktree-debt` `git worktree add` while removable branches + worktrees pile up | PreToolUse Bash\|PowerShell | ask (> 20 removable) | ask (> 5 removable) | ask (> 2 removable) | clean up (scripts/git-hygiene-clean.mjs --yaz) |
| `read-guard-reads` main session keeps reading instead of delegating (counted reads, shell reads included) | PreToolUse Read\|Grep\|Glob\|Agent\|Workflow\|Task\|Bash\|PowerShell | off | block (> 10 reads) | block (> 6 reads) | delegate to a subagent (renews the allowance) or send a new prompt |
| `read-guard-recursion` a subagent spawning its own subagent | PreToolUse Read\|Grep\|Glob\|Agent\|Workflow\|Task\|Bash\|PowerShell | block | block | block | none (report back to the main agent) |
| `read-guard-reads-reminder` soft reminder after N reads in the main session | PostToolUse Read\|Grep\|Glob\|Bash\|PowerShell | warn (at 8 reads) | warn (at 5 reads) | warn (at 3 reads) | none |
| `read-guard-edits` main session keeps editing files instead of handing work to a worker | PreToolUse Edit\|Write | off | off | block (> 25 edits) | delegate to a worker (renews the allowance) or send a new prompt |
| `read-guard-edits-reminder` one-time reminder after N edits in the main session | PreToolUse Edit\|Write | warn (at 30 edits) | warn (at 15 edits) | warn (at 10 edits) | none |
| `read-guard-reset` resets the read/edit counters at every user prompt (bookkeeping, not a gate) | UserPromptSubmit | measure | measure | measure | none |
| `context-watch` context too large or session idle: tells the agent to hand off | UserPromptSubmit | warn (> 600000 tokens) | warn (> 300000 tokens) | warn (> 200000 tokens) | CONTEXT_WATCH=off |
| `session-context` SessionStart note: coordination file, status lines, auto-pull | SessionStart | measure | measure | measure | none |
| `ensure-agent-compat` links Codex and Claude hook sources; sets core.hooksPath when it is empty | SessionStart | measure | measure | measure | session.ensureHooksPath: true |
| `map-guardian-map` injects the relevant repo-map slice on the first edit in a repo | PreToolUse Edit\|Write | measure | measure | measure | none |
| `map-guardian-reuse` new code that re-implements a piece registered in reuse-registry.json | PreToolUse Edit\|Write | off | block | block | update memory-bank/reuse-registry.json first |
| `push-guard-delete` deleting a deploy or main branch on the remote | PreToolUse Bash | block | block | block | none |
| `push-guard-behind` pushing while the checkout is behind the remote branch | PreToolUse Bash | block | block | block | pull first (a force push skips the check) |
| `push-guard-map` pushed source files missing from the repo map | PreToolUse Bash | off | block | block | add the files to the map |
| `push-guard-hookspath` deploy push from a clone without core.hooksPath (pre-push would never run) | PreToolUse Bash | off | block | block | run setup-hooks.sh |
| `push-guard-deploy-lock` a second deploy push while another one is running | PreToolUse Bash | block | block | block | prefix the command with DEPLOY_LOCK=skip |
| `push-guard-confirm` push to a deploy branch (automatic deploy) | PreToolUse Bash | off | ask | ask | answer yes |
| `secret-shield` reading or overwriting secret files (.env, keys, credential files) by name | PreToolUse Read\|Edit\|Write\|MultiEdit\|NotebookEdit\|Grep\|Glob\|Bash\|PowerShell | block (accident-level) | block (accident-level) | block (accident-level) | none (a human edits secrets.* in the config) |
| `test-runner-guard` test runs with too many workers or while orphaned runner processes pile up | PreToolUse Bash\|PowerShell | block (> 4 workers) | block (> 2 workers) | block (> 1 workers) | lower the worker count / clean up orphans |
| `edit-check` post-edit syntax/type check from repos[].editCheck (wakes the agent on failure) | PostToolUse Edit\|Write | off | off | off | none |
| `codex-guard-adapter` replays the Bash hooks for Codex; `ask` becomes `deny`; risky commands fail closed | Codex PreToolUse (Bash) | block | block | block | none (project hooks must be trusted in Codex) |
| `board-lint` board edits that break the compact item template | git pre-commit | off | warn | block | BOARD_LINT=skip |
| `coordination-check` coordination file with closed note sections still in it | git pre-commit | warn | block | block | COORDINATION_CHECK=skip |
| `done-gate` closing a board item without a green gate record (opt-in: needs doneGate.command) | git pre-commit | off | block (opt-in: set doneGate.command) | block (opt-in: set doneGate.command) | PRE_COMMIT_SKIP_DONE_GATE=1 |
| `pre-commit-project-checks` project checks from preCommit.checks (run when matching files are staged) | git pre-commit | off | off | off | PRE_COMMIT_SKIP_<ID>=1 |
| `big-blob` new blobs over pushGate.maxBlobMB in any pushed branch | git pre-push | warn (> 10 MB) | warn (> 2 MB) | block (> 1 MB) | BIG_FILE_OK=1 |
| `secret-scan` secret scan over the pushed commits (deploy branches only) | git pre-push | block | block | block | SKIP_PUSH_GATE=1 |
| `push-syntax-check` repos[].checks.syntax on the pushed content (deploy branches only) | git pre-push | off | off | off | SKIP_PUSH_GATE=1 |
| `push-typecheck` repos[].checks.typecheck on the pushed commit (deploy branches only) | git pre-push | off | off | off | SKIP_PUSH_GATE=1 |

Labels: `block` denies or fails the command; `ask` needs a human yes; `warn` says it and lets it pass; `measure` records or injects context only; `off` is inactive under that profile. `(opt-in ...)` means the gate does nothing until the named setting is filled in. Generated from the registry in `core/scripts/lib/gates.mjs`; refresh with `node core/scripts/gate-table.mjs --write`.
<!-- gates:end -->
