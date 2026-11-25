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

## Use it in three steps

1. Put your project into `proje/`. A source tree, a git clone, several repos side by
   side, or just a `proje/PROJECT.md` describing what you want to build.
2. Open your agent (Claude Code, Codex, Gemini CLI, …) in this folder and say:

   > Read `START.md` and do what it says.

3. Answer its questions. Round 1, before it generates anything: the few facts it cannot
   derive from the code (language, deploy branches, who instructs agents and who must
   approve what). Round 2, after generation: the blanks only you know (model ids, a
   command it could not find, what a deploy script does). Answers go straight into the
   files; what you skip becomes a task on the board. When it reports done, `proje/` is
   your project with the whole structure inside. Move it wherever you like.

## Where to work afterwards

This folder is a one-time workbench. When the bootstrap is done, move `proje/` to its
permanent place (or, for an existing repo, copy the generated files into your real clone)
and open your agent **at that project's root** — the directory that holds
`agent-scaffold.config.json` and `.claude/`. Hooks resolve their paths from the directory
the agent is opened in; opened in a subfolder such as `src/`, nothing fires and nothing
warns. For a multi-repo layout the root is the umbrella directory that contains the repos.

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
| `.claude/hooks/` | `session-context` (pull, freshness, config-driven status lines), `context-watch` (tells the agent to hand over when the context grows), `read-guard` (forces delegation; counts shell reads too), `git-shield` (denies `stash`/`reset --hard`/`checkout --`/`clean -f` in a shared checkout), `map-guardian` (injects the relevant part of the repo map, blocks duplicate shared pieces), `edit-check`, `push-guard` (behind-push, repo-map, hooks-path, deploy-lock and deploy-branch gates), `test-runner-guard`, `ensure-agent-compat`, `codex-guard-adapter` (the same shields for Codex) |
| `.claude/skills/` | `gate-ritual`, `orchestrator`, `handoff`, `new-skill` |
| `scripts/` | Sentinels and movers: `md-size-watch`, `memory-bank-archive`, `memory-bank-check`, `repomap-check`, `board-staleness`, `board-lint`, `board-archive`, `board-duplicate`, `human-queue`, `coordination-archive`, `git-hygiene-watch`, `git-hygiene-clean`, `orphan-process`, `rule-inventory`, `delegation-share`, `pre-commit-check`, `pre-push-check` + shared helpers in `lib/` |
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

v0.2 (November 2026). The fixed layer now has a test suite (`npm test`, Node's built-in
runner, no dependencies; the tests live in `tests/` and are not copied into projects).

What v0.2 adds over v0.1, all taken from two and a half more months of the source
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
exercised: a multi-repo layout end to end, Codex actually dispatching the adapter (it
must trust the project hooks first), Gemini as the bootstrapping agent, Linux, Windows.

Upgrading a project installed from v0.1: see `docs/CUSTOMIZING.md` § Updating the
package itself.

## Layout of this package

```
START.md      the procedure the agent follows (tool-agnostic)
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
