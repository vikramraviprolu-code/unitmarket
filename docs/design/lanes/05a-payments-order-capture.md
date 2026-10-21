# Lane 05a: payments core, part 1 (place order, checkout, pre-capture read-back, readiness, capture, match, unlock)

Task: from a verified approval to a verified, unlocked item: expected transaction before any call, operations with idempotency keys, the pre-capture check, the readiness probe, one gated capture, the separate read-back and the atomic unlock.
Package: `domain/payments` (files listed below; lane 05b owns the rest) Owner: Sonnet worker W-05a Reviewer: Opus 5.5 ($, heaviest testing, mutation checks)
Wave: 3 (needs lanes 01, 04, 06, 07, 08, 09, 12). Size: 10 h (split at the read-back if a session must end: 5 h place and capture, 5 h match and unlock). Owner of `placeOrder`, `beginCheckout`, `onBuyerReturn`, `matchReadback`, `applyReadback`.

## Goal
A capture claim never unlocks. Access unlocks only when a separate read-back matches the expected transaction written before charging, in one transaction with the entitlement change, the window start, the ledger sale and the receipt. Pending, missing or conflicting evidence never unlocks and never causes a second charge.

## Inputs
- Architecture 3 (steps 4 to 14), 4.1, 4.2, 5, 9.2; nfr.md M1 to M3, P3, P4, P5, P6, P10, P17, REL-2, REL-3.
- Lane 01 F2 and F3 types; lane 04 `PayPalPort`; lane 06 `verifyApproval`, `markUsed`; lane 07 `createPendingEntitlements`, `applyMoneyEvent`, `markAccessReady`; lane 08 `appendLedgerEntry`, `issueReceiptIfChanged`; lane 09 `checkReadiness`.
- Copy and adapt (`/home/user/AIC_Hackathon_UnitMarket` at `a36ddc03fd0b962000f686291c145b50ee337f90`): `packages/core/payments/match.ts` (P5 order, statuses changed to the six PayPal capture statuses), `place.ts` (P1, P2), `checkout.ts` (P3), `capture.ts` (P4), `reconcile.ts` unlock transaction (P7 first bullet, P8), `store.ts`, `types.ts`, tests `match.test.ts`, `place.state.test.ts`, `checkout.state.test.ts`, `payments.adversarial.test.ts`, `support/fake-provider.ts` (replace with the lane 03 dry-run transport plus the lane 04 adapter). Rules RB-1 to RB-11 of `docs/specs/payment-readback.md` apply except RB-11 (currency is corridor configuration).

## Outputs
`domain/payments/src/{place.ts, checkout.ts, return.ts, capture.ts, match.ts, apply.ts, store.ts, keys.ts, alerts.ts, types.ts, index.ts}` and tests.

