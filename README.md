# agent-scaffold

A generic, project-independent working structure for AI coding agents. It packages the
practices that made one long-running multi-repo product work well with agents —
delegation-first roles, a memory bank per repo, a task board, a coordination file,
edit/read/push guards, size sentinels, sliding-window archives and a skill house style —
into a template an agent can install around **any** project in one run.

## Use it in three steps

1. Put your project into `proje/`. A source tree, a git clone, several repos side by
   side, or just a `proje/PROJECT.md` describing what you want to build.
2. Open your agent (Claude Code, Codex, Gemini CLI, …) in this folder and say:

   > Read `START.md` and do what it says.

3. Answer the few questions it cannot derive from the code (language, deploy branches,
   who the human gatekeeper is). When it reports done, `proje/` is your project with the
   whole structure inside. Move it wherever you like.

## What you get inside `proje/`

| Piece | Purpose |
|---|---|
| `CLAUDE.md`, `AGENTS.md`, `GEMINI.md` | Project facts for agents; rules are linked, not copied |
| `docs/agent-working-rules.md` | The canonical working rules: delegation-first, single-level agent tree, where knowledge lives, gates, pushes |
| `docs/memory-bank-guide.md` | The memory-bank rulebook |
| `memory-bank/` per repo | 8 files: brief, product context, system patterns, tech context, **repo map**, **capability registry**, active context, progress + `reuse-registry.json`, `repomap-guard.json` |
| `task-board.md` + archive | Single task list with status markers, compact item template, authorization tags |
| `coordination.md` + archive | Claims, messages and hand-overs between agents, with a ten-rule protocol |
| `reports/`, `specs/` | Durable research syntheses; recipes handed to workers |
| `.claude/agents/` | `scout` (cheap explorer), `worker` (mechanical edits), `verifier` (gates) |
| `.claude/hooks/` | session-context, read-guard (forces delegation), map-guardian (injects the repo map, blocks duplicate shared pieces), edit-check (syntax/type check after each edit), push-guard (behind-push, repo-map and deploy-branch gates), test-runner-guard, ensure-agent-compat |
| `.claude/skills/` | `gate-ritual`, `orchestrator`, `new-skill` |
| `scripts/` | `md-size-watch`, `memory-bank-archive`, `repomap-check`, `board-staleness`, `pre-push-check`, `list-configured-repos` + the shared config loader |
| `.githooks/pre-push`, `setup-hooks.*` | Secret scan and syntax gate on deploy-branch pushes, tool-independent |
| `.codex/` | Codex profiles mirroring the three roles, hook wiring |
| `agent-scaffold.config.json` | Every parameter in one place: repos, commands, ceilings, deploy branches, labels, language |

Requirements: Node ≥ 18 for hooks and scripts (documents work without it), git.
Optional: `gitleaks` for the secret scan (the pre-push gate fails closed without it by
design; set `secretScan.failClosed=false` to change that).

## Layout of this package

```
START.md      the procedure the agent follows (tool-agnostic)
proje/        your project goes here; the output is generated inside it
core/         the fixed layer, copied into the project unchanged
  docs/  scripts/  .claude/  .codex/  .githooks/  setup-hooks.*
  agent-scaffold.config.example.json
  templates/  filled by the agent, never copied raw
docs/
  DESIGN.md        why each mechanism exists (the lessons behind them)
  CUSTOMIZING.md   what to change for your team, and how to update the package
```

## Languages

Templates and rules are English. Set `language` in the config and the agent writes the
prose of every generated document in that language; file names, headings that scripts
parse, keys and commands stay English so the tooling keeps working.

---

## Türkçe kısa özet

Bu paket, ajanlarla iyi çalışan bir proje yapısını (memory bank, görev panosu,
koordinasyon dosyası, delegasyon rolleri, kapılar, kayan pencere arşivi, skill'ler) her
projeye kurulabilir hale getirir. Projeni `proje/` klasörüne koy, ajana "`START.md`'yi oku
ve dediğini yap" de, sorduğu birkaç soruyu cevapla. Bitince `proje/` yapının tamamını
içeren hazır projendir; dil için `language: "tr"` seçersen üretilen belgeler Türkçe olur.
