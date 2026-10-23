# CO-4: refunds complete: operator MFA, dashboard refunds booked, partial and full states, case flow

Task: close the refund gaps left by FIX-PAY2: require operator MFA, book refunds made at the PayPal dashboard from the order's refund list, handle `PARTIALLY_REFUNDED` and `REFUNDED` per unit, and move refund recovery cases on the read-back.
Package: `domain/payments` (`refunds.ts`), `domain/recovery` (`rules.ts`) Owner: Sonnet 5.5 builder, effort high (money) Reviewer: Opus 5.5 high, mutation check on `refunds.ts`; Sakthi merges
Wave: W1, after BU-4 merges (same file). Assumptions: ASM-53, ASM-59, ASM-06. Requirements: nfr.md P9, P11, M3, C-06, C-07, D-019, D-020.

Goal: (1) `requestRefund` refuses an operator without `mfa: true` with the new code `mfa_required` (additive), before anything is stored (P9). (2) One open refund request per unit at a time: a second request while one is `requested`, `sent`, `unknown` or `pending` answers `refund_in_flight` (so a double click and a partial-then-remainder sequence cannot overlap). (3) When `observeReadback` sees a refund in the unit's `refunds` list (BU-4) that matches no `refund_requests` row by provider refund id and is `COMPLETED`, it appends one ledger `refund` entry keyed by that refund id with the listed amount, issues the next receipt version, and sets the unit `partially_refunded` or `refunded` from the sums; this replaces the `refund_unbooked` alert, which stays only when the list is unavailable. (4) Unit status follows the sums, never `refunded_minor` alone (D-019): sum below captured is `partially_refunded` (access continues, ASM-59); sum equal is `refunded` and revokes access through the existing entitlements path; a sum above captured is impossible by the DB bound and, if read, freezes the unit with an alert. (5) A recovery case in `refund_pending` moves to `refunded` when its refund reads `COMPLETED`, back to `diagnosing` with an alert when it reads `FAILED` or `CANCELLED` (`domain/recovery/src/rules.ts`). (6) INV1 holds per unit after every scenario: sale minus refunds equals verified captured minus refunded.

Inputs: BU-4 (`OrderReadUnit.refunds`, send-path check), `domain/payments/src/refunds.ts`, `domain/recovery/src/{rules.ts, cases.ts}`, `domain/ledger` (`appendLedgerEntry`), `domain/receipts` (`issueReceiptIfChanged`), `domain/entitlements` (`applyMoneyEvent`), D-019, D-020.

Outputs: `domain/payments/src/refunds.ts`, `domain/recovery/src/rules.ts`, tests below, `domain/receipts/src/refund-v2.golden.test.ts` plus its golden file (test only; no receipts code change).

Order: commit 1 is tests and golden only, run red; then implement.

Acceptance tests:

- `corepack pnpm vitest run --project state domain/payments/src/refunds.complete.state.test.ts`: `operator without MFA: mfa_required, nothing stored`; `second request while one is open: refund_in_flight`; `partial 2.00 then remainder: two refund rows, two ledger entries keyed by refund id, unit partially_refunded then refunded, access revoked after the second` (C-06); `dashboard refund 1.50 seen on a re-read: one ledger entry with that refund id, receipt version 2, no refund_unbooked alert`; `the same dashboard refund seen twice: one entry`; `full refund: online item revoked, keep item links stop, receipt shows the refund` (C-07); `refund_pending case moves to refunded on COMPLETED and back to diagnosing on FAILED`.
- `corepack pnpm vitest run --project integration domain/payments/src/refunds.complete.integration.test.ts`: the real adapter over the dry-run transport and synthetic fixtures: request, execute, read-back, book, with INV1 to INV4 green after each step.
- `corepack pnpm vitest run --project adversarial domain/payments/src/refunds.complete.adversarial.test.ts`: 20 concurrent requests for one unit give one request and at most one provider call; a listed refund in another currency or with an unknown status books nothing and freezes with an alert; the lock-order spy shows D-020 order in every refund transaction.
- `corepack pnpm vitest run --project golden domain/receipts/src/refund-v2.golden.test.ts`: receipt version 2 body after a partial refund matches the golden.
- `corepack pnpm mutation --targets domain/payments/src/refunds.ts --require-targets`: at least 80 percent.
- `corepack pnpm test && corepack pnpm lint && corepack pnpm typecheck`: exit 0.

Do not: book from `refunded_minor` alone; book before a read shows the refund; refund from a buyer actor; change BU-4's send-path check, `due.ts`, `webhooks.ts` or `index.ts`; change ledger or receipts code; connect to PayPal; add a dependency.

Evidence for the PR: red summary; pass counts; mutation score; INV results after the integration run.

Branch: `feat/payments-refunds-complete` Commit: `feat(payments): refunds need MFA, dashboard refunds booked, partial and full states (CO-4)`

Review notes (CO-5 and BU-4 reviews, 2026-10-23):

- Never send a money event for a PayPal refund that reads PENDING: `pending` from `captured` is refused. Pending refunds stay in the payments layer only.
- Item-level refunds: a partial refund is a unit-level price adjustment and never revokes an item (ASM-61, open). An item-level refund must be a full refund of a single-item unit.
- BU-4 leaves "refund the rest" with no amount stored as the local remaining. After a dashboard refund this always closes as over-remaining. Book dashboard refunds first (goal 3), then clamp a null request to PayPal's remaining amount, and test it.
- Lock order: a recovery case in `refund_pending` locks the case, then the entitlement. Take the same order here, and ask the reviewer to add recovery cases to the D-020 list.
