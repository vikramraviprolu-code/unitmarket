# BU-7: cut the conformance approval poll rate

Task: poll GET order every 15 s, at most 24 reads, in the owner-run sandbox subject.
Package: `packages/testkit` Owner: Sonnet 5.5 builder Reviewer: Opus 5.5; Sakthi merges
Goal: the owner-run suite waits for the owner's approval for the same 6 minutes but costs about 24 calls instead of up to 120, so a run no longer burns the 300 calls/day approval budget (D-035). `SANDBOX_LIMITS.poll_interval_ms` is 15000 and `max_polls` is 24. Nothing else changes: the 20-calls-per-order cap, the 1.00 USD cap, the VOIDED stop and the "did not approve" error stay as they are.
Inputs: `packages/testkit/src/sandbox-subject.ts` (`SANDBOX_LIMITS`), `docs/owner/MVPB-OWNER-STEPS.md` step 6.
Outputs: `packages/testkit/src/sandbox-subject.ts`, `packages/testkit/src/sandbox-subject.test.ts`, `packages/testkit/src/sandbox-subject.adversarial.test.ts`, `docs/owner/MVPB-OWNER-STEPS.md` (one sentence), this spec.
Acceptance tests:

- `corepack pnpm vitest run --project unit packages/testkit/src/sandbox-subject.test.ts`: sleeps are `[15000, ...]`; a never-approved order gets 24 reads and 23 sleeps of 15 s, then `did not approve`.
- `corepack pnpm vitest run --project adversarial packages/testkit/src/sandbox-subject.adversarial.test.ts`: approval polls are capped at 24 and not counted against the 20.
- `corepack pnpm lint && corepack pnpm typecheck`: exit 0.
- `corepack pnpm check:isolation && corepack pnpm check:secrets-names`: exit 0.

Do not: touch other packages; add dependencies; change any other limit or behaviour; run `sandbox:conformance`; use credentials.
Evidence for the PR: red output of commit 1, green output of commit 2, diff stat.
Branch: `feat/testkit-poll-rate` Commit: `feat(testkit): poll every 15 s, at most 24 reads (BU-7)`

Note: the tests of commit 1 replace the old numbers (3 s, 120 reads) because they contradict this spec; no other test changed.
