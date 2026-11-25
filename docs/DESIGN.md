# Design — why each mechanism exists

This package was distilled from a multi-repo product that was developed with AI agents
for most of a year. Every mechanism below earned its place by a measured failure; the
lessons are stated without the product's names. If you drop a mechanism, drop it knowing
what it was protecting against.

## The two layers

**Fixed layer** (`core/`): process that does not depend on the project. **Generated
layer** (`core/templates/`, filled by the agent): everything that does. The split is what
makes the package generic: a new project changes the facts, not the rules. The single
config file `agent-scaffold.config.json` is the bridge — hooks and scripts read it, so
none of them hardcodes a repo name, a branch or a ceiling.

## One rule, one home

Four repos once carried byte-identical 560-line copies of the memory-bank guide. They
drifted apart on their own within weeks; nothing read three of them. The rule now: shared
rules live in exactly one file (`docs/agent-working-rules.md`, `docs/memory-bank-guide.md`,
board §9, coordination `## Protocol`) and every other file links there. `AGENTS.md` per
repo is capped at ~40 lines of repo-specific facts for the same reason.

## Delegation-first and the single-level agent tree

A main-model exploration of 130k tokens comes back from a cheap scout as a 1.5k summary.
The expensive model is kept for decisions; workers on cheaper models do reading, mechanical
edits and gate runs. The `read-guard` hook enforces it: past N reads in a turn the main
session is denied further reads until it delegates. The first version counted only the
file-reading tools, and a later measurement found the main session had done 2,292 reads
through the shell (`cat`, `grep`, `sed -n`) — the counter was blind to all of them. Shell
reads are now classified and counted, and a long run of edits by the main session is
counted the same way. `delegation-share.mjs` measures the outcome from the transcripts:
what share of the tool calls the main session still makes itself.

There are four roles, not three. `scout` answers "where is X"; it is cheap and shallow by
design. Decisions kept being made on scout summaries that located code without
understanding it, so `analyst` was added: read-only, mid model at high effort, for "how
does this flow work end to end, why does it break, what breaks if I change it". Its
output is a decision summary anchored as `file:line`.

Every worker report ends with a `Better path:` line. Workers apply a brief faithfully,
including a wrongly framed one; the line is the one place where a worker is asked to
step outside the framing. The architect adopts it or records why not, and a rejected
idea carries `Reopen if: <condition>` — a rejection is evidence, not a lock.

The tree is single-level because unrestricted workers were observed recursing and looping:
a worker spawned workers that spawned workers. Now a subagent that finds its job too big
stops and reports; the split is the architect's decision. The hook denies subagent → subagent
spawns as a second line of defense behind the agent definitions.

## Memory bank per repo

Agents forget between sessions; humans forget between weeks. The memory bank is the
repo's operational map, and its two most valuable files are `repoMap.md` ("if you want to
do X, start here") and `capabilityRegistry.md` (what already exists). Three date pickers
were written in seven months because nothing enforced reuse; `reuse-registry.json` plus the
`map-guardian` hook now reject a new implementation of a registered piece. The same hook
injects the repo map on the first edit in a repo, so an agent cannot claim it did not see it.

`repoMap.md` is kept honest by the push gate: a new source file that cannot be found in
the map blocks the push (`repomap-check.mjs`).

## Sliding window, never delete

`activeContext.md`/`progress.md` are not session diaries. Entries older than the window
with no pending marker move **verbatim** to `memory-bank/archive/`. The board and the
coordination file follow the same rule with their `-archive.md` twins. The size sentinel
(`md-size-watch.mjs`) warns, never blocks, because a block on a size limit produces
deletions; a warning produces archiving. The coordination file once reached 7,600 lines
because "archive on close" was written as a rule but not surfaced at session start; the
SessionStart hook now prints the warning line every session. The sentinel counts bytes
and the longest line as well as lines: a board once grew to 1 MB with a single
68,000-character line while its line count looked healthy.

The memory-bank guide itself went on the same diet. It was 600 lines, read in full by
every agent told to "read the guide first". The rules now fit in about 90 lines with a
"what to read for which task" table; the per-file detail is an appendix read only when a
memory bank is first set up, and the required headings are a JSON schema checked by
`memory-bank-check.mjs` instead of prose. The `map-guardian` hook follows the same idea:
it used to inject the whole repo map on the first edit (43 KB in one repo); it now
injects the sections that match the edited file within a byte budget.

## Task board mechanics

