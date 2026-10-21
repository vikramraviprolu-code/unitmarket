# Lane 05b: payments core, part 2 (reconciler, due work, startup recovery, abandonment, refund path offline, job loop)

Task: resolve every unknown operation by reading first, inside the idempotency window, with backoff and a 24 h window; recover after a crash; sweep abandoned checkouts; implement the refund flow against fixtures; run it all from one job loop.
Package: `domain/payments` (files below), `packages/jobs` Owner: Sonnet worker W-05b Reviewer: Opus 5.5 ($, heavy testing, mutation checks)
Wave: 3, starts with 05a and codes against its exported signatures; merges after 05a. Size: 9 h.

## Goal
No order stays stuck silently, nothing is charged twice, and a restart in the middle of a capture ends terminal or frozen within two passes. Retries reuse the same key and stop at 5 h after the first send, because PayPal keeps keys for 6 h.

## Inputs
- Architecture 4.1, 5, 9.2; nfr.md M3, P3, P11, P17, REL-2 to REL-4, COST-1, PERF-9, INC-2.
- Lane 05a exports (`applyReadback`, `requestIdFor`, `OrderView`, store helpers), lane 04 `PayPalPort`, lane 08 ledger, lane 07 `applyMoneyEvent`, `revokeWindow`, lane 02 `SwitchReader`.
- Copy and adapt (`/home/user/AIC_Hackathon_UnitMarket` at `a36ddc03fd0b962000f686291c145b50ee337f90`): `packages/core/payments/due.ts` (P10, P11), `reconcile.ts` (P6 to P8: retry capture once with the same key after a read shows no capture), `webhooks.ts` P12a recovery idea, `due.state.test.ts`, `reconcile.state.test.ts`, `reconcile.frozen.state.test.ts`, `reconcile.paid-mismatch.state.test.ts`, `packages/core/app/platform-invariants.ts` (INV ideas).

## Outputs
`domain/payments/src/{reconcile.ts, due.ts, recover.ts, refunds.ts, invariants.ts}`; `packages/jobs/src/{loop.ts, health.ts, index.ts}`; tests.

## Interfaces
```ts
export function reconcileOrder(d: PaymentsDeps, i: { order_id: Id; trigger: 'poll' | 'webhook' | 'manual' }): Promise<ApplyReport | { skipped: 'terminal' | 'paused' }>;
export function runDue(d: PaymentsDeps, i: { max_items: number }): Promise<{ processed: number; still_unknown: number; expired: number; abandoned: number }>;
export function nextDueAt(db: SqlExecutor): Promise<IsoUtc | null>;
export function recoverOnStartup(d: PaymentsDeps): Promise<{ resumed: number }>;
export function requestRefund(d: PaymentsDeps, i: { unit_id: Id; amount: Money | null; reason: string; actor: Actor /* operator */ }): Promise<Result<{ refund_request_id: Id }, { code: 'refunds_off' | 'not_captured' | 'over_refund' | 'not_operator' }>>;
export function executeRefund(d: PaymentsDeps, i: { refund_request_id: Id; scenario?: string | null }): Promise<Result<{ status: RefundStatus }, { code: 'unknown' | 'rejected' }>>;
export function checkInvariants(db: SqlExecutor): Promise<{ id: 'INV1' | 'INV2' | 'INV3' | 'INV4'; ok: boolean; detail: string }[]>;
// jobs
export function startLoop(d: PaymentsDeps & { sweepWindows: (x: { max_items: number }) => Promise<{ ended: number }> }, o: { max_sleep_ms: number /* 30000 */; max_items: number }): { stop(): Promise<void> };
export function health(d: CoreDeps): Promise<{ db: boolean; last_pass_at: IsoUtc | null; due: number; switches: Record<SwitchName, boolean>; transport: EnvironmentLabel }>;
```
Rules: due operations ordered by (`next_retry_at`, `id`); backoff 30 s, 2 min, 10 min, 1 h (last repeats); `reconcile_until` = first capture send + 24 h. Read first, always. A create unknown: resend with the same key only while `now < idem_safe_until`; after it, read by `order_ref` is not possible (no search API), so the operation becomes `failed/window_expired`, the order `failed` only if no provider order id was ever stored, else `unresolved` with alert `payment_unresolved` (lane 10 turns it into a case) (buyer told "You will not be charged twice"). A capture unknown with a read showing no capture: retry the capture once with the same key while inside `idem_safe_until` (attempt limit `1 + max_capture_retries`); never after. Window end: last read, then `failed/window_expired`, alert `payment_unresolved`; money never auto-failed, never re-charged. `paypal_outbound` off: loop skips calls and reports `paused`. Abandonment sweep (P17): orders `awaiting_buyer` older than 24 h: read; `APPROVED` runs the 05a capture path once; else `abandoned`, items `declined`, nothing charged. Hourly re-read of `paid` orders for 7 days (catches dashboard refunds). Refunds (MVP-A offline only): operator-only, `refunds_enabled`, amount at most captured minus refunded (`over_refund`), key `requestIdFor('refund', refund_request_id)`, then `getRefund` and `getOrder` read-back; ledger `refund` per refund id only after the read shows it; full refund revokes the window (`revokeWindow`) and access. Reversal: a `PAYMENT.CAPTURE.REVERSED` event or read marks the unit `reversal_suspected` and raises alert `reversal`; `reversed` only by operator confirmation (architecture 4.2). Startup: every `prepared` or `sent` operation becomes `unknown` with `next_retry_at = now`; then `runDue`.

## Acceptance tests (`corepack pnpm vitest run --project <p> domain/payments packages/jobs`)
- state: `backoff 30 s, 2 min, 10 min, 1 h, 1 h`; `lost capture response: read shows COMPLETED, one capture, unlocked once` (A-14, REL-3); `read shows no capture: one retry with the same key inside 5 h, none after` (P3); `create unknown past 5 h never resends and raises payment_unresolved`; `24 h expiry alerts once and never re-charges` (INC-2); `abandoned at 24 h: APPROVED captures once, else abandoned with no charge` (P17); `partial then full refund: two ledger entries by refund id, access revoked after full` (offline twin of C-06); `over-refund refused`; `refund by a buyer actor refused`; `reversal event gives reversal_suspected and an alert, not reversed`; `paused switch skips calls`; `invariants INV1 to INV4 pass after every scenario and fail on injected drift` (P11).
- adversarial: `kill -9 simulated between sent and response: after recoverOnStartup the order is terminal or frozen within two passes` (REL-2); `runDue twice changes nothing the second time` (REL-4); `webhook and poller race on one order give one transition and one sale` (offline twin of C-12, using `reconcileOrder` twice concurrently).
- perf: `500 open operations, fixture provider: one pass under 60 s and at most 2 calls per second` (PERF-9).
- mutation: `--target domain/payments/src/reconcile.ts` at least 80 percent.

## Security and NFR gates
M3, P3, P9 (offline part), P11, P17, REL-2 to REL-4, COST-1, PERF-9, MAINT-4.

## Do not
Capture without a prior read in recovery; resend after `idem_safe_until`; mark money failed by absence; refund from a buyer request without an operator; touch 05a's files; add dependencies; change contracts; connect to PayPal.

Branch `feat/payments-reconcile-jobs` Commit `feat(payments): reconciler, recovery, abandonment, offline refunds, job loop (SBX-A-05b)`.
