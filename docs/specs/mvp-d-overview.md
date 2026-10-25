# MVP-D: two publishers in one approval (composite), lane overview

Status: proposal, revision 3 (after the second Opus review, at 933b7f4), 2026-10-25, written by the design-spec writer (Opus 5.5). No product code changes here.

- Route: **D2** (decision-log D-007, architecture decision D-3): one PayPal order per publisher under one UnitMarket approval.
- D1 and D3 are not assumed: spike W11 (runbook step 16) has not run.
- Payees: D-041. Both fictional publishers are paid into the owner's own sandbox Business account; the payee is left out per D-028; `payee_shared` is an explicit, audited flag.
- Approval row and waiver: D-042.
- No commission.
- This is the minimum viable MVP-D; cut items are in section 5.

"Passing offline" proves the modelled cases only, not PayPal compatibility.

Lane specs: `mvp-d-dp1-snapshot-gates.md`, `mvp-d-dp2a-provider-orders.md`, `mvp-d-dp2b-reconcile-continuation.md`, `mvp-d-dp3-recovery-partial.md`, `mvp-d-dp4-ledger-receipts.md`, `mvp-d-dp5-web-composite.md`, `mvp-d-dp6-offline-gate.md`. Decisions are in `mvp-d-open-questions.md`. The owner decided OQ-1, OQ-18 (D-041) and OQ-13 and M7 (D-042); the only owner item left is OQ-8, the buyer wording.

## 1. Facts established from the code

What already supports N units or N provider orders:

- **Schema.** `packages/db/migrations/common/0004_money.sql`:
  - `orders.status` allows `paid_partial`.
  - `provider_orders` has `route IN ('single', 'per_publisher')`, and a free-text `status` column that holds PayPal's last-seen order status (written at create, `checkout.ts:122`, and by reads).
  - `order_units.provider_order_ref`, `publisher_id` and `payee_merchant_id` are per unit.
  - `ledger_entries` are per unit and capture; `receipts` are per order and versioned.
  - `approvals` must expire 15 minutes after creation (line 19).
- **Approval.** `requestApproval` (`domain/approval/src/approval.ts`):
  - builds one snapshot over up to 5 offers (`MAX_ITEMS`, selection kind `proposal`), with per-publisher blocks;
  - refuses `mixed_currency` and a second corridor before approval;
  - refuses `publisher_unverified` (P18, D-04).
  - `placeOrder` re-checks every payee and answers `payee_unavailable` (409).
- **Order and units.** `placeOrder` writes one unit per publisher, entitlements per item, and one expected unit per publisher.
- **Match and apply.** `matchReadback` checks each unit (payee, amount, capture amount, capture id reused across units). `applyReadback` derives `paid` / `paid_partial` / `failed` from the units.
- **Recovery.**
  - `partial_composite` exists, is in `ALERT_CASE_KINDS` and has a 24 h SLA.
  - From the help page, a buyer's report on an order opens `payment_unresolved` (4 h SLA, `composition.server.ts:1181-1190`); `/api/cases` takes no kind.
  - `offer_refund` only files a request: nothing executes it (ASSUMPTIONS open item), and the unit stays blocked with `refund_in_flight`.
  - The MFA refund route `POST /api/refunds` (CO-8) requests and executes.
- **Ledger and refunds.** Ledger rows, INV1, refunds and the ledger guard are per unit.
- **PayPal adapter.** `buildCreateBody` leaves the payee out when it equals `UMS_OWN_MERCHANT_ID` (`build-create.ts:91`). The dry-run model keeps many PayPal orders, each with its own approval scenario.
- **Transport and gate.**
  - `mvp_b_polling` refuses a payee only when one is in the body.
  - The amount cap is checked per call (`gate.ts:77`), that is per PayPal order.
  - `PayPal-Mock-Response` is not on the header allow-list (`sandbox.ts:126-132`).
  - On the host, `UMS_OUTBOUND_SCOPE` is pinned to `mvp_c_refunds` (`check-hosting.mjs:74`).

What does not exist, or contradicts D2:

1. **The engine reads one provider order and one operation per kind per order.**
   - Checkout and return: `beginCheckout` uses `providers[0]` (`checkout.ts`); `onBuyerReturn` reads `[0]` and acts only while the order is `awaiting_buyer` (`return.ts:45-55`).
   - Apply and reconcile: `applyReadback` throws unless there is exactly one provider order (`apply.ts` ~108); the paid re-read `readAndApply` uses `[0]` (`reconcile.ts:46`).
   - Due pass: `expireCreate` (`due.ts:502`); the capture retry (`due.ts:351`, `:375-399`, `:407`; it refuses a capture with no `idem_safe_until`, `:386`); `abandonOne` (`due.ts:556-560`, `:582`). The sweep sees only `awaiting_buyer` orders (`:558`).
   - Refunds: two refund reads (`refunds.ts` ~796, ~1122).
   - Store: `loadOperation` (`store.ts:202`, `LIMIT 1`).
   - Webhooks: `webhooks.ts:279`.
   - Startup recovery: `IN_FLIGHT` marks a prepared capture `unknown` by order status (`recover.ts:20`), and `UNPOLLED_ORDERS` is keyed on order status.
   - Test worlds: `support.ts:619, 642`, `ops/support.ts`, and `apps/web/src/webhook-support.ts:291`, which inserts a second `single` provider order.
