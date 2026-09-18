# START — bootstrap an agent-ready working structure around the project in `proje/`

> **You are an AI coding agent and a human just told you to read this file.**
> Your job: turn whatever is inside `proje/` into a project that AI agents can work on
> well — with a rulebook, a memory bank, a task board, a coordination file, delegation
> roles, guards and rituals — following the procedure below. Everything you generate
> goes **inside `proje/`**, so that `proje/` becomes the finished, self-contained project
> the human can move anywhere.
>
> This file is tool-agnostic. It works for Claude Code, Codex CLI, Gemini CLI or any
> agent that can read files, run shell commands and write files. Parts that only one tool
> can use (Claude Code hooks, Codex profiles, `GEMINI.md`) are installed anyway; they are
> inert elsewhere and cheap to keep.

---

## 0. What you are building (read once, then act)

The structure has two layers.

| Layer | What it is | Where it comes from |
|---|---|---|
| **Fixed** | Rules and mechanisms that are the same for every project: delegation-first working style, memory-bank guide, task-board and coordination-file mechanics, sliding-window archive rule, subagent roles, edit/read/push guards, size sentinels, skill house style. | Copied from `core/` unchanged. |
| **Generated** | Everything that depends on *this* project: stack, commands, repo map, entry points, capability registry, deploy branches, first task-board items, project traps. | You derive it from `proje/` and write it into the templates. |

The rationale for every mechanism is in `docs/DESIGN.md`. You do not need it to run
this procedure, but read it if the human asks "why".

Principles that override everything else in this file:

1. **Discover before you ask.** Anything you can derive from the code (stack, commands,
   layout, language of comments) you derive. You ask only what you cannot derive.
2. **Never overwrite the human's files.** If `proje/` already has a `CLAUDE.md`,
   `AGENTS.md`, `README.md`, `.claude/`, `memory-bank/` or similar, their content stays.
   The per-file rule is in step 5 (fixed layer: merge arrays, add only free names,
   `.scaffold` twin for same-named docs/scripts) and step 6 (`CLAUDE.md`: append a marked
   section). Deleting is never part of this procedure.
3. **No placeholder survives.** When you finish, `grep -r "{{" proje/` and
   `grep -r "<!-- fill:" proje/` must return nothing. Facts you could not establish are
   written as an explicit line "Unknown as of <date>: …" and become task-board items.
4. **Delegate the reading.** If your tool can spawn cheap subagents, the discovery phase
   is their job; you keep the decisions. If it cannot (you are yourself a subagent, or the
   tool has no delegation), do it yourself but keep summaries, not file dumps, in your
   context. The bootstrap run may break the delegation rule it installs; the steady-state
   sessions after it must not.
5. **Report honestly.** The final report says what was verified by running a command,
   what was only written, and what still needs the human.

---

## 1. Preconditions

1. `ls proje/`. If it is empty or only contains `README.md`: stop and ask the human to
   put the project there (source tree, a git clone, several repos side by side, or even
   just a written description of the project in `proje/PROJECT.md`). A description alone
   is enough to bootstrap a **greenfield** project; note that mode and continue.
2. Check tools: `node --version` (hooks and scripts need Node ≥ 18), `git --version`.
   If Node is missing, the guards and sentinels cannot run; you still generate all the
   documents and say so in the report.
3. Check whether `proje/agent-scaffold.config.json` already exists. If yes, this is a
   **re-run**: load it, skip the questions it already answers, and only regenerate files
   that are missing or that the human asked you to refresh.

---

## 2. Discovery (derive, do not ask)

Produce the inventory below. Use a cheap explorer subagent if you have one; give it this
list verbatim and ask for a ≤ 60-line summary with file paths.

