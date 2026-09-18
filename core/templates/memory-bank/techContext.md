# Tech Context

*Belongs here: the technical ground rules — languages, dependencies, commands, environment and
deployment constraints. Does NOT belong here: architecture rationale (see `systemPatterns.md`) or
navigation (see `repoMap.md`).*

---

## Languages, Frameworks, Runtimes

<!-- fill: from manifest files (package.json, pyproject.toml, go.mod, etc.) and lockfiles. -->

## Major Dependencies

<!-- fill: the dependencies that matter for how code is written here (not every transitive dep) —
     name each and the one-line reason it exists in this repo. -->

## Commands (Build / Test / Lint / Dev)

<!-- fill: the actual runnable commands from package.json scripts / Makefile / CI config. Copy them
     verbatim so an agent can run them without guessing flags. -->

## Environment & Runtime Constraints

<!-- fill: required env vars (names only, never values/secrets), supported OS/runtime versions,
     known version traps (e.g. a tool that needs a newer/older runtime than the rest of the repo). -->

## Deployment Assumptions

<!-- fill: how/where this repo is deployed, what triggers a deploy, what environment it runs in
     production. -->

## Codegen / Tooling

<!-- fill: any generated code, schema-driven codegen, or required tooling steps before code is
     usable. -->

## Integration & Testing Stack

<!-- fill: test frameworks/runners in use, how mocks/fixtures are organized, what "the whole
     suite" means in this repo and how long it takes. -->

## Performance / Security / Compliance Constraints

<!-- fill: only if relevant — hard constraints that change how code must be written (e.g. PII
     handling, rate limits, latency budgets). -->