One canonical list; derived views are forbidden because a hand-maintained second file was
always the stale one. The compact item template forces evidence to be **replaced**, not
appended, and the heading to change in the same edit as the body — the most common rot was
a 🔴 heading over a body that said "shipped". Item codes are `<MMDD>-<slug>` because two
concurrent sessions kept picking the same sequential number. Every open item carries an
authorization tag (`[DEV]`/`[ANY]` by default) so an agent knows whether it may finish the
item alone or must hand the last step to the human. The staleness sentinel
(`board-staleness.mjs`) flags items whose body sounds done while the heading says open.

## Coordination file and claims

Several sessions (and several tools) work on the same checkout. Claims prevent duplicate
work. A claim is **one table row** and nothing else. Earlier versions kept a claim block
plus an index row, which produced eighteen dead rows; the next version had three
different descriptions of how to close a claim, and a count found seven of ten rows
marked done but never moved. Closing is now a single cell (`✅ DONE <date>`), the move to
the archive is a script (`coordination-archive.mjs`), and the commit gate stops a done
row that was not moved. Claims age: an "active" claim from a session that no longer
exists locked two large items for days. The protocol therefore says: check the owner is
alive before treating a claim as real, but look at the commits first — a session id can
change without the work being abandoned. Live tool-to-tool messages are allowed for
time-critical questions but leave no record, so the outcome is written to the file
immediately.

## Advice does not hold

The most important lesson since the first version. "Archive the claim when you close
it", "delete your branch and worktree when the work is merged", "update the heading with
the body" were all written rules, and a one-week count found 17 merged worktrees (11 GB),
34 merged branches and 7 done-claims left behind anyway. An instruction that depends on
an agent remembering something at the end of a long session is advice, and advice of
that shape does not hold — not for agents and not for people.

So every post-condition that matters became a script at a deterministic moment:
`git-hygiene-watch`/`-clean` at session start, `board-lint` and the coordination check
at commit, the large-file check at push. Each started as a warning and became a block
only after its false positives were fixed; `board.lint.mode` and `pushGate.bigBlobMode`
ship as `warn` for that reason. All escapes are listed in one table in the working rules
so that "how do I get past this" has one answer.

Rules carry ids (`[R-24]`) and the code that enforces a rule names the id in its header.
`rule-inventory.mjs` prints the split between enforced rules and advice. It cannot prove
that a rule is really enforced — a cited id is a pointer — but it makes it impossible to
add a rule without seeing which column it lands in.

The session-start note is assembled the same way: `session.lines` in the config is a
list of commands that each print one line or nothing. A new sentinel is a config entry,
not an edit to the hook.

## Shared checkout

Two incidents a few days apart: a `git reset --hard` dropped a commit (recovered from
the object store), and a `pull --rebase` followed by `reset --hard` deleted seven
uncommitted files that a worker in the same checkout was still editing. `git stash`,
`reset --hard`, `checkout -- <path>`, `restore`, `clean -f` and `--autostash` all share
one property: they silently discard work that may not be yours. The `git-shield` hook
denies them for the main session and for subagents alike; a baseline run goes into a
temporary detached worktree instead. The index is shared as well — another session's
staged file rides along in your commit unless you commit by path — which is a rule in
the working rules and a row in `tool-traps.md` rather than a hook, on purpose: there is
no cheap way to tell whose staged file it is.

The shield has a documented gap: a destructive command wrapped in a quoted `bash -c "…"`
is not seen. It stops the mistake, not the adversary.

## Human steps and decision authority

An item whose last step only a human can take used to say so somewhere in its prose,
and those items rotted: nobody could see their own queue. The item template now has a
`Human step` field with the person's tag, `human-queue.mjs` prints one queue per person
at session start, and a step older than a few weeks is flagged so that it is either done
or dropped with a reason.

The authorization tag on an item says who can *do* the work. Who *decides* is a
different question, and it only showed up once a second person started instructing
agents: an inventory found about a hundred decisions taken in one person's sessions that
belonged to the other, none of them ever stopped by an agent. The usual shape was: the
agent proposes, the human in front of it accepts without reading. The working rules now
carry a short procedure (say it plainly, do not ask the wrong person, research and local
code are fine, a note after the fact is not approval) and `CLAUDE.md` holds the
project's two lists. The lists were narrowed again after too many harmless additive
changes queued up for approval: new and additive things are free, changing what running
users depend on is not. With one human this section collapses to a single line, which is
why the bootstrap asks.

## Short sessions

One week's measurement: 62% of the quota was the main session re-reading a context of
about 390k tokens on every call. A long session is not free memory; it is a tax on every
message. The `context-watch` hook reads the transcript's usage figures and, past a
threshold or after an idle hour, tells the agent to run the `handoff` skill at the next
stage boundary: evidence into the board, a hand-over note, commit, push, and then the
user clears the session. The rule that makes this safe is that ownership belongs to the
work item, not to the session — anything that lives only in the chat is lost by design.

## Guards on the way to production

