# CO-5: access windows, lost-time credit and refunds

Task: fix and test the rules where refunds meet the access clock: partial refund, full refund, a pending refund, credit after a revoke, and a window that has not started.
Package: `domain/access-clock`, `domain/entitlements`, `packages/contracts` (`entitlements.ts`, additive) Owner: Sonnet 5.5 builder, effort high (access follows money) Reviewer: Opus 5.5 high, mutation check on `compute.ts` and `table.ts`; Sakthi merges
Wave: W0, starts now. Assumptions: ASM-59 (new), ASM-09, D-006. Requirements: architecture 4.3, 4.4; nfr.md M1, P9, P13; READINESS 05a note on `PARTIALLY_REFUNDED`.

Goal: the rules, all pure in `computeWindow` and the entitlement table, and enforced in the event writers. R1: a partial refund verified for an item changes neither the window state nor `ends_at` (the buyer keeps what was not refunded). R2: a full refund or a reversal verified revokes from any window state; after `revoked` no event changes the window again (`computeWindow` stops at the first revoke). R3: `grantCredit` on a revoked or ended window answers `window_ended` (existing code) and writes nothing; credit never reduces `ends_at`. R4: a refund request that is only pending changes nothing (no pause, no credit). R5: a not-started window may start after a partial refund (money stays `captured`); after a full refund it never starts: `markAccessReady` refuses with `money_not_captured`. R6: a window paused by a delivery failure and then revoked keeps the paused `ends_at` in history and accrues no credit. Add the money event `partial_refund_verified` (additive in `packages/contracts/src/entitlements.ts`): it leaves the money state `captured` and the access state unchanged in every cell of the table. `revokeWindow` stays the only revoke path.

Inputs: `domain/access-clock/src/{compute.ts, events.ts, credit.ts}`, `domain/entitlements/src/table.ts`, `packages/contracts/src/entitlements.ts`, the existing property tests.

Outputs: the files above and tests below. Not `domain/payments` (CO-4 calls these functions; their signatures do not change).

Order: commit 1 is tests only, run red; then implement.

Acceptance tests:

- `corepack pnpm vitest run --project unit domain/access-clock/src/refund.test.ts domain/entitlements/src/table.test.ts`: R1 to R6 as table cases; `partial_refund_verified` is a no-op in every one of the table's cells and the table stays exhaustive.
- `corepack pnpm vitest run --project unit domain/access-clock/src/refund.property.test.ts`: over 1,000 random sequences of `delivery_failed`, `delivery_restored`, `credit_granted`, partial and full refunds: `ends_at` never decreases before a revoke; nothing changes after a revoke; `available` never follows a full refund; the materialised window equals `computeWindow(events)` after every event.
- `corepack pnpm vitest run --project state domain/access-clock/src/refund.state.test.ts`: R3, R5 and R6 through the database writers, with event order by `(at, seq)`.
- `corepack pnpm vitest run --project adversarial domain/access-clock/src/refund.adversarial.test.ts`: a credit and a full refund for one item racing: either order ends `revoked` with no credit after it; a replayed `revoked` event is a no-op.
- `corepack pnpm mutation --targets domain/access-clock/src/compute.ts --require-targets` and `corepack pnpm mutation --targets domain/entitlements/src/table.ts --require-targets`: at least 80 percent each.
- `corepack pnpm test && corepack pnpm lint && corepack pnpm typecheck`: exit 0.

Do not: change the 5-day window or the credit rounding; add a recall promise for a downloaded copy; touch payments, recovery or delivery code; add a dependency.

Evidence for the PR: red summary; pass counts; mutation scores; the R1 to R6 table.

Branch: `feat/access-clock-refund-interplay` Commit: `feat(access-clock): refund and credit rules for windows (CO-5)`
