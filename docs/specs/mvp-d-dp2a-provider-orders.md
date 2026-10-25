# DP-2a: provider orders for route D2: create, "Step 2 of 2", capture and read-back per PayPal order

Task: settle a `per_publisher` order as one PayPal order per publisher, each with its own state, keys, invoice id, approval, capture and matching read-back, on the buyer's return path.
Package: `domain/payments`, `packages/db` (0011), `packages/contracts` (paypal, config), `packages/paypal` (`build-create.ts`) Owner: Sonnet 5.5 builder, effort high ($) Reviewer: Opus 5.5 high, diff review plus mutation checks; Sakthi merges
Wave: MVP-D W2, after DP-1. Decisions: table A (OQ-3, 4, 6, 9, 14). Requirements: D-01, D-02, D-05, P3 to P6, P14, D-014/D-018, D-020, ASM-75. The names, states, status rules, backfill and call budget are in `mvp-d-overview.md` section 3. DP-2b owns the background paths. Do not deploy to the host before DP-3 merges.

Goal.

- **Migration 0011** (forward-only).
  - Add the new provider order columns and `operations.provider_order_ref` as nullable.
  - Backfill from existing rows only (no `now()`), using the overview mapping.
  - Then set NOT NULL on `position`, `po_ref` and `state`.
  - Add UNIQUE `(order_id, position)`, UNIQUE `po_ref`, UNIQUE `(order_id, publisher_id)`, CHECK `route = 'single' OR publisher_id IS NOT NULL`, and the state CHECK.
  - Test it on a copy of an MVP-C-shaped database.
- **Locks.** `lockOrderRows` locks the order, then its provider orders `FOR UPDATE` by position, then its operations.
- **Place.**
  - A `per_publisher` snapshot writes one provider order per publisher (`prepared`), with each unit on its own provider order and one create operation `umsC-<po_ref>` each.
  - A two-publisher snapshot without `settlement` is an invalid approval.
  - `single` is unchanged.
- **Create (eager).** `beginCheckout` sends each create outside any transaction: one unit each, `custom_id` = `order_ref`, `invoice_id` = `po_ref`.
  - `invoice_id` is a new optional field in `CreateOrderReqSchema`, allowed with one unit only; `buildCreateBody` uses it.
  - It answers the position-1 approve URL with `progress { step: 1, of: 2 }`, and only when every provider order has been created.
  - If any create is rejected, the whole order is `failed`. A `DUPLICATE_INVOICE_ID` at create freezes the whole order.
- **Return** (a trigger only).
  - Read every `awaiting_buyer` provider order by its stored id (P6). An APPROVED read moves that order to `approved`, and the first one sets `first_approved_at`.
  - While any is still awaiting the buyer, answer the next approve URL with `step` of `of`.
  - Pack window: once it has run out, every provider order is read. All APPROVED: go on to capture. Otherwise the whole pack is `abandoned`.
- **Pre-capture pass.** One pass reads and matches every provider order against its slice (`expectedFor`, with the claims of every unit of the order), and checks readiness for every item.
  - Any mismatch or `DUPLICATE_INVOICE_ID`: the whole order is `frozen`, nothing captured.
  - Any item not ready: the whole order is `failed`.
  - A provider order that has lapsed (VOIDED or not found, no capture): the whole pack is `abandoned`, nothing charged. No hold wording (L-2).
  - **Whole-order outcomes (M-A)** are all the cases above: a create rejected, a duplicate at create, a pass mismatch, an item not ready, a lapsed order, and a pack abandon. Each writes its terminal state to **every** non-terminal PayPal order of the order, in one transaction under `lockOrderRows`.
- **Capture gate (H-1).**
  - In one transaction: lock the order rows, require `provider_orders.state = 'approved'` for that PayPal order, move its capture operation `prepared`→`sent` and move that provider order to `capture_requested`.
  - Each `approved` provider order is captured in position order, after a status-only read showing APPROVED, with its own key (D-014 cap per provider order).
  - Every answer writes the state of that PayPal order only:
    - claim → `capture_claimed`;
    - unknown → `unresolved`;
    - blocked, reopen or payer_action → back to `approved`; payer_action writes `approve_url` `WHERE id` = that provider order.
  - `orders.status` is set only by `deriveOrderStatus` (`composite.ts`, pure). It never returns to `awaiting_buyer` while `capture_sent` holds. `capture_sent` means a PayPal order is sent in the overview's sense, not merely that some operation has `first_sent_at` (H-A). So a `single` order reopened after payer_action or `ORDER_NOT_APPROVED` goes back to `awaiting_buyer`, as today (`return.state.test.ts:575`, `:597` stay green unchanged).
