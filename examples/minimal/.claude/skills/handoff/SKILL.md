---
name: handoff
description: "Session-closing ritual — save the work (handover note + board + coordination + memory bank), commit, push, then tell the user to /clear. 'handoff', 'wrap up the session', 'save and clear', 'work is done, new session', or when the context watchman note arrives. Use at a stage boundary. Do NOT use mid-edit or with a red test."
---

# Handoff (save → commit → push → /clear)

> **Access requirement:** write access to the coordination file, the task board and the
> memory bank; push rights to the current branch. If a gate blocks the push, do not
> bypass it — record why in the handover note.

**Why:** a long session re-reads its whole context on every call; short sessions are
cheaper, and a short session is only safe if nothing lives only in the chat.

**Done when:** a fresh, empty session can continue from the written record in the repo alone.

## Flow

1. **State it in one sentence:** is the work done or half-done? If a subagent or background command is still running, wait for it; never hand over with a half-finished worker. If you are not at a stage boundary, first reach the nearest one (a committed, consistent state).
2. **Save** (only what changed; a decision left in the chat is a lost decision):
   - Task board item: body **and heading** updated in the same edit, evidence attached, `**Remaining:**` current.
   - Handoff packet: `node scripts/handoff-packet.mjs <board code> --write [--note "<text>"]` writes `<handoff.dir>/<code>.md` from observed facts (item, claim, branch, ahead/behind, dirty files, last commits, `PUSH PENDING`) within `handoff.budgetBytes`, with secret-looking values masked. Commit that file with the rest and point to it from the handover note instead of retyping the state.
   - Coordination file, work DONE: do not write a handover note. Set the claim's State cell to `✅ DONE <date>`, then run `node scripts/coordination-archive.mjs --write` (the row moves to the archive).
   - Coordination file, work HALF-DONE: ONE note per job under `## Handed-over work` (board code in the title, an expiry date a week out). If a note for that code exists, update it in place. At most 8 lines: what was done (%), what remains, what to watch out for, the first command to run next. Detail of what was done goes to the board item; the note only points to it.
   - A handed-over note you took over: when you start the work, turn it into a claim and delete the note (full text to the archive).
   - Memory bank `activeContext.md` / `progress.md` of the touched repo, only entries with lasting value (new file → `repoMap.md`).
   - Durable synthesis → reports directory; unfinished implementation recipe → specs directory.
   - Decisions the user gave this session: record them in the user's own words with the date.
3. **Commit** only YOUR paths. Shared index: `git diff --cached --stat` first, then `git commit -m "<message>" -- <paths>`. Never `git add -A`, `git stash`, `git reset --hard`. In a multi-repo layout, a commit inside a sub-repo needs its pointer bump in the parent repo afterwards. If a busy peer session is editing a shared markdown file, ask it first.
4. **Push:** on a feature branch, push. On the deploy branch a push IS a deploy: only with an existing, explicit go-ahead for this work, through the normal gates (`gate-ritual`). Without it, do not push; the commit stays local and the handover note says `PUSH PENDING: <repo> <branch> <sha>`. Behind the remote: `git pull --ff-only` first, then push in a SEPARATE command. If a gate stops the push, record the reason; do not bypass it.
   After the work is DONE and its claim is archived, `node scripts/handoff-packet.mjs --prune --write` removes packets that no open claim or note owns.
5. **Verify:** `git status --short` shows no uncommitted file of yours.
6. **Close to the user (at most 5 lines):** what is done · what remains · push state · then exactly these two lines:
   - `Type /clear in this window now.`
   - `First message in the new session: "<board code> — <next step>"`

## Pitfalls (dated; keep adding)

- **The agent cannot run `/clear` or `/compact`.** It can only ask the user to.
- **A handover note is not a diary.** Do not list "what I did this session" (git log and the board already hold that). The coordination file is read at every session start; every line added there enters every later session's context.
- **"I'll write the note later" is how it stays in the chat.** If the context watchman fired and the new message is a new job, run this ritual BEFORE the job.
- **Do not hand over mid-edit** (half-applied change, red test): reach the nearest consistent point first.
- **An approval that is pending stays pending.** A handover does not turn "waiting for sign-off" into "approved"; write it as awaiting approval.

## Baseline

<!-- fill: "tested <date>, triggered on '<phrase>'" after the first fresh-session test. -->

## Done when

The board item, the coordination entry and (if code changed) the memory bank are current;
your paths are committed and pushed (or `PUSH PENDING` is recorded); the user got the two
closing lines. Not done: the handover note exists only in the chat, or work is committed
but the claim still says "in progress".