| Fact | How to find it |
|---|---|
| **Layout** | One repo (`single`) or several repos side by side / git submodules / a monorepo with workspaces (`multi`). Look for `.gitmodules`, multiple `.git` dirs, `workspaces` in `package.json`, `pnpm-workspace.yaml`, `Cargo` workspaces, etc. |
| **Repos / packages** | For each: path, name, stack (node / python / go / rust / java / dotnet / php / mobile / other), package manager, entry point. |
| **Commands** | Install, dev, build, lint, type-check, test, single-test — from `package.json` scripts, `Makefile`, `pyproject.toml`, `Cargo.toml`, `go.mod`, CI files (`.github/workflows`, `.gitlab-ci.yml`), README. |
| **Syntax / type check per file type** | What is the cheapest correct check for an edited file? (`node --check`, `tsc --noEmit -p <dir>`, `python -m py_compile`, `go vet ./...`, `cargo check`, …). This fills `editCheck` in the config. |
| **Deploy story** | Branch names that deploy (CI triggers, `deploy*.sh`, docs), hosts, services. If nothing deploys, say so. |
| **Data layer** | DB engine, migrations dir, ORM or raw SQL, shared schema across repos. |
| **Existing agent docs** | `CLAUDE.md`, `AGENTS.md`, `GEMINI.md`, `.cursorrules`, `.claude/`, `.codex/`, `docs/`, `memory-bank/`. These must be merged, never replaced. |
| **Prose language** | Language of comments, commit messages, README. This is the default for `language`. |
| **Domain** | What the product does, in 3–5 sentences, from README / docs / route names / models. |
| **Hotspots** | The 10–20 files a newcomer must know: entry points, routers, config, schema, shared helpers, the biggest modules. |
| **Existing tests** | Test dirs, runner, rough count (`grep -rl "test(" | wc -l` style), whether they run green (run them if it is cheap; do not run anything that needs external services). |

Write the inventory to `proje/reports/<YYYYMMDD>-scaffold-discovery.md` (create the
directory). It is the first entry of the project's reports archive and the evidence for
everything you generate next.

---

## 3. Questions, round 1 (only what discovery could not answer)

Ask at most **six** questions, in one message, each with your proposed default so the
human can answer "defaults are fine". Skip any question the inventory already answered.
If your tool has a structured question widget (Claude Code's AskUserQuestion, for
example), use it with the default as the first option; otherwise ask in plain text.

1. **Language** for generated documents. Precedence: the prose language discovery found
   in the repo wins and the question is skipped; ask only when the repo is mixed or empty
   (then default `en`). File names, config keys and code stay English regardless.
2. **Layout** confirmation if ambiguous (`single` / `multi`).
3. **Deploy branches** per repo, if any were found or suspected. Pushing to these will
   trigger a confirmation gate and a secret scan.
4. **Human gatekeeper**: the name or role of the person who alone may approve destructive
   or architectural steps (DB migrations, deleting data, changing auth). Default: "the
   project owner".
5. **Which agent tools** the team uses (Claude Code / Codex / Gemini / other). Default:
   install all wiring.
6. **Anything that must never be touched** (prod credentials dir, generated code, vendor
   dirs, a folder another team owns). These go into the rulebook's "never touch" list.

If you cannot ask (non-interactive run), take every default, write the defaults you took
into the final report, and add one task-board item "Confirm scaffold defaults" tagged for
the human.

There is a **second round after generation** (step 8b) for the blanks only the human can
fill. Do not ask those now; you do not yet know which ones exist.

---

## 4. Write the config

Copy `core/agent-scaffold.config.example.json` to `proje/agent-scaffold.config.json` and
fill every key from the inventory and the answers. Rules:

- `repos[]`: one entry per repo/package with a real `path`, `stack`, `checks`, `editCheck`
  (glob → command, `{file}` and `{repo}` placeholders), `deployBranches` (empty array if
  nothing deploys), `sourceExtensions`.
- `pendingPhrases`: keep the English defaults and add the equivalents in the chosen
  language (these keep an entry from being archived).
- If `language` is not `en`, also add `board.doneSignals` and `board.partialSignals` in
  that language (the staleness sentinel's defaults are English words; without these it
  never fires on a non-English board).
- `session.skills`: the skills you will install in step 6.
- Remove the `$comment` key.
- Validate: `node -e "JSON.parse(require('fs').readFileSync('proje/agent-scaffold.config.json','utf8'))"`.

