# Customizing

Everything that varies per project is in one of three places. Change it there, not in
the hooks or scripts.

## 1. `agent-scaffold.config.json` (parameters)

| Key | What it controls |
|---|---|
| `language` | Prose language of generated documents (`en`, `tr`, `de`, …). Tooling is unaffected. |
| `layout` | `single` or `multi`. `multi` enables the submodule freshness check at session start and per-repo memory banks. |
| `repos[]` | One entry per repo: `path`, `stack`, `checks` (syntax/typecheck/lint/test/build commands), `editCheck` (glob → command run after every edit; `{file}`, `{repo}` placeholders; `serialize: true` for slow checks such as `tsc`), `deployBranches` (pushing there triggers the confirm gate, the secret scan and the syntax gate), `sourceExtensions` (what the repo-map check considers source). |
| `board` | File and archive names; ceilings for the size sentinel (`ceiling` lines, `ceilingBytes`, `maxLineChars`); `fields` (names of the item template's fields — translate them here for a non-English board); `doneSignals` / `partialSignals` (words the staleness sentinel and the lint treat as "finished" / "still open" — add your language's); `lint.mode` (`warn` or `block` at commit); `humanStepExpiryWeeks`. |
| `coordination` | File and archive names, ceilings, `staleClaimDays` (a claim older than this is reported at session start). |
| `memoryBank` | Dir name, ceilings, window in days, `pendingPhrases` (an entry containing one of these is never archived — add your language's words), `mapBudgetBytes` (how much of the repo map the map-guardian injects on a first edit). |
| `docs` | Where reports and specs live; paths of the canonical rule files, the memory-bank schema and the tool-traps file. |
| `delegation` | Read thresholds for the read-guard, `countShell` (count `cat`/`grep` through the shell as reads), `warnAfterEdits` / `denyAfterEdits` (0 = never deny), subagent names if you rename them. |
| `session` | `autoPull` (root), `autoPullRepos` (fast-forward a lagging repo when its tree is clean and it is on its deploy or default branch), `ensureHooksPath`, `staleDocHours`, the skill list shown in the SessionStart note, `lines` (see below), `context` (thresholds of the context watch, the hand-over skill's name). |
| `git` | `protectedBranches` (never cleaned up, never deletable by push); `shield.escapeEnv` and `shield.forbiddenCommands` (extra denied shell commands, see below); `hygiene` (age thresholds, `autoClean`, the ignore file). |
| `preCommit` | `checks`: your own commit-time checks (see below). |
| `pushGate` | `maxBlobMB` and `bigBlobMode` (`warn` or `block`) for new large files, the escape variable's name, `requireHooksPath`. |
| `testRunner`, `orphans` | Process name to count, worker and process ceilings, the command pattern that triggers the guard; what counts as a hung test process. |
| `codex` | `riskyPatterns`: extra command patterns for which the Codex adapter fails closed. |
| `secretScan` | Scanner binary, fail-closed behaviour, the escape-hatch env var name. |
| `humanGatekeeper`, `humans`, `labels` | Who approves gated steps, one tag per human who instructs agents (the `Human step` field and the human queue use them), and how the two authorization tags are spelled. |

Validate after editing: `node -e "JSON.parse(require('fs').readFileSync('agent-scaffold.config.json','utf8'))"`.

## 2. Generated documents (facts)

`CLAUDE.md`, `AGENTS.md`, the memory banks, the board, the coordination file. Edit freely;
they are yours. Keep the headings that scripts parse: dated `## YYYY-MM-DD` entries in
`activeContext.md`/`progress.md`, `## Protocol`, `## Active claims`, `## Staleness
suppressions`, and the status emoji on board items.

## 3. Rules (`docs/agent-working-rules.md`, `docs/memory-bank-guide.md`)

Change a rule in its one home and nowhere else. Add project hard rules to section 6 of the
working rules and to the board's "Pinned policies", dated and attributed.

## Adding a session-start line

`session.lines` is a list of `{ "id", "command", "timeoutMs"? }`. Each command runs at
the project root when a session starts; the first non-empty line it prints appears in
the note as it is, so the line should start with its own label (`git hygiene: …`); `id`
only names the entry. The contract is: **one line or nothing**; the exit code is
ignored, a missing script or a timeout is skipped silently, and all lines share a time
budget (`session.linesBudgetMs`). A sentinel that has nothing to report prints nothing.
To add your own (pending migrations, an expiring certificate, a stale dry-run flag),
write a script with a `--line` mode and add an entry. The array in your config replaces
the default list as a whole, so copy the defaults from the example config first.

## Adding a commit-time check

Board lint and the coordination check are built in. Your own go into `preCommit.checks`:

```json
{ "id": "migrations", "command": "node scripts/migration-lint.mjs {files}", "whenStaged": ["db/migrations/*.sql"] }
```

The command runs only when a staged file matches one of the globs, and a non-zero exit
stops the commit. Keep these checks cheap; anything slow belongs in the gates before a
push. Each check can be skipped once with `PRE_COMMIT_SKIP_<ID>=1`.

## Denying a dangerous command

`git.shield.forbiddenCommands` takes `{ "pattern": "<regex>", "reason": "<why>" }`
entries. Use it for the project's own foot-guns: a test flag that gives false greens on
the whole tree, a script that spends real money, a command that must only ever run on
one machine. The reason is shown to the agent, so make it say what to do instead.

## Raising a gate from warning to block

The lint and the large-file check ship as `warn`, the branch cleaner as report-only.
Watch the warnings for a week or two; fix or suppress the false positives; then set
`board.lint.mode: "block"`, `pushGate.bigBlobMode: "block"`,
`git.hygiene.autoClean: true`. Every escape variable is in the one table at the end of
`docs/agent-working-rules.md` — when you add a gate, add its escape there.

## Adding a rule

Write it in its one home with a new id (`[R-nn]`, or your own series such as `[P-01]`
for project rules) and decide at the same time what enforces it. If a hook or script
does, put `// Enforces: P-01` in that file's header. `node scripts/rule-inventory.mjs`
shows the result; `--strict` fails when code cites an id no document defines.

## More than one human

`humans` lists the tags; `CLAUDE.md` § Decision authority says what each person decides
alone and what needs the gatekeeper's approval first; `docs/agent-working-rules.md` §7 is
the procedure agents follow. The scaffold does not verify who is typing. If approvals
can come from a shared machine, add a mechanism for that (a prompt hook that checks a
secret against a stored hash is one way) — a sentence in the chat is not identity.

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
project: copy `scripts/`, `.claude/hooks/`, `.claude/agents/`, `.githooks/`,
`setup-hooks.*`, `docs/memory-bank-guide.md` (+ appendix and schema) and
`docs/tool-traps.md` over the old ones (they carry no project facts), diff
`.claude/settings.json` and `.codex/hooks.json` by hand, and leave everything generated
untouched. `docs/agent-working-rules.md` carries one project section (§8, the guard-rails
the human has set): copy that section across before replacing the file. Skills that the
bootstrap filled in (`gate-ritual`) are merged by hand; new ones (`handoff`) are copied.

From v0.1 to v0.2 there are four things to do by hand as well:

1. Config: set `"version": 2` and add the new keys you want to change from the example
   (`humans`, `board.fields`, `session.lines`, `git`, `preCommit`, `pushGate`). Missing
   keys fall back to the defaults, so this can be done gradually.
2. Coordination file: claims are now single rows of the `## Active claims` table with
   the columns `Session | Item code | Since | State`, closed by writing `✅ DONE <date>`
   into the State cell. Replace the `## Protocol` section with the one from the new
   template, convert open claim blocks to rows, and move closed blocks to the archive.
3. Task board: add the `**Human step:**` line to the item template in §9 and to the
   open items whose next step is a human's.
4. Run `sh setup-hooks.sh` again (it now also makes the hooks executable and there is a
   new pre-commit hook), then `node scripts/rule-inventory.mjs --strict` and
   `node scripts/memory-bank-check.mjs`. If your memory-bank headings are not the
   template's, adjust `docs/memory-bank-schema.json`.

## Running the bootstrap again

Re-running `START.md` on a project that already has `agent-scaffold.config.json` is safe:
it loads the config, skips answered questions and only regenerates missing files. Ask it
explicitly to refresh a specific file (typically `repoMap.md` or `capabilityRegistry.md`)
when the code has moved a lot.