2. **Capture works on the whole order** (`capture.ts`):
   - the capture key comes from `order_ref` (`:57`, `:66`, `:77`);
   - the gate requires `orders.status = 'awaiting_buyer'` (`:100`), loads the capture by order and kind (`:108`, `:136`), and moves the order to `capture_requested` (`:153`);
   - reopen and blocked put the order back to `awaiting_buyer` (`:259`, `:317`);
   - payer_action writes `approve_url ... WHERE order_id` (`:325`).
3. **`lockOrderRows` does not lock `provider_orders`** (`store.ts:161-168`), although D-020 names them.
4. **A two-publisher approval today produces a D1-shaped order.** In sandbox mode only `harbour-ledger` gets a merchant id (`composition.server.ts:575-582`), so a second publisher is refused `publisher_unverified` at approval.
5. **Duplicate invoice ids.** For a one-unit order, `invoice_id` is `order_ref`. Duplicate-invoice blocking is on for the owner's account (D-033).
6. **`publishers.paypal_merchant_id` is `UNIQUE`** (`publishers_paypal_merchant_id_key`). On the MVP-C disk, `harbour-ledger` already stores the owner's merchant id.
7. **No second USD publisher.**
   - `seedCatalogue` runs only when there are no publishers (`composition.server.ts:552-553`).
   - `seededIds` uses one counter per seed (`seeded-ids.ts:8-10`).
8. **Freezing is all-or-nothing.** A unit mismatch freezes the whole order (`apply.ts` ~262), and the mismatch path returns before `issueReceiptIfChanged` (`apply.ts:145-170`).
9. **Not built yet:**
   - nothing raises `partial_composite`;
   - there is no per-publisher ledger sum or invariant;
   - receipt lines do not say "not charged".
10. **Web:**
    - the discover page selects one offer;
    - there is no progress across two approvals;
    - `/checkout/cancel` has no page.

## 2. Lane split, order and parallelism

| Lane                                     | Scope (one line)                                                                                                                                                                                 | Effort | Risk   | Decisions                    |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------ | ------ | ---------------------------- |
| DP-1 snapshot gates and supply data      | `settlement` in per-publisher snapshots only, max 2 publishers, composite P18 and mixed-currency proofs, supplementary Quayside seed on every boot, migration 0010 `payee_shared`                | 0.5 d  | low    | D-041 (decided)              |
| DP-2a provider orders $                  | Migration 0011, N provider orders, eager create, "Step 2 of 2", capture gate per PayPal order, one read-and-match pass, read-back per PayPal order, status rules, invoice id, pack window, locks | 2.0 d  | high   | none                         |
| DP-2b continuation and background $      | Reconcile, due, recover and webhooks per PayPal order; continuation after the first capture; the strict `declined` rule; deadline; 24 h sweep and window per pack                                | 0.75 d | high   | none                         |
| DP-3 refunds per unit and partial copy $ | Refund reads per unit's PayPal order; the partial message; keep is the default by doing nothing; refund through the help-page report and the CO-8 route                                          | 0.4 d  | medium | OQ-8 (open)                  |
| DP-4 per-publisher ledger and receipt $  | `publisherBalances`, INV7 (D-06, P11 per publisher), a per-publisher outcome on receipt lines                                                                                                    | 0.4 d  | medium | none                         |
| DP-5 web composite                       | Pack selection, approval blocks, "Step 2 of 2", static `/checkout/cancel`, per-item lines, dry run per PayPal order, boot seeding on the MVP-C disk                                              | 1.0 d  | medium | D-041 (decided), OQ-8 (open) |
| DP-6 offline gate                        | D-01 to D-07 twins, continuation twins, no-socket proof, evidence, owner steps against D-042                                                                                                     | 0.75 d | medium | D-041, D-042 (decided)       |

Order: DP-1, DP-2a, DP-2b, then DP-3 and DP-4 in parallel (disjoint files), then DP-5, then DP-6. Total about 5.8 lane-days. `apps/web` and `apps/web/composition.server.ts` are held only by DP-5, with one named exception: DP-2a edits `apps/web/src/webhook-support.ts`, a test-support file, because migration 0011 breaks its INSERT. Migrations: 0010 (DP-1), 0011 (DP-2a). **Do not deploy DP-2a or DP-2b to the host before DP-3 merges**: refund reads still pick the order's first provider order until then.