---

## 5. Install the fixed layer

Copy the contents of `core/` into `proje/` (for `multi` layout: into the umbrella root,
the directory that contains the repos). Do **not** copy `agent-scaffold.config.example.json`
and do not copy `core/templates/` — templates are consumed in step 6, not installed.
Append `core/templates/gitignore.snippet` to `proje/.gitignore` (create it if missing):
the hooks write per-session state under `.claude/` and `ensure-agent-compat` creates
links that must never be committed.

What lands where:

```
proje/
  agent-scaffold.config.json        (step 4)
  docs/agent-working-rules.md       fixed — delegation-first rules, agent tree, skills
  docs/memory-bank-guide.md         fixed — the memory-bank rulebook
  scripts/lib/config.mjs            fixed — shared config loader
  scripts/md-size-watch.mjs         sentinel: warns when sliding-window files pass their ceiling
  scripts/memory-bank-archive.mjs   moves old dated entries to memory-bank/archive/ (never deletes)
  scripts/repomap-check.mjs         push gate helper: new source files must be findable in repoMap.md
  scripts/board-staleness.mjs       flags task-board items whose body says "done" but heading says "open"
  scripts/pre-push-check.mjs        the logic behind .githooks/pre-push (secret scan + syntax gate)
  scripts/list-configured-repos.mjs helper used by setup-hooks.*
  .claude/settings.json             Claude Code hook wiring + safe read-only allowlist
  .claude/hooks/*.mjs               session-context, read-guard, map-guardian, edit-check, push-guard, test-runner-guard, ensure-agent-compat
  .claude/agents/{scout,worker,verifier}.md
  .claude/skills/{gate-ritual,orchestrator,new-skill}/SKILL.md
  .codex/config.toml, .codex/hooks.json
  .githooks/pre-push                secret scan + syntax gate on deploy-branch pushes
  .gitattributes                    LF for sh/mjs/git hooks (a CRLF checkout breaks the pre-push hook)
  setup-hooks.sh / setup-hooks.bat  one-time: core.hooksPath for every repo
```

Merge rules when a file already exists in `proje/`:

- `.claude/settings.json`: merge the `hooks` and `permissions.allow` arrays; keep theirs.
- `.claude/agents/*`, `.claude/skills/*`: add ours only if the name is free.
- `docs/*.md`, `scripts/*`: if a same-named file exists, write ours as `<name>.scaffold.<ext>`
  and list it in the report.

Then, if Node is available:

```
cd proje && node --check scripts/*.mjs scripts/lib/*.mjs .claude/hooks/*.mjs
```

---

## 6. Generate the project layer (fill the templates)

Templates live in `core/templates/`. Each contains `{{PLACEHOLDERS}}` and
`<!-- fill: … -->` notes. Write the filled result to the path given below. Everything you
write must be true for *this* project; when you are not sure, write "Unknown as of <date>"
and add a board item.

