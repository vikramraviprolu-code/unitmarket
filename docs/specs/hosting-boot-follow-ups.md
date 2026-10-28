# Spec: hosted boot and capture bookkeeping follow-ups (PAY-1)

Task: the LOW findings of the PG-2 and DP-4 reviews that matter for the hosted MVP-C window.
Package: `apps/web` (boot only), `domain/payments` (capture bookkeeping), `tests/mvp-c-pg`, `docs/READINESS.md` Owner: PAY-1 builder Reviewer: Opus, one round (D-048)
Branch: `feat/hosting-boot-follow-ups` Commit: `feat(<package>): <what> (PAY-1)` Decisions: D-014, D-020, D-044, D-045.

Goal: the boot logs what D-044 promised, a late capture answer leaves no stale `sent` operation on a paid order, the capture gate is proven under real concurrency on Postgres, and two test and comment gaps are closed. No change to any money outcome.

Requirements (tests first, run red):

1. D-044: when `UMS_MAINTENANCE_FLAG` is unset or whitespace in sandbox mode, boot logs `maintenance.unconfigured` once at info level and continues (read through `packages/config`'s field, not the environment). Fixed text, no value. Test: set, unset, whitespace. The owner doc already says the app logs this line.
2. Stale `sent` capture operation (PG-2 finding F1, reviewed harmless): in `domain/payments/src/capture.ts` `settleDead` and the read-back apply path, a `sent` capture operation of an order that is already `paid` (verified capture) must end in a terminal state without any send, any extra PayPal call or any change to the order, unit, ledger or entitlement. Prove with the `tests/mvp-c-pg` capture race (assert `stale_sent_capture_rows=0` over at least 20 rounds) and a state test with a late timeout answer meeting an already paid order. If the fix needs any behaviour change beyond bookkeeping, STOP and report.
3. Direct concurrent `captureOnce` race on real Postgres (`tests/mvp-c-pg`, runs only when `UMS_TEST_PG_BIN` is set): two concurrent `captureOnce` calls on one prepared operation, at least 20 rounds: exactly one send, one sale, INV1 to INV7 hold. Prove it bites: remove the conditional-update guard once in a throwaway copy and show the test fails, then restore.
4. PG-2 LOW: the cross-connection test checks the gate, not only `readSafetyStatus`: an approval row inserted over another connection is seen by the running app's gate `activeApproval` without a restart.
5. `apps/web/src/instrumentation.ts` comment: on Postgres recovery runs inside the leader's term, not awaited at boot.
6. `docs/READINESS.md`: one paragraph recording that the INV7 check counts reversal rows in the ledger net but not in `refunded_minor`, so a future reversal booking must move both (DP-4 review M1).

Acceptance (run, paste output): `UMS_TEST_PG_BIN=/usr/lib/postgresql/16/bin corepack pnpm exec vitest run --maxWorkers=2 tests/mvp-c-pg apps/web/src domain/payments`; lint, format:check, typecheck, test:unit, test:state (default PGlite path), check:isolation, check:no-live-host, check:secrets-names, check:routes, check:hosting, check:hosting-gcp, tests/mvp-b/sealed-callers.test.ts.
Do not: add a dependency; change a migration or a contract; contact any network or PayPal; read or create a secret; run mutation checks; edit an existing test except where item 4 strengthens one (say which).
Disk: nearly full; run `df -h /` before heavy steps, stop under 400 MB; kill only throwaway Postgres processes YOU started, by pid.
Evidence: commands with output, rounds counts, a cost line.
