# Capability Registry

*Belongs here: the reuse map — existing helpers/services/components/utilities, what each does,
where it lives, and when to use it. This exists to stop agents from reinventing something that
already exists. Does NOT belong here: architecture rationale (see `systemPatterns.md`) or
navigation by directory (see `repoMap.md`).*

---

## API Clients / Transport Helpers

<!-- fill: shared HTTP/gRPC/etc. client wrappers — what they wrap, where they live, when to reuse. -->

## State Management Helpers

<!-- fill -->

## Form / Validation Utilities

<!-- fill -->

## DB / Query Helpers

<!-- fill: shared query builders, repository base classes, connection/pool helpers. -->

## Logging / Error Utilities

<!-- fill: shared logger, error classes/dictionary, error-response envelope helpers. -->

## Auth / Session Helpers

<!-- fill -->

## Shared UI Primitives

<!-- fill: only if this repo has a UI layer — shared components/design-system pieces. -->

## Background Job Helpers

<!-- fill: shared worker/queue/scheduler/lock helpers. -->

## AI / Tooling Wrappers

<!-- fill: only if relevant — shared wrappers around AI providers or dev tooling. -->

## Test Factories / Mocks / Fixtures

<!-- fill: shared test data builders, mock servers, fixture files, and where new tests should
     plug into them instead of inventing new fixtures. -->

## Related Machine-Readable Config

An optional `memory-bank/reuse-registry.json` next to this file lists canonical pieces with
trigger phrases; the `map-guardian` pre-edit hook uses it to reject an edit that looks like it is
reimplementing a registered capability instead of importing/extending the canonical one. See
`templates/memory-bank/reuse-registry.json` for the schema. Keep the two in sync: an entry added
to the registry should also get a line in the relevant section above, and vice versa.