## Interfaces
```ts
export type PlaceError = { code: 'approval'; error: VerifyError } | { code: 'order_open'; http: 409 } | { code: 'checkout_off'; http: 503 };
export function placeOrder(d: PaymentsDeps, i: { approval_id: Id; token: string; actor: Actor }): Promise<Result<{ order_id: Id; order_ref: Id; status: OrderStatus }, PlaceError>>;
export function beginCheckout(d: PaymentsDeps, i: { order_id: Id; actor: Actor; scenario?: string | null }): Promise<Result<{ approve_url: string }, { code: 'not_found' | 'wrong_state' | 'create_failed' | 'payments_paused' }>>;
export function onBuyerReturn(d: PaymentsDeps, i: { order_ref: Id; actor: Actor; scenario?: string | null }): Promise<Result<OrderView, { code: 'not_found' | 'not_approved' | 'frozen' | 'not_charged_content_unavailable' | 'payments_paused' }>>;
export function matchReadback(i: { expected: ExpectedTransaction; read: Extract<OrderRead, { kind: 'order' }>; provider_order_id: ProviderOrderId; claims: (ClaimUnit & { claimed_at: IsoUtc | null })[]; foreign_capture_ids: string[] }): MatchResult; // pure
export function applyReadback(tx: SqlExecutor, d: PaymentsDeps, i: { order_id: Id; read: Extract<OrderRead, { kind: 'order' }>; trigger: 'return' | 'capture' | 'poll' | 'webhook' }): Promise<ApplyReport>;
export interface ApplyReport { order_status: OrderStatus; unlocked: Id[]; pending: Id[]; declined: Id[]; mismatched: Id[]; alerts: string[] }
export interface OrderView { order_id: Id; order_ref: Id; status: OrderStatus; buyer_message: string; items: { article_id: Id; access: AccessState; window: WindowState }[]; environment: EnvironmentLabel }
export function requestIdFor(kind: 'create' | 'capture' | 'refund', ref: Id): string;  // umsC-<ref>, umsK-<ref>, umsR-<ref>; <= 108 chars
```
Rules (exact):
1. `placeOrder`, one transaction, checks before writes: `checkout_enabled` switch; `verifyApproval`; open order for (buyer, content_hash) gives `order_open`; `markUsed`. Writes order (`order_ref` = `ids.next('ord')`, `expected` built from the snapshot and parsed, status `created`), one `provider_orders` row (route `single` in MVP-A; D2 per-publisher rows in MVP-D), units, pending entitlements, operation `create` `prepared` with `request_id = requestIdFor('create', order_ref)`, lease. No PayPal call inside any transaction.
2. `beginCheckout`: lock the create operation; set `sent`, `first_sent_at`, `idem_safe_until = first_sent_at + idem_safe_window_ms`; call `createOrder`; `created`: store provider id and approve URL, operation `confirmed`, order `awaiting_buyer`; `rejected`: operation `failed/rejected`, order `failed`, items `declined`; `timeout`, `unavailable`, `in_progress`, `blocked`: operation `unknown` with `reconcile_until` and `next_retry_at`.
3. `onBuyerReturn` (the return is a trigger, never evidence; the stored provider order id is used, never one from the URL, P6): read the order; not `APPROVED`: `not_approved`, no change; match with empty claims: order-level failure or unit mismatch freezes (`frozen`, alert kind `frozen_order`; payments never imports recovery: lane 10 opens cases from alerts, so there is no dependency cycle); then `checkReadiness` for every item: failure means no capture, order `failed`, items `declined`, buyer message "Not charged: content unavailable"; then capture through the conditional `UPDATE operations SET state='sent' WHERE id=$1 AND state='prepared' RETURNING id` (P4), so concurrent returns make one call.
4. Capture result: `claim` stores per-unit claims only (`capture_id`, status as note, `claimed_at`); order `capture_claimed`; then a separate `getOrder` read and `applyReadback`. `timeout`, `unavailable`, `in_progress`, 202, `ORDER_ALREADY_CAPTURED`: operation `unknown`, order `unresolved`, no read now. `payer_action`: order back to `awaiting_buyer` with the redirect link. `rejected` 422 other: read back decides; declined only when the read shows `DECLINED` or `FAILED`.
5. `matchReadback`: copy P5 order; unit `matched` for `COMPLETED` and `PARTIALLY_REFUNDED`, `pending` for `PENDING` (status reason kept), `declined` for `DECLINED` and `FAILED`; `REFUNDED` before any verified capture is a mismatch alert, never an unlock. Fees never take part.
6. `applyReadback` per matched unit not yet verified: compare-and-set `captured_verified_at`, `capture_id`, status `captured_verified`, observed fee; every item `capture_verified`; `markAccessReady` (window starts now, D-2); ledger `sale` and `paypal_fee` (when observed); receipt. `unlock_enabled` off: record the verified capture and ledger, keep items locked with message "Access paused", unlock on the next read after the switch returns. All terminal units: order `paid` (or `paid_partial`, or `failed`); else `unresolved`.

## Acceptance tests (`corepack pnpm vitest run --project <p> domain/payments`)
- unit: `match: one case per branch, expected result named in the case (24 or more)`; `requestIdFor lengths and prefixes`.
- state: `order, expected transaction, unit, entitlement and prepared operation exist when the transport sees create` (A-10); `claim COMPLETED with read-back unavailable stays locked` (A-11); `matching read-back unlocks, starts the window now, books sale and fee, issues receipt v1` (A-12); `amount +1, other payee, EUR, other custom_id each freeze with no sale` (A-13, P5); `pending with RECEIVING_PREFERENCE_MANDATES_MANUAL_ACTION stays locked and says so` (A-16); `readiness failure means no capture call and not charged` (A-17); `checkout_enabled off refuses new orders`; `unlock_enabled off books the capture but keeps access paused`; `return with another order's PayPal id uses the stored id` (P6).
- adversarial: `20 concurrent returns make exactly one capture call` (A-15, P4); `double submit of placeOrder gives one order and one 409` (P10); `tampered token 403, no rows`; `PayPal call inside a transaction is detected by a test spy and fails the test`.
- integration: `dry-run happy journey: approval to available item with six provider calls at most` (B-08 offline twin).
- mutation: `node scripts/mutation-checks.mjs --target domain/payments/src/match.ts` score at least 80 percent.

## Security and NFR gates
M1 to M3, P3, P4, P5, P6, P10, P17 (approval side), REL-2, REL-3, A-10 to A-17, MAINT-4, MAINT-6.

## Do not
Set paid from a claim or a webhook; rebuild the expected side from a response; call the provider inside a transaction; capture twice; read real time; touch files owned by lane 05b (`reconcile.ts`, `due.ts`, `recover.ts`, `webhooks.ts`, `refunds.ts`, and `packages/jobs`); add dependencies; change contracts; connect to PayPal (dry-run only).

Branch `feat/payments-order-capture` Commit `feat(payments): order, gated capture, read-back match and unlock (SBX-A-05a)`.