- **Read-back.** After each capture: an order GET and a capture GET, matched against that slice. A unit mismatch, or a `DUPLICATE_INVOICE_ID` after a capture, freezes only that provider order (`frozen_order` alert, mismatch flag, "On hold").
- **Alerts and receipts.**
  - `partial_composite` is raised only on entering `paid_partial` with at least one provider order not charged.
  - A hold after money moved writes a new receipt version: the mismatch branch no longer returns before `issueReceiptIfChanged`.
- **Invariants and views.**
  - INV5 holds per provider order.
  - `OrderView` gains `progress`, `provider_orders [{ position, publisher_id, state }]`, and `publisher_id` per item.
  - The test worlds read provider orders by position.

Inputs: overview sections 1 and 3, DP-1, `domain/payments/src/*`, `0004_money.sql`, `build-create.ts`, `packages/contracts/src/{paypal,config}.ts`, READINESS "Lock order".

Outputs: the DP-2a files in overview section 4. Three notes for the commit and the PR:

- This spec is longer than one page (about 1,200 words), a stated exception accepted by the reviewer: the capture-gate and status rules are what the builder must not get wrong.

- The listed `ofr_3` tests contradict the spec, because two publishers in one PayPal order is the D1 shape. Their setup moves to a labelled "D1 dormant" helper, and their assertions stay.
- `apps/web/src/webhook-support.ts:291` is changed, as a named exception, because 0011 makes its second-provider-order INSERT invalid. It now UPDATEs the placed row.

Red-first tests (commit 1):

- `composite.test.ts`: `deriveOrderStatus` over every overview row, including captured+approved = `capture_requested`, captured+unresolved = `unresolved`, captured+frozen = `paid_partial` with mismatch and no partial alert, captured+declined = `paid_partial` with the alert; also `expectedFor`, the key formats and `captureKeyNumber` on a `po_ref`.
- `build-create.test.ts`: `invoice_id honoured`; `invoice_id with two units refused`.
- `migration-0011.state.test.ts`: the ten status mappings, operations backfilled, constraints hold.
- `composite.state.test.ts`:
  - `place: 2 provider orders, 2 units, 2 create ops`;
  - `single unchanged`;
  - `single payer_action: awaiting_buyer, unchanged`;
  - `pack with nothing captured, PO1 reopened after payer_action: awaiting_buyer, buyer can approve again`;
  - whole-order outcomes, each writing every PayPal order: `create rejected on PO2: both failed, order failed`; `DUPLICATE_INVOICE_ID at create on PO2: both frozen, order frozen, no approve url`; `pass mismatch on PO2: both frozen`; `readiness fails: both failed`; `PO2 lapsed in the pass: both abandoned`; `pack window abandon: both abandoned`;
  - `two single-unit creates, distinct invoice ids, own id omitted`;
  - `repeat checkout: no third create`;
  - `second create rejected: failed`;
  - `return after PO1: no capture, step 2 of 2`;
  - `D-01 two captures, two capture ids, two sales`;
  - `D-02 PO2 DECLINED: paid_partial, PO2 not charged, one partial alert`;
  - `D-05 PO2 payee mismatch after capture: PO2 frozen, paid_partial with mismatch, new receipt version, no partial alert`;
  - `mismatch in the pass: order frozen, zero captures`;
  - `PO2 VOIDED in the pass: abandoned, zero captures, no hold`;
  - `readiness fails: failed, zero captures`;
  - `kill switch on PO2's capture after PO1 captured: PO2 approved, order capture_requested, never awaiting_buyer`;
  - `payer_action on PO2: approve_url written on PO2 only`;
  - `pack window run out, PO2 unapproved: abandoned; all APPROVED: captured`;
  - `happy composite at most 13 PayPal calls`.
- `composite.adversarial.test.ts`:
  - `20 concurrent returns: one capture per PayPal order`;
  - `lock order spy, provider_orders after orders`;
  - `URL ids ignored`;
  - `no create carries two units`.

Acceptance tests:

- `corepack pnpm vitest run --project unit --project state --project adversarial domain/payments packages/paypal packages/contracts packages/db apps/web`: all pass.
- `corepack pnpm mutation --targets domain/payments/src/composite.ts,domain/payments/src/apply.ts,domain/payments/src/return.ts,domain/payments/src/capture.ts --require-targets`: each at least 80 percent.
- `corepack pnpm test && corepack pnpm lint && corepack pnpm typecheck && corepack pnpm check:isolation && corepack pnpm check:no-live-host`: exit 0.

Do not:

- touch `packages/transport` or `packages/safety` (ASM-70);
- touch `reconcile.ts`, `due.ts`, `recover.ts`, `webhooks.ts` or `refunds.ts`;
- touch the web app beyond the named file;
- build D1 or D3;
- capture before every PayPal order is approved;
- add a dependency.

Evidence for the PR: red summary, pass counts, mutation scores, the lock-order spy output, the migration test, and the sanitised PayPal call lists for a happy and a partial composite.

Branch: `feat/payments-provider-orders-d2` Commit: `feat(payments): one PayPal order per publisher on the return path (DP-2a)`