| Template | Write to | Notes |
|---|---|---|
| `CLAUDE.md.tmpl` | `proje/CLAUDE.md` | The rulebook every agent reads first. Repository shape table, commands per repo, architecture boundaries, working conventions, and a short "Multi-agent working style" section that **links** to `docs/agent-working-rules.md` (do not paste the rules — one canonical home). Keep under ~200 lines. If a `CLAUDE.md` exists, append a `## Agent working structure (scaffold)` section instead. |
| `AGENTS.md.tmpl` | `proje/AGENTS.md` and, in `multi` layout, `<repo>/AGENTS.md` for each repo | About 50 lines of repo-specific facts, never rules; links to `CLAUDE.md` and the memory-bank guide. Real dated traps are worth more than the line budget. Codex reads `CLAUDE.md` as a fallback anyway (configured in `.codex/config.toml`). |
| `GEMINI.md.tmpl` | `proje/GEMINI.md` | Thin delta file: what Gemini must do manually because it has no hooks (pull, run repomap-check before push, read coordination file). |
| `task-board.md.tmpl` | `proje/<board.file>` | Legend, "Who may do what" tags, the compact item template (§9), staleness suppressions section, and the **first items**: every "Unknown as of" you wrote, "confirm scaffold defaults", "run the full gate once and record the baseline", "fill model ids in .codex/config.toml", "install the secret scanner". Use the item code scheme `<MMDD>-<slug>`. Create the empty archive file `<board.archive>` with a one-line header. |
| `coordination.md.tmpl` | `proje/<coordination.file>` | Protocol section verbatim, empty "Active claims" index, "Open messages", "Handed-over work", "Closed". Create `<coordination.archive>` with a header. |
| `reports/README.md`, `specs/README.md` | `proje/<docs.reports>/README.md`, `proje/<docs.specs>/README.md` | Content unchanged (translated when `language` is not `en`); the paths must match the config. |
| `memory-bank/*.md` (8 files) | `proje/<memoryBank.dir>/` (single) or `<repo>/<memoryBank.dir>/` per repo (multi) | **This is the most valuable output.** Fill from the inventory and from reading the code: `repoMap.md` must have a real "if you want to do X, start here" table with ≥ 10 rows; `capabilityRegistry.md` must list the shared helpers/components/services that actually exist; `techContext.md` must have the exact commands; `activeContext.md` gets one dated entry "scaffold installed"; `progress.md` gets the known state. Create `<memoryBank.dir>/archive/.gitkeep`. |
| `memory-bank/reuse-registry.json`, `repomap-guard.json` | next to the memory bank | Registry: start with the 3–5 most-reused shared pieces you found (a date picker, an HTTP client wrapper, a logger, a DB pool, …) so the map-guardian can already stop duplicates. Guard: sensible `ignore` list for this repo (tests, fixtures, generated, vendor, locales, migrations). |

Language: if `language` is not `en`, write the **prose and the section headings** of
every generated document in that language — this applies to all templates alike,
including the memory-bank files and the two READMEs. Only these stay exactly as in the
templates: the headings scripts parse today (`## Staleness suppressions` on the board,
the dated `## YYYY-MM-DD` entry headings in `activeContext.md`/`progress.md`), the
headings reserved for tooling (`## Protocol`, `## Active claims` in the coordination
file), the status emoji, file names, config keys and commands.

---

## 7. Skills

`core/.claude/skills/` ships three skills. Fill their project sections; the text you
fill in follows `language` like every other generated text, while the fixed English
parts of the skill stay as they are:

- `gate-ritual/SKILL.md`: the per-repo gate table (which commands, in which order, which
  env) — from `techContext.md`. Add a dated "Baseline" line once you have run the gates.
- `orchestrator/SKILL.md`: usually unchanged.
- `new-skill/SKILL.md`: unchanged; it is the recipe for writing further skills. The rule
  it enforces: a procedure done three times (twice if the first run hit a trap) becomes a
  skill, written by the agent, tested in a fresh session without naming it.

If discovery found rituals that are clearly recurring (deploy, migration, DB tunnel,
release build, data export), create a skill skeleton for each with the house style
(access note → table → ordered flow → dated pitfalls → baseline → done-when) and mark
the unknown steps as board items rather than guessing them.

---

## 8. Verify

Run what can be run and record the results in the report.

```
cd proje
node scripts/md-size-watch.mjs                       # table, all under ceiling
node scripts/board-staleness.mjs                     # no flags on a fresh board
node scripts/repomap-check.mjs <each repo dir> --all # audits EVERY tracked source file (without --all a never-committed map gives an empty window); gaps mean repoMap.md is incomplete — fix the map, do not silence the check
node scripts/memory-bank-archive.mjs --all           # dry run, nothing to move
sh setup-hooks.sh   (or setup-hooks.bat)             # core.hooksPath set for every repo
grep -rn "{{" . --include=*.md | grep -v node_modules   # must be empty
grep -rn "<!-- fill:" . --include=*.md                  # must be empty
```

Then the project's own cheapest gates from `techContext.md` (lint / type-check / unit
tests that need no external service). Failures that pre-date the scaffold are recorded as
board items, not fixed silently.

