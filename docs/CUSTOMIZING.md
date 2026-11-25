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

```
node bin/agent-scaffold.mjs upgrade <project-dir> --dry-run   # what would change
node bin/agent-scaffold.mjs upgrade <project-dir>
node bin/agent-scaffold.mjs doctor  <project-dir>
```

`upgrade` refreshes the engine files from the newer package and records the result in
`.agent-scaffold/manifest.json`. A file you changed by hand is never overwritten: the new
version is written next to it as `<file>.new`. Reconcile each one (take what you want
from the `.new` file, keep your edits), delete the `.new` file, and `doctor` stops
warning about it. Seed files (the generated documents) and your config are not touched.

`upgrade` does not wire anything: it neither creates the `.agents/skills` and
`.codex/hooks` links nor sets `core.hooksPath`. `install` does both; after a new clone,
run `git config core.hooksPath .githooks` (or `sh setup-hooks.sh`). `doctor` reports a
missing wiring as FAIL (empty `core.hooksPath`, non-executable hook files, broken
links), so run it after every upgrade.

A project installed before the CLI existed (v0.1, or v0.2 copied by hand) has no
manifest: run `install` into it once. It never overwrites an existing file, so every
difference comes out as a `.new` to reconcile. The v0.1 to v0.2 changes that still need a
human decision are the config keys (`"version": 2`, `humans`, `board.fields`,
`session.lines`, `git`, `preCommit`, `pushGate`), the coordination file's claim-row
table (`Session | Item code | Since | State`) and the `**Human step:**` line in the board
template.

## Profiles

`"profile": "minimal" | "standard" | "strict"` sets the thresholds and gate modes that
are not written in your config. `standard` is the built-in default; a value you write in
`agent-scaffold.config.json` always wins over the profile.

| Setting | minimal | standard | strict |
|---|---|---|---|
| `board.lint.mode` | off | warn | block |
| `coordination.checkMode` | warn | block | block |
| `delegation` reads warn / deny | 8 / never | 5 / 10 | 3 / 6 |
| `delegation` edits warn / deny | 30 / never | 15 / never | 10 / 25 |
| `session.context.warnTokens` | 600000 | 300000 | 200000 |
| `pushGate` large file (MB / mode) | 10 / warn | 2 / warn | 1 / block |
| `pushGate.requireHooksPath`, `mapGate`, `confirm` | off, off, off | on, block, ask | on, block, ask |
| `memoryBank.reuseGate` | off | block | block |
| `git.hygiene.worktreeDebtAsk` | 20 | 5 | 2 |
| `testRunner.maxWorkers` | 4 | 2 | 1 |
| `doneGate.mode` | off | block | block |

Fixed in every profile: the destructive-git denial, the subagent-recursion denial,
`secretScan.failClosed` and `secrets.mode`. Start with `minimal` if the team is new to
agent guard-rails, move to `standard` after a week of reading the warnings, and use
`strict` for a repository where a bad push is expensive. `doneGate.mode` only matters once
`doneGate.command` is set.

## Secret shield

`secrets` configures the `secret-shield` hook: `mode` (`block` | `warn` | `off`),
`protectedPaths` (globs; one without `/` matches the base name) and `allow` (globs
subtracted from the protected list). Both lists replace the defaults as a whole, so copy
the example first. The hook is accident-level: it matches file names, resolves `..` and
symlinks, and looks through shell forms such as redirections, `bash -c` bodies, `$(...)`
and `git show <ref>:<path>`. It does not stop a determined agent. Known gaps are
interpreter bodies (`python -c`, `node -e`), paths built from variables, directory-level
access (`grep -r`, `tar`, `find`), `printenv`, wildcards in a directory component, and
Codex sessions (only its shell tool is bridged). It fails open on any internal error and
has no escape prefix: relaxing it is your edit of this block. For real protection use
the push-time secret scan and keep secrets out of the checkout.

## Done gate

Closing a board item should mean the gate ran green on the code. Set `doneGate.command`
(for example `npm test`); empty means the gate does not exist. The flow is: stage or
commit the code, run `node scripts/gate-record.mjs` (it runs the command once and records
the result for exactly this code state), flip the item to done, commit. At commit time
`done-gate --staged` checks that a matching record exists; it never runs the command
itself. The code state is a hash of the staged content with the exempt paths removed
(board, coordination, memory bank, reports, specs, handoff dir and
`doneGate.exempt`), so a board-only commit does not stale the record, while a code
change after the record does. `gate-record` refuses to run on a working tree that
differs from the index. `timeoutSec` limits the run (a timeout is a red record).
Escape: `PRE_COMMIT_SKIP_DONE_GATE=1`, with the reason in the commit message.

## Equivalent-merge detection

`git.hygiene.equivalentMerge` is `off` (default) or `cherry`. By default a branch counts
as merged only when it is an ancestor of the default or a deploy branch. `cherry` also
recognises branches whose content arrived by squash merge or cherry-pick, so the session
note stops listing them as unmerged. Limits: a squash that was reverted later still
reads as merged (the deleted tip stays recoverable from the cleanup journal), and a
target that changed a neighbouring line before the merge hides the match (a safe false
negative).

## Handoff packet

`handoff.dir` (default `handoffs`) and `handoff.budgetBytes` (default 8192) configure
`node scripts/handoff-packet.mjs <item-code> --write`. The packet is built from observed
facts (board item, claim row, per-repo branch, ahead/behind, dirty files, last commits,
`PUSH PENDING`, worktrees) and is cut from the end when it exceeds the budget, with each
cut announced. Token-like values (JWTs, long hex and base64 runs) become `[REDACTED]`.
`--prune` lists packets that no open claim or note owns; `--prune --write` deletes them.

## Board signal words

`board.doneSignals` and `board.partialSignals` are not in the built-in DEFAULTS of the
config; when you leave them out, a fallback list in `scripts/lib/board-format.mjs` is
used. Set them yourself when your board is written in another language.

## Running the bootstrap again

Re-running `START.md` on a project that already has `agent-scaffold.config.json` is safe:
it loads the config, skips answered questions and only regenerates missing files. Ask it
explicitly to refresh a specific file (typically `repoMap.md` or `capabilityRegistry.md`)
when the code has moved a lot.