## 3. Shared names and rules (every lane uses these)

- **Routes.** `single` (one publisher; rows, keys and hash unchanged) and `per_publisher` (D2). Only a snapshot with 2 publishers carries `settlement: { route: 'per_publisher', payments: 2 }`.
- **Provider order columns** (0011): `position` (1..N, ordered by `publisher_id`), `po_ref` (`<order_ref>-p<position>`; equals `order_ref` for `single`), `publisher_id`, `state`, `first_approved_at`.
  - `first_approved_at` is the moment **we** first saw an APPROVED read, not PayPal's approval time.
  - **`state`** is our state machine and the only thing the engine decides on. **`status`** stays PayPal's last-seen order status text, informational only.
- **Provider order states**: `prepared`, `awaiting_buyer`, `approved`, `capture_requested`, `capture_claimed`, `unresolved`, `captured`, `declined`, `frozen`, `failed`, `abandoned`.
  - Terminal: `captured`, `declined`, `frozen`, `failed`, `abandoned`.
  - **Not charged** means `declined`, `failed` or `abandoned` only. `frozen` means on hold: money may have moved.
- **Backfill of existing rows** (0011, from the order status): `created`→`prepared`, `awaiting_buyer`→`awaiting_buyer`, `capture_requested`→`capture_requested`, `capture_claimed`→`capture_claimed`, `unresolved`→`unresolved`, `paid`→`captured`, `paid_partial`→`captured`, `failed`→`failed`, `abandoned`→`abandoned`, `frozen`→`frozen`.
- **Order status** comes only from `deriveOrderStatus(provider order states, capture_sent)`, where `capture_sent` means some capture operation of the order has `first_sent_at`.
  - No capture sent:
    - any `prepared` → `created`;
    - otherwise any `awaiting_buyer` or `approved` → `awaiting_buyer`;
    - all `abandoned` → `abandoned`;
    - all `failed` → `failed`;
    - any `frozen` → `frozen`.
  - Capture sent, some provider order not terminal:
    - any `unresolved` → `unresolved`;
    - otherwise any `capture_claimed` → `capture_claimed`;
    - otherwise → `capture_requested`. This covers captured+approved, captured+capture_requested and approved+capture_requested.
  - Capture sent, all terminal:
    - all `captured` → `paid`;
    - at least one `captured` → `paid_partial`;
    - none `captured` and any `frozen` → `frozen`;
    - otherwise → `failed`.
  - The order never returns to `awaiting_buyer` once a capture was sent.
  - `mismatch = true` whenever any provider order is `frozen`.
- **Keys and ids.** `umsC-<po_ref>`, `umsK-<po_ref>[-n]` (D-014 cap per provider order), read-back row `umsB-<po_ref>`; `custom_id` = `order_ref`; `invoice_id` = `po_ref`. N single-unit creates; no new operation, header, scope or seal change; the approval row shape is unchanged.
- **Alerts.**
  - `partial_composite` (reason `partial`, once per order) only when a provider order is not charged.
  - `frozen_order` for each held provider order.
  - `payment_unresolved` when a provider order cannot be read at its deadline (DP-2b).
