---
name: gate-ritual
description: "Verification run after a code change — 'run the gates', 'run the tests', 'lint-typecheck-verify' — which commands, in which repo, in which order, with which env; single-run/serial rules and what to do on rate limits or orphan processes. Call BEFORE any deploy or push."
---

# Gate Ritual

> **Access requirement:** none beyond a local checkout and the toolchains in
> `techContext.md`. Gates that need a live external service (a real DB, a provider API)
> are listed separately and skipped with an explicit note when the access is missing.

## Per-repo gate table

<!-- fill: one row per repo from agent-scaffold.config.json / techContext.md. Order = the order to run. Keep commands exact. -->

| Repo | Order | Command | Needs env / service | Typical duration |
|---|---|---|---|---|
| <repo> | 1 | `<lint>` | — | |
| <repo> | 2 | `<type-check>` | — | |
| <repo> | 3 | `<unit / verify suite>` | | |
| <repo> | 4 | `<build>` (only before a deploy) | | |

## Flow

1. Determine which repos changed (`git status` / `git diff --name-only <base>..HEAD` per repo).
2. For each changed repo run the table rows in order, **serially**, one run at a time on the machine.
3. Compare test counts with the baseline below. Markedly lower = something silently shrank the suite (wrong runtime version, missing env, a glob that matched nothing). Investigate before trusting green.
4. Record PASS/FAIL per gate with file:line for failures. Do not fix inside the verifier lane; report.
5. Before a deploy, add the build row and the secret scan (the pre-push hook runs it; running it earlier saves a round trip).

## Run rules and pitfalls (dated; keep adding)

- **One heavy run at a time.** Parallel suites on one machine give false reds from timeouts and port clashes. (Scaffold default; confirm with a measurement in this project.)
- **Never silence a gate to get green.** A safety flag, a skip, or an isolation switch that makes a red pass is forbidden; the fix is in the code or in the test.
- **Orphan processes:** after browser/E2E runs check for leftover test-runner processes before the next run; the `test-runner-guard` hook refuses to start a run when too many are alive.
- **Rate limits:** if a gate hits an external 429 or a tunnel drop, stop repeating it; report, and let the main agent decide.
- **Verify agent may still be running:** before re-running a long suite, check running processes; a second copy of the suite is the usual cause of "flaky" results.
<!-- fill: project-specific traps discovered during the first runs (runtime version, env file location, flags). -->

## Baseline

<!-- fill after the first full run: "<date>: <repo> <N> tests / <F> fail / <S> skip (<runtime version>)". Treat as "be suspicious if markedly lower", not an exact target. -->

## Done when

- Every row of the table for every changed repo ran once, serially, and the result is recorded.
- Counts are at or above baseline, or the difference is explained.
- Skipped gates are named with the reason (missing live service), not omitted.

Not done: "tests probably pass", a run interrupted by a timeout, a green obtained with a skip flag.
