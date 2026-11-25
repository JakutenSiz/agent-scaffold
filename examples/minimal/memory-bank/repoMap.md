# Repo Map

*Belongs here: fast navigation — directory map, feature-to-file starting points, ownership paths,
and hotspots. This file must stay navigational, not explanatory (architecture rationale belongs in
`systemPatterns.md`). Keeping this current matters: a repo-map push gate can reject new source
files that cannot be found here — see the note at the bottom.*

---

## Top-Level Directory Map

<!-- fill: the top-level directories and, for each, one line on what it contains. -->

## If You Want To Do X, Start Here

<!-- fill: rows for the most common task types in this repo. Keep entries concrete (real paths),
     not abstract. -->

| Task | Entry file(s) | Notes |
|---|---|---|
| <!-- fill: e.g. "add a new API route" --> | <!-- fill: path --> | <!-- fill --> |
| <!-- fill --> | <!-- fill --> | <!-- fill --> |

## Hotspots / Entrypoints

<!-- fill: orchestration files, adapters, shared layers, and other files that many changes pass
     through — the places an agent is likely to end up regardless of which feature they start from. -->

## Ownership Paths

<!-- fill: which directory/module owns which responsibility, especially where ownership is not
     obvious from the name. -->

## Deceptively Indirect Behavior

<!-- fill: places where behavior is not where a newcomer would expect it (e.g. a route registered
     in one file but implemented three files away, a config flag that silently changes flow). -->

## Related Machine-Readable Config

An optional `memory-bank/repomap-guard.json` next to this file can override which directory
segments count as "inventory" (name-required for the repo-map push gate) and add extra ignore
patterns. See `templates/memory-bank/repomap-guard.json` for the schema. Absent that file, the
defaults are the segments `components`, `hooks`, `shared`, `infra`, `screens`, plus any file
directly under a `lib/` directory.
