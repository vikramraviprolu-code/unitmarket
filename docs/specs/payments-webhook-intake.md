# CO-2: webhook intake in payments: idempotent store, read-back only, any order of arrival

Task: turn a verified webhook into at most one stored event and at most one due read-back for the order it names, and nothing else (apart from marking a suspected reversal).
Package: `domain/payments` (`webhooks.ts`, `index.ts`) Owner: Sonnet 5.5 builder, effort high (P2, replay and race safety) Reviewer: Opus 5.5 high, mutation check on `webhooks.ts`; Sakthi merges
Wave: W0, starts now (it consumes the existing `WebhookVerdict` contract; CO-1 is not needed to build it). Assumptions: ASM-60 (new), ASM-07, ASM-59. Requirements: nfr.md P1 (no state from a webhook), P2, C-05, C-12, D-020 lock order.

Goal: `handleWebhook(d, { verdict, transmission_id, received_at }) → { http: 200 | 400 | 503; outcome: 'enqueued' | 'no_op' | 'duplicate' | 'rejected' | 'unverifiable' | 'disabled' }`. `webhook_enabled` off: 503 `disabled`, nothing stored (PayPal retries for 3 days, RLR-5). `bad_signature` or `malformed`: 400 `rejected`, one `audit_log` row (`webhook.rejected`, the reason, a sha256 of the transmission id; no body), nothing else. `unverifiable`: 503, one audit row, nothing else. `verified`: insert into `webhook_events` with `ON CONFLICT DO NOTHING` on `event_id` and on `transmission_id`; a conflict answers 200 `duplicate` and changes nothing. Then resolve the order: `PAYMENT.CAPTURE.*` by capture id on `order_units`; a refund resource by its `up` link to the capture, else by the provider refund id stored on `refund_requests`; `CHECKOUT.ORDER.*` by provider order id. Not found or an unhandled type: stored, 200 `no_op`. Found: make the order's read-back operation due now (create it as `touchWatch` does if absent), coalesced: when it is already due within 60 s nothing changes (ASM-60). `PAYMENT.CAPTURE.REVERSED` additionally calls the existing `suspectReversalTx` (unit `reversal_suspected`, alert), never `reversed`. Nothing here sets paid, books the ledger, touches an entitlement or a window, or calls PayPal; the read-back decides, so arrival order does not matter. Locks follow D-020; the event row is a leaf insert.

Inputs: `packages/contracts` (`WebhookVerdict`, `ProviderEvent`), `packages/db` migration 0004 (`webhook_events`), `domain/payments/src/{store.ts, refunds.ts (suspectReversalTx), due.ts (operation shape)}`, architecture 4.2 and 9.1.

Outputs: `domain/payments/src/webhooks.ts`, `domain/payments/src/index.ts` (export `handleWebhook`), tests below. No migration; if one is needed, stop and report.

Order: commit 1 is tests only, run red; then implement.

Acceptance tests:

- `corepack pnpm vitest run --project unit domain/payments/src/webhooks.test.ts`: event type to target mapping table; coalescing rule at 59 s and 61 s.
- `corepack pnpm vitest run --project state domain/payments/src/webhooks.state.test.ts`: `genuine COMPLETED enqueues one read-back and never sets paid` (C-01 offline twin); `same event 3 times: one enqueue, 200 each` (P2, C-05); `replay after a full refund leaves access revoked once the read-back runs` (C-05); `REFUNDED then COMPLETED delivered out of order: final state equals the read-back, item not unlocked again`; `REVERSED gives reversal_suspected and one alert, not reversed`; `webhook_enabled off: 503 and nothing stored`; `unknown type stored, no_op`; `capture id that is not ours: no_op`.
- `corepack pnpm vitest run --project adversarial domain/payments/src/webhooks.adversarial.test.ts`: `50 concurrent deliveries of one event: one row, one enqueue`; `same event id with a new transmission id: duplicate`; `bad_signature and malformed change no table except audit_log`; `lock order spy: orders, operations, order_units only, in D-020 order`; `webhook and poller on one order at once: one transition, one sale` (C-12 offline twin).
- `corepack pnpm mutation --targets domain/payments/src/webhooks.ts --require-targets`: at least 80 percent.
- `corepack pnpm test && corepack pnpm lint && corepack pnpm typecheck`: exit 0.

Do not: verify signatures here (CO-1); call the PayPal port; change `refunds.ts`, `due.ts`, `apply.ts` or migrations; store or log the raw body; add a dependency.

Evidence for the PR: red summary; pass counts; mutation score; the lock-order spy output.

Branch: `feat/payments-webhook-intake` Commit: `feat(payments): idempotent webhook intake that only enqueues read-backs (CO-2)`