- **Behind-push gate**: pushing a branch that is behind its remote produced silent
  overwrites in a shared checkout. Now denied.
- **Deploy-branch confirm**: pushing to a deploy branch *is* the deploy; the hook asks.
- **Secret scan, fail-closed**: a private key once reached a rented machine through an
  env file. The pre-push hook runs a scanner on the pushed range and refuses to run when
  the scanner is missing, because "scanner not installed" was the root cause of one leak.
  The escape hatch is an env var that is logged loudly; using it to push red is forbidden
  by the rules, not by code.
- **Edit-check**: a syntax or type error found seconds after the edit costs nothing; found
  at deploy it costs a rollback. The hook runs the cheapest correct check for the file type.
- **Test-runner guard**: parallel browser test runs on one machine gave false reds and
  left orphan headless processes; the hook caps workers and refuses to start when too many
  are alive. `orphan-process.mjs` covers the other half: a hung test-runner parent was
  found holding 13 GB; the script lists such processes at session start and kills them
  only when asked.
- **Checked commit, not checked tree**: the gates used to check the files in the working
  directory. A dirty tree made that a statement about something other than the pushed
  commit. The syntax gate now reads the pushed content, and tree-wide results count only
  when HEAD is the pushed commit and the tree is clean.
- **Hook environment**: git runs hooks with `GIT_DIR` and `GIT_INDEX_FILE` set. A
  pre-push hook once ran a test suite that inherited them; the suite's fixture repos
  committed into the real repository and over a hundred fixture commits reached the
  default branch. Every command a hook starts now runs with those variables removed.
- **Hooks path**: a fresh clone, and a sub-repo initialized inside a worktree, have no
  `core.hooksPath`, so the tool-independent gates silently do not exist there. The
  session start sets it, and the push guard refuses a deploy push without it.
- **Large new files**: a few accidental binaries bloat a repository for good. New blobs
  above a threshold are flagged at push.
- **Deploy lock**: two sessions pushing the same deploy branch at once raced; the second
  push is refused while the first is still running.
- **Commit gate**: cheap by construction — it starts nothing unless a file it cares about
  is staged.

## Gates: once, serial, complete, honest

The first version said "run the gates after every change". With several workers on one
job that meant the full suite ran per part, and each run was invalidated by the next
part. Now a worker runs only the narrow acceptance check named in its spec and fixes its
own red while its context is warm; the full suite runs once, on the combined tree,
before the push. A regression test for a bug fix counts as evidence only after it has
been seen red on the pre-fix code — a test written after the fix that has never failed
proves nothing about the bug.


Suites run one at a time because a loaded machine gives false reds. All offline tests run;
only what needs a live external service is skipped, and the skip is named. Counts are
compared with a dated baseline because a wrong runtime version or a missing env once
silently shrank a suite to a fraction and everything was "green". A green obtained with a
skip or isolation flag is forbidden.

## Skills as shared procedure memory

Seven recurring recipes were found living only in one agent's private memory — invisible
to other tools, workers and machines. The rule: three runs (two if the first hit a trap)
and the **agent** writes the skill, then tests it in a fresh session without naming it. The
house style (access note → table → ordered flow → dated pitfalls → baseline → done-when)
exists so every skill reads the same way.

## Reports and specs

Research syntheses go to `reports/` so the next session searches before exploring. Specs
are how the architect hands work to a worker: the worker applies a wrong instruction as
faithfully as a right one, so uncertain points are marked "your call" instead of guessed.
Commit authority is stated in every brief because a worker that was not told either way
left dirty trees behind.

## Multi-tool parity

One canonical hook and skill source (`.claude/`) is linked into `.codex/` and `.agents/`
by `ensure-agent-compat`, Codex profiles mirror the roles, and Gemini gets a thin
delta file listing what it must do by hand because it has no hooks. The pre-push git hook
is tool-independent so the secret scan never depends on which agent pushed. For a long
time Codex sessions ran with none of the shields, because its hook file only wired the
session start. `codex-guard-adapter` now forwards a Codex shell command to the same
PreToolUse hooks Claude Code runs and turns every "ask" into a "deny" (Codex has no ask).
It only works once the machine has trusted the project hooks, and has to be re-trusted
after a hook changes — until then the written rule is the only protection.

## What was deliberately left out

Product policies, server names, ports, credentials, branch names and named people. They
are parameters (config) or generated content (templates), never part of `core/`.

Also left out, deliberately, although the source project has them: an identity check
that lets one person approve from another person's machine (a password hash in a prompt
hook — specific to one threat model), content shields for one product's dangerous calls
(`git.shield.forbiddenCommands` is the generic slot), quota accounting with price
weights, and a stage-and-lane status board for many parallel sessions. Add them when you
have the problem they solve.