- **Config.** `pack_approval_window_ms`, default 3 600 000. When it has passed since `first_approved_at`, every provider order is read: if all are APPROVED, the pack is captured (P17); otherwise the whole pack is `abandoned`, nothing charged.
- **Call budget.** A happy composite uses at most 13 PayPal calls:
  - 1 token, 2 creates, 2 return reads;
  - 1 pre-capture pass read (PO1; PO2's pass read is its return read in the same handler call);
  - 1 status read (PO2; PO1's status read is the pass read);
  - 2 captures, 2 order GETs, 2 capture GETs.
  - The continuation in DP-2b may add reads. This figure feeds the D-042 calls-per-day value.
- **Test payee ids.** `SBXPAYEEHARBOUR1` and `SBXPAYEEQUAYSIDE2` (distinct, fake). In sandbox, both publishers map to the owner's id (D-041).

## 4. Files each lane touches

- **DP-1:**
  - `domain/approval/src/{approval.ts,errors.ts}`, `composite.state.test.ts`, `composite.adversarial.test.ts`;
  - `packages/contracts/src/approval.ts` and its test;
  - `domain/catalogue/src/{seed-data.ts, seed.ts, index.ts}`, `catalogue.state.test.ts` (new cases), `fixtures/catalogue/seed-composite.json`;
  - `packages/testkit/src/catalogue.ts`;
  - `packages/db/migrations/common/0010_publisher_payee_shared.sql`, `packages/db/src/schema.state.test.ts`.
  - Must stay green unchanged: `domain/offer-entry`, `domain/discovery`, `tests/mvp-a`.
- **DP-2a:**
  - migration: `packages/db/migrations/common/0011_provider_order_state.sql`, `packages/db/src/schema.state.test.ts`;
  - contracts and adapter: `packages/contracts/src/{paypal.ts,config.ts}` and their tests, `packages/paypal/src/build-create.ts`, `build-create.test.ts`;
  - payments source: `domain/payments/src/{composite.ts (new), place.ts, checkout.ts, return.ts, capture.ts (lines 57, 66, 77, 100, 108, 136, 153, 259, 317, 325), apply.ts, store.ts, keys.ts, alerts.ts, types.ts, invariants.ts (INV5), index.ts, support.ts, ops/support.ts}`;
  - new tests: `composite.test.ts`, `composite.state.test.ts`, `composite.adversarial.test.ts`, `migration-0011.state.test.ts`;
  - `lockorder.state.test.ts` (provider_orders rank, plus setup);
  - `apps/web/src/webhook-support.ts` (exception: the INSERT becomes an UPDATE of the placed row);
  - setup only ("D1 dormant" helper): `apply.state`, `capture.mutpay.state`, `due.budget.adversarial`, `due.budget.state`, `invariants.state`, `payments.adversarial`, `place.state`, `refunds.complete.adversarial`, `refunds.complete.state`, `refunds.remaining.state`, `return.state`, `review05a.state`, `webhooks.adversarial`, `webhooks.state`. These are the files that use `ofr_3`; the builder confirms which of them place two publishers in one order.
- **DP-2b:**
  - `domain/payments/src/{reconcile.ts, due.ts, recover.ts, webhooks.ts}`;
  - new tests: `composite.due.state.test.ts`, `composite.recover.state.test.ts`, `composite.webhooks.state.test.ts`, `composite.continuation.adversarial.test.ts`.
- **DP-3:**
  - `domain/payments/src/refunds.ts`, `refunds.composite.state.test.ts`;
  - `domain/recovery/src/messages.ts`, plus `cases.ts` for the message input only, `partial-message.state.test.ts`.
- **DP-4:**
  - `domain/ledger/src/{sums.ts, index.ts}`, `sums.test.ts`, `publisher.state.test.ts`;
  - `domain/payments/src/invariants.ts` (INV7), `invariants.composite.state.test.ts`;
  - `domain/receipts/src/{body.ts, html.ts}`, `composite.golden.test.ts`, `golden/composite-receipt.golden.txt`;
  - `packages/contracts/src/receipts.ts` and its test.
- **DP-5:**
  - `apps/web/composition.server.ts`, `apps/web/src/server/dryrun-model.ts`, `apps/web/src/lib/view-types.ts`;
  - pages: `apps/web/src/app/{discover, approve/[id], checkout/return, checkout/dry-run/[order], checkout/cancel (new, static), orders/[ref]}/**`;
  - routes: `apps/web/src/app/api/orders/[ref]/checkout/route.ts` and the route inventory;
  - tests: `apps/web/e2e/composite.spec.ts`, `apps/web/src/composite.{state,adversarial,golden}.test.ts`, `src/golden/composite-copy.golden.txt`.
- **DP-6:** `tests/mvp-d/*`, `pnpm-lock.yaml`, `docs/evidence/mvp-d-offline-gate-<date>.md`, `docs/owner/MVPD-OWNER-STEPS.md`, `docs/READINESS.md`, `docs/ASSUMPTIONS.md`, and one `NAMED_EXEMPTIONS` entry if needed.

## 5. Later, only if time (cut from the minimum viable MVP-D)

- A buyer `cancelCheckout` API.
- `chooseCompositeOutcome`, its route, the case choice buttons and a 7-day auto-close.
- A `refund_requested` kind on `/api/cases`.
- `publisherReport` and the ops page section.
- A full per-publisher receipt section.
- "Bought together with" in the library.
- Letting the buyer re-approve a PayPal order after `payer_action` once the pack has started capturing.
- A second sandbox merchant (D-041: needs step 16 and a new owner permission).

## 6. Safety rules that do not move

- The five locks and the two-key approval.
- The approval row's scope, operations and per-call cap cover every PayPal order of a pack. The pack total is bounded only by 2 x the cap (D-042).
- One capture per PayPal order (P4).
- Access only after a verified capture and a separate matching read-back including the payee, per PayPal order.
- D-020 lock order: orders, provider_orders by position, operations, order_units, refund_requests, recovery_cases, entitlements, ledger, receipts.
- Append-only ledger.
- A webhook only makes a read-back due.
- The 15 minute approval is consumed once by `placeOrder`.
- No automatic substitution.
- No Payouts, platform fee or Partner Referrals.
- Migrations are forward-only.
- The MVP-D sitting is local, with the webhook off (DP-6).
