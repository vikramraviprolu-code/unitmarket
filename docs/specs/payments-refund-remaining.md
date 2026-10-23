# BU-4: refunds send an explicit amount checked against PayPal's own remaining amount

Task: map each unit's refund list from GET order, and make the refund send path check the requested amount against what PayPal says is left before any `refundCapture` call.
Package: `domain/payments` (send path), `packages/paypal` (`map-order.ts`), `packages/contracts` (additive) Owner: Sonnet 5.5 builder, effort high (money) Reviewer: Opus 5.5 high, mutation check on the send path; Sakthi merges
Wave: W0, starts now. Assumptions: ASM-53 (new), ASM-12, ASM-13, D-019.

Goal: the domain already sends an explicit amount on every refund (null at request time is fixed to the local remaining amount), and the approved transport refuses `refund_capture` without one (amount binding). What is missing is PayPal's side: a refund made at the dashboard is invisible to our local remaining amount, so a "refund the rest" request can ask for more than PayPal holds. Add to the contracts, additively, `OrderReadUnit.refunds: { refund_id: string; status: RefundStatus; amount: Money }[]` (empty when absent), mapped by `map-order.ts` from `purchase_units[].payments.refunds[]`; an unknown refund status or an unreadable amount makes the whole read `unavailable` (fail closed, ASM-12 rule). In `executeRefund`, before the send: read the order (reuse a read at most 60 s old); PayPal remaining = captured amount minus the sum of refunds that are `COMPLETED` or `PENDING`; if the request's amount is above it, close the request `failed` with reason `over_refund_remote`, free the reservation, raise `refund_unbooked` for a human, and send nothing; if the read is not available, keep the request `requested` and retry on the normal schedule, never sending blind. The amount sent is always the stored request amount, never null. Booking of dashboard refunds is CO-4, not this lane.

Inputs: `domain/payments/src/refunds.ts` (`requestRefund`, `executeRefund`), `packages/paypal/src/map-order.ts`, `packages/contracts/src/paypal.ts`, Orders OpenAPI `payment_collection` (refunds), D-019, READINESS FIX-PAY2 M-2.

Outputs: `packages/contracts/src/paypal.ts` (additive field, schema and test), `packages/paypal/src/map-order.ts`, `fixtures/paypal/synthetic/refunds_listed__get_order__{1,2}.json` (one completed partial refund; one pending) labelled `synthetic`, `fixtures/paypal/index.json`, `domain/payments/src/refunds.ts` (send path only), tests below. Not `domain/payments/src/index.ts`.

Order: commit 1 is tests and fixtures only, run red; then implement.

Acceptance tests:

- `corepack pnpm vitest run --project unit packages/paypal/src/map-order.refunds.test.ts`: refunds mapped with id, status and minor units; none present gives `[]`; unknown status gives `unavailable`; a refund in another currency gives `unavailable`.
- `corepack pnpm vitest run --project contract packages/paypal/src/map-order.refunds.contract.test.ts`: every fixture under `fixtures/paypal/**` still maps (A-23); the two new fixtures map to the expected lists.
- `corepack pnpm vitest run --project state domain/payments/src/refunds.remaining.state.test.ts`: `dashboard refunded 3.00 of 5.00, operator asks for the rest: 2.00 is sent, not 5.00`; `PayPal shows nothing left: no call, request failed over_refund_remote, reservation freed, one refund_unbooked alert`; `read unavailable: no call, request stays requested, next due time set`; `a pending dashboard refund counts against the remaining amount`.
- `corepack pnpm vitest run --project adversarial domain/payments/src/refunds.remaining.adversarial.test.ts`: a spy port proves `every refundCapture call carries a non-null amount at most PayPal's remaining amount` over 200 random sequences of local and dashboard refunds; `a read older than 60 s is not reused`.
- `corepack pnpm mutation --targets domain/payments/src/refunds.ts --require-targets`: score at least 80 percent on the changed functions.
- `corepack pnpm test && corepack pnpm lint && corepack pnpm typecheck && corepack pnpm check:fixtures`: exit 0; existing refund tests unchanged and green.

Do not: book any ledger entry for a dashboard refund (CO-4); change the adapter's request building or the transport; touch `domain/payments/src/{due.ts,index.ts}`; remove the `refunded_minor` advisory; connect to PayPal; add a dependency.

Evidence for the PR: red summary; pass counts; mutation score; a note that ASM-53 stays unverified until the owner's first refund read.

Branch: `feat/payments-refund-remaining` Commit: `feat(payments): refund amount checked against PayPal's remaining amount (BU-4)`
