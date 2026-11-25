# Tool traps

Project-independent traps of the agent tooling. Append a dated row the day a tool bites
you (format: trap, symptom, right way); a trap that no longer applies gets "(closed <date>)".

| Trap | Symptom | Right way |
|---|---|---|
| The shell tool can collapse a double backslash to a single one in the command text, heredoc bodies included | A regex or JS string generated through escapes arrives altered (an escaped `\b` becomes a backspace character, an escaped slash loses its backslash) | Never generate JS/regex through string escapes. Write the block as a literal file with Write/Edit, then splice it in with a script |
| Chaining another repo's `git -C <dir>` into the push command | The push gate may evaluate the wrong repo (the first `-C` in the command) and deny with a bogus "N files not in the map" | Run checks and the commit as separate commands; keep the push command free of `git -C` pointing elsewhere |
| Shared git index | Another session's staged files land in your commit | `git diff --cached --stat` first, then `git commit -m "<message>" -- <paths>`; never `git add -A` |
| Rewriting a shared markdown file with a script | A script that dies halfway truncates the file to 0 bytes | Compute the new content first and check its size, only then open the file for writing; prefer the Edit tool |
| "N passed" taken at face value | The count includes setup steps; a shifted test may never have run | Read test names, see the specific test pass; read the log when the runner is quiet |
| A sub-repo initialized inside a worktree has no `core.hooksPath` | Pushes go out without the gates, silently | Run `sh setup-hooks.sh` in every sub-repo cloned or initialized in a worktree |
| Source-regex tests failing with "not found" after an edit | An editor wrote CRLF line endings; git normalizes on commit so `git status` shows nothing, but a `\n` pattern no longer matches | `git ls-files --eol <file>` (look for `w/crlf`), convert back to LF; `git diff` must stay empty |
| Reverting your own change in a shared checkout with `git checkout -- <path>` / `restore` / `stash` | Silently destroys other sessions' uncommitted work | Undo with Edit; for a baseline run use a temporary `git worktree add --detach` |
