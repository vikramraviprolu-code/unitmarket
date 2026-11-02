# Spec: the recorder stores sandbox API links as paths (B-13 follow-up)

Task: real recordings keep absolute `https://<sandbox API host>/v2/...` links (`self`, `capture`, `refund`), which `pnpm check:no-live-host` refuses outside `packages/transport/src/endpoints.ts`. The older fixtures store those links as paths only.
Package: `packages/transport` (recorder and its test) Owner: coordinator Reviewer: Vikram
Branch: `feat/transport-recorder-api-links` Commit: `fix(transport): recorder stores sandbox API links as paths (B-13)`

Goal: when the recorder scrubs a URL whose host is a sandbox API host (`api.sandbox...` or `api-m.sandbox...`, the same shape `check-no-live-host` treats as the API host), it writes the path and the kept query only, with no scheme or host. Other sandbox hosts (the approval page, the certificate host) stay absolute. Nothing else about redaction changes, and no live or foreign host is ever let through.

Inputs: `packages/transport/src/recorder.ts` (`scrubUrl`), `packages/transport/src/recorder.test.ts`.
Outputs: those two files only. Then the owner re-runs `record:fixtures` on the real run and commits the new fixtures (separate step, separate branch).

Acceptance tests:

- `corepack pnpm exec vitest run packages/transport/src/recorder.test.ts`: the new test fails before the change and passes after. It feeds links on both sandbox API host forms and the approval page host; the output holds `"/v2/checkout/orders/<id>"` as a path, holds neither API host, and keeps the approval page link absolute with its order-id token.
- `corepack pnpm exec vitest run packages/transport scripts/record-fixtures.test.ts` and `corepack pnpm check:no-live-host`, `lint`, `typecheck`, `format:check`, `check:isolation` pass.

Do not: loosen any refusal of a live or foreign host; edit `check-no-live-host.mjs`; touch `fixtures/`; add a dependency.
Evidence: red then green output.
