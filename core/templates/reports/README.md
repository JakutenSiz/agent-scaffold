# Reports — durable discovery and research archive

Valuable discovery and research output that agents collect is saved here as dated
markdown so the same context is never gathered twice from scratch. The next session (or
another agent) **searches here first**, then in `_archive/`.

## Rules

- File name: `YYYYMMDD-<topic>.md` (e.g. `20260918-scaffold-discovery.md`).
- Content: a SYNTHESIS that supports a decision — not a raw file dump. Give source
  file/line references so the report can be re-verified once it ages.
- What does NOT go here: a repo's permanent facts (those go to its `memory-bank/`),
  day-to-day agent messages (coordination file), task status (task board).
- A stale report may be deleted or moved to `_archive/` — this is an archive, not holy ground.
- Implementation recipes go to `{{SPECS_DIR}}/`, not here.
- Reports of closed items move to `_archive/` (git history is kept).
