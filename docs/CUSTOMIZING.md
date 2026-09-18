# Customizing

Everything that varies per project is in one of three places. Change it there, not in
the hooks or scripts.

## 1. `agent-scaffold.config.json` (parameters)

| Key | What it controls |
|---|---|
| `language` | Prose language of generated documents (`en`, `tr`, `de`, …). Tooling is unaffected. |
| `layout` | `single` or `multi`. `multi` enables the submodule freshness check at session start and per-repo memory banks. |
| `repos[]` | One entry per repo: `path`, `stack`, `checks` (syntax/typecheck/lint/test/build commands), `editCheck` (glob → command run after every edit; `{file}`, `{repo}` placeholders; `serialize: true` for slow checks such as `tsc`), `deployBranches` (pushing there triggers the confirm gate, the secret scan and the syntax gate), `sourceExtensions` (what the repo-map check considers source). |
| `board`, `coordination` | File names, archive names, line ceilings for the size sentinel. Optional `board.doneSignals` / `board.partialSignals` tune the staleness sentinel for your language. |
| `memoryBank` | Dir name, ceiling, window in days, `pendingPhrases` (an entry containing one of these is never archived — add your language's words). |
| `docs` | Where reports and specs live; paths of the two canonical rule files. |
| `delegation` | Read thresholds for the read-guard; subagent names if you rename them. |
| `session` | `autoPull`, and the skill list shown in the SessionStart note. |
| `testRunner` | Process name to count, worker and process ceilings, the command pattern that triggers the guard. |
| `secretScan` | Scanner binary, fail-closed behaviour, the escape-hatch env var name. |
| `humanGatekeeper`, `labels` | Who may do human-only steps and how the two tags are spelled. |

Validate after editing: `node -e "JSON.parse(require('fs').readFileSync('agent-scaffold.config.json','utf8'))"`.

## 2. Generated documents (facts)

`CLAUDE.md`, `AGENTS.md`, the memory banks, the board, the coordination file. Edit freely;
they are yours. Keep the headings that scripts parse: dated `## YYYY-MM-DD` entries in
`activeContext.md`/`progress.md`, `## Protocol`, `## Active claims`, `## Staleness
suppressions`, and the status emoji on board items.

## 3. Rules (`docs/agent-working-rules.md`, `docs/memory-bank-guide.md`)

Change a rule in its one home and nowhere else. Add project hard rules to section 6 of the
working rules and to the board's "Pinned policies", dated and attributed.

## Renaming the subagents

Rename the files under `.claude/agents/`, the `name:` in their frontmatter, and
`delegation.subagents` in the config. Codex profiles in `.codex/config.toml` are named
independently; keep them aligned by hand.

## Disabling a guard

Remove its entry from `.claude/settings.json` `hooks`. Prefer loosening a parameter
(higher `denyAfterReads`, `failClosed: false`) over removing the hook; each guard exists
because of a measured incident (see `DESIGN.md`).

## Adding a skill

Follow the `new-skill` skill. Add the name to `session.skills` and to the "Rituals" section
of `CLAUDE.md`.

## Updating the package itself

`core/` is meant to be copied, not linked. To pull a newer `core/` into an existing
project: copy `scripts/`, `.claude/hooks/`, `.claude/agents/`, `docs/agent-working-rules.md`
and `docs/memory-bank-guide.md` over the old ones (they carry no project facts), diff
`.claude/settings.json` by hand, and leave everything generated untouched.

## Running the bootstrap again

Re-running `START.md` on a project that already has `agent-scaffold.config.json` is safe:
it loads the config, skips answered questions and only regenerates missing files. Ask it
explicitly to refresh a specific file (typically `repoMap.md` or `capabilityRegistry.md`)
when the code has moved a lot.
