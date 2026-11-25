# Agent Coordination — minimal-example

> **Last writer:** <session or agent name> — <date>
> This file carries only OPEN work: active claims, unread messages, handed-over work.
> A claim is ONE row in the `## Active claims` table. Closing it = writing `✅ DONE <date>` at
> the start of that row's State cell; `scripts/coordination-archive.mjs --write` then moves the
> row to `coordination-archive.md` (the commit gate stops a commit that still carries a closed
> row). The archive is not read at session start. Size sentinel ceiling: 1200 lines.
> The section titles and the table header below are parsed by scripts: do not rename them.

## Protocol

1. **Claim before you start.** Add ONE row to `## Active claims`: `| <session> | <item code> | <date> | <state> |`. The item code (`<MMDD>-<slug>`) comes from `task-board.md`; if the work has no board item, add one there first (code scheme: board §9). Evidence of finished work goes to the **board item**, not here — this file is only for messages and claims between agents.
2. **Refresh long claims.** A claim freezes the state at the moment it was written; days later it looks abandoned. Write `refreshed <date>` into the State cell and point to the board item for the current state. Do not copy details here.
3. **Claims age; check the owner is alive.** A claim whose session no longer exists is ownerless: if your tool lists live sessions, check the list; otherwise look at the last commits of that work first — the session id may simply have changed. Never declare a session dead without looking. Refresh your own claim if your session id changes.
4. **A claim that waits on an external step stays.** Removing it invites duplicate work. Ownerless work moves to `## Handed-over work`.
5. **Messages.** A note for another agent goes as a dated bullet under `## Open messages`, with `[expires: YYYY-MM-DD]` when it goes stale on its own. The reader deletes it or marks it `✔ read` once acted on. Update the "Last writer" line every time you write.
6. **Closing.** When the item is done: write `✅ DONE <date>` at the start of your row's State cell, put the evidence into the board item, then run `node scripts/coordination-archive.mjs --write`. The script moves the row (and any closed or expired note) to `coordination-archive.md`; the commit gate stops a commit that still holds a closed row. Do not move rows by hand. Lessons that are permanent go to the repo's `memory-bank/`, not to the archive.
7. **Before starting: pull and check who is behind.** `git pull --ff-only` in the root (the SessionStart hook attempts this and reports it; without hooks, do it by hand).  If the tree is dirty or another agent holds a claim on it, coordinate first; never pull blind.
8. **Live messages** (only between sessions of the same tool on the same machine, if the tool supports it): use them for time-critical questions — "anything in flight?" before a deploy or worker restart, same-file intent, claim clash. They leave NO record: write the outcome here immediately. Other tools and machines never see them.
9. **Hand-over.** Leaving work half-done: move your row's content to `## Handed-over work` with what is done (rough %), what remains, and what the next agent must watch for. Half-done work is never ownerless.
10. **Shared-file rule.** Before committing this file, the board or the memory bank, ask any live peer session working in the same file. Commit only your own paths (`git commit -- <paths>`): the index is shared, so a file another session staged would ride along in your commit — run `git diff --cached --stat` first.

## Active claims

| Session | Item code | Since | State |
|---|---|---|---|

## Open messages

<!-- dated bullets, newest first; optional [expires: YYYY-MM-DD] -->

## Handed-over work

<!-- what is done (%), what remains, watch-outs; one `###` per item -->