If the tool you run in is Claude Code, start a **new session** in `proje/` and confirm the
SessionStart note appears (pull result, size line, checklist). If it does not, the hook
wiring is wrong; fix it before reporting done. A subagent cannot open a new session: run
`node .claude/hooks/session-context.mjs` with a synthetic stdin payload
(`{"session_id":"test","cwd":"<absolute path; on Windows a C:\\ path, not an MSYS /c/ path>"}`)
to prove the script, and list "hook dispatch in a live session" under "only written" so
the human verifies it by opening the project once.

---

## 8b. Questions, round 2 (fill the blanks only the human knows)

Generation and verification leave a short list of things no discovery can answer. Collect
them while you work, then ask them **in one message**, each with a default or a "skip"
option, and write the answers straight into the files. Only what the human skips or
cannot answer becomes a task-board item tagged for the gatekeeper.

Typical round-2 items (ask only those that actually came up):

| Blank | Where the answer goes |
|---|---|
| Model ids for the Codex profiles (cheap / mid / strong) | `.codex/config.toml` |
| Secret scanner not installed: install now, or turn `secretScan.failClosed` off? | `agent-scaffold.config.json`, or nothing if the human installs it |
| A command discovery could not derive (lint, type-check, single test, build) | `agent-scaffold.config.json` `repos[].checks`, `techContext.md`, `gate-ritual` table |
| A deploy script or host referenced but not in the repo (what does it do, who runs it?) | `CLAUDE.md` deploy section, `techContext.md`; never guess credentials |
| Which tests need a live service (so the verifier skips them by name) | `gate-ritual` table |
| Product facts the code does not reveal (who the users are, what "done" means for a release) | `productContext.md`, `projectbrief.md` |
| Existing rituals to turn into skill skeletons (deploy, migration, release) | `.claude/skills/<name>/SKILL.md` |
| Every "Unknown as of <date>" line you wrote in step 6 | the file that holds the line |

Rules for this round:

- One message, numbered, defaults visible. Never more than about ten items; if there are
  more, ask the ten that block the most and leave the rest as board items.
- Apply each answer immediately and re-run the affected step-8 check (config validation,
  `node --check`, the placeholder greps).
- In a non-interactive run this round is skipped entirely; every item becomes a board item
  and the report lists them under "What needs the human now".

---

## 9. Report to the human

One message, in the chosen language, with:

1. **What was generated** — the tree, ten lines max.
2. **What was verified by running it** vs. **what was only written** (two short lists).
3. **What needs the human now** — only what round 2 could not close: the board items
   tagged for the gatekeeper (skipped answers, defaults taken without asking in a
   non-interactive run).
4. **How to work from here** — three sentences: start every session by reading the
   SessionStart note or `CLAUDE.md`; pick work from the task board and claim it in the
   coordination file; delegate reading to the scout, mechanical edits to the worker,
   gates to the verifier.
5. Where to work from now on: `proje/` is the finished project — give the one command to
   move it to its permanent place (or, for an existing repo, to copy the generated files
   into the real clone), and state plainly that every future session is opened **at that
   project's root** (the directory with `agent-scaffold.config.json` and `.claude/`), never
   in a subfolder, because hooks resolve from the directory the agent is opened in.

### Done when

- [ ] `proje/agent-scaffold.config.json` exists, validates, and every repo has a real path.
- [ ] Every file in the step-5 tree exists (or its `.scaffold` twin is listed in the report).
- [ ] `CLAUDE.md`, `AGENTS.md`, board, coordination file, reports/specs READMEs, and a
      complete memory bank per repo exist with no placeholder left.
- [ ] `repoMap.md` has ≥ 10 real entry-point rows; `capabilityRegistry.md` lists real pieces.
- [ ] All step-8 commands ran, or the report says exactly which could not and why.
- [ ] Round-2 questions were asked (interactive run) and every answer landed in a file; the
      board holds only what the human skipped.
- [ ] The discovery report is in `<docs.reports>/` and the board holds every open unknown.

Not done: a tree full of templates with generic prose, "TBD" left in a command column, a
memory bank that restates the README instead of mapping the code.
