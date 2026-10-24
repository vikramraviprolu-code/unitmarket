# BU-6b: owner-run call log redaction of merchant id and approval token

Task: make `calls.json` from `pnpm sandbox:conformance` safe to share, by masking merchant ids and the approval-link token.
Package: `packages/testkit` (plus one line in `scripts/lib/`, one paragraph in `docs/owner/`) Owner: Sonnet 5.5 builder Reviewer: Sakthi (Opus verifies)
Branch: `fix/owner-run-redact-ids` Commit: `type(testkit): <what> (BU-6b)`

Goal: the first real sandbox run (2026-10-24) wrote `calls.json` with `purchase_units[].payee.merchant_id` and the `?token=` value of the approval `links[].href` in full. After this lane, the call log keeps no merchant id except its last 4 characters, no `token=` value, no Authorization value and no personal field. The payee echo check (B-01 / D-028) is untouched: it compares the live in-memory read (`readOrder`) before anything is logged, never the written file.

Rules of the redactor `redactCallBody(value, ownMerchantId)` (exported from `sandbox-subject.ts`; the subject calls it for every request and response body):

- Key `merchant_id` or `payee_merchant_id` at any depth: a string of 8 or more characters becomes `MERCHANT-REDACTED-<last 4>`; a shorter string becomes `MERCHANT-REDACTED`; a non-string, non-null value becomes `[redacted]`. A string already masked stays as it is (idempotent).
- A string equal to our own merchant id, anywhere, still becomes `OWNMERCHANT01` (pinned by an existing test).
- Key `payee_id` and `payer_id`, `account_id`, any key containing `email`, `phone`, `national_number`, the name keys (`given_name`, `surname`, `full_name`, ...), `address*`, `admin_area`, `postal_code`, `street`, `note_to_*`, and a `name` object: `[redacted]` (existing, plus `payee_id`).
- Keys matching the secret pattern (token, secret, password, ...): `[redacted]` (existing).
- Any string: the value of a query parameter whose name ends in `token` (`token`, `ba_token`) becomes `<redacted>`; path and parameter name stay: `https://host/checkoutnow?token=<redacted>&x=1`.
- Order ids and capture ids in `id`, `path` and `href` paths are kept: `pnpm record:fixtures` needs them to match a request to its answer (its output says "ids: kept (sandbox play ids)", `--synthetic-ids` replaces them). `summary.md` already cuts them to 6 characters.
- Never throws: null, numbers, booleans, arrays, bigint, deep or cyclic input return a value (`[redacted]` past depth 30).

Inputs: `packages/testkit/src/sandbox-subject.ts`, `scripts/lib/sandbox-conformance-run.mjs`, `docs/owner/MVPB-OWNER-STEPS.md`. No environment variable, no credential, no network.
Outputs: `sandbox-subject.ts` (redactor, `renderCallsJson`), `index.ts` (exports), `scripts/lib/sandbox-conformance-run.mjs` (writes `renderCallsJson(exchanges)`), `sandbox-subject.test.ts` (one pinned test changes, see below), the owner steps paragraph, new tests `sandbox-redact.test.ts` and `sandbox-redact.integration.test.ts`.
Changed test: "another merchant id is left alone" contradicted the new rule (any merchant id is masked); it now expects the other id masked to its last 4.

Acceptance tests (run from the repo root, `TMPDIR=/dev/shm`, `env -u PAYPAL_CLIENT_ID -u PAYPAL_CLIENT_SECRET`):

- `corepack pnpm exec vitest run --project unit --project integration packages/testkit/src/sandbox-redact` : red before the implementation, green after.
- `corepack pnpm exec vitest run --project unit --project adversarial packages/testkit scripts/sandbox-conformance` : green.
- `corepack pnpm exec vitest run tests/mvp-b scripts` : green.
- `corepack pnpm lint --max-warnings 0`, `typecheck`, `format:check`, `check:isolation`, `check:routes`, `check:no-live-host`, `check:secrets-names`, `check:provenance`, `check:fixtures` : all exit 0.
- `/root/go/bin/gitleaks detect --log-opts "main..HEAD"` : no leaks.
- `node scripts/mutation-checks.mjs --targets packages/testkit/src/sandbox-subject.ts --max 30 --test-cmd "<narrowed vitest command>"` : score at least 80.

Do not: touch other packages; add a dependency; connect to PayPal or read a credential; change `docs/decision-log.md` or `docs/ASSUMPTIONS.md`; change the order of the payee check or compare against the written file; truncate order or capture ids in `calls.json`.
Evidence for the PR: the red run output, the green outputs above, mutation score, a sample redacted body (fake data only).
