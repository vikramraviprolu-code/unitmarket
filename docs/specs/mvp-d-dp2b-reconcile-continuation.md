# DP-2b: background paths per provider order and pack continuation after the first capture

Task: port every writer that still works on `orders.status` or on all provider orders of an order to the per-PayPal-order model of DP-2a, remove the DP-2a legacy shim, and make sure a pack whose first capture was sent always finishes. Every remaining approved PayPal order is captured once, or it ends not charged, but only when PayPal proves nothing was taken.

Package: `domain/payments` (`reconcile.ts`, `due.ts`, `recover.ts`, `webhooks.ts`, `composite.ts` for the shim removal and rule 3 only).
Owner: Sonnet 5.5 builder, effort high ($).
Reviewer: Opus 5.5 high, diff review plus mutation checks; Sakthi merges.

Wave: MVP-D W2b, after DP-2a (merged as 6f39e96).
Decisions: table A (OQ-4, OQ-6).
Requirements: P3, P4, P17, REL-2, REL-3, D-014/D-018, D-020, ASM-75, INV5, C-11 and C-12 (composite form).
Names and status rules: `mvp-d-overview.md` section 3.
Deploy hold: do not deploy to the host before DP-2b and DP-3 have merged. `render.yaml` has `autoDeploy: false`, so merging does not deploy; do not deploy by hand either.

## Goal

### 1. One status writer, no shim

- Delete `legacyState` and its call in `lockOrderGraph` (`composite.ts` ~149, ~179).
- Delete the test table "a single order moved by a writer that still works on orders.status".
- Add a source-scan test that fails if `UPDATE orders SET status` appears anywhere in `domain/**` outside `composite.ts`.
- `orders.status` is written only by `deriveOrderStatus` through the composite helpers.

### 2. Port every whole-order writer

Each of these now writes the state of one PayPal order, `WHERE id`, under `lockOrderGraph`. The order status follows from `deriveOrderStatus`.

`reconcile.ts`:

- `:155`: unresolved after an unknown capture answer.
- `:180`: reopen. Today it puts the order back to `awaiting_buyer` even while PO1 is still `unresolved`.
- `:189`: payer_action reopen. Today it writes `provider_orders WHERE order_id`, which changes both PayPal orders.
- `:204`: a late `DUPLICATE_INVOICE_ID`. Today it freezes the order with no status guard; add the same `live` guard as the other answer paths. Before any capture it uses the whole-order helper; after a capture it freezes that PayPal order only.
- `:231` and `:278`: the create resend. Today it sends every unit with no `invoice_id` under PO2's key, which would create one two-unit order for the pack.
- `:319`: the resend writes `WHERE order_id`.
- `:327`, `:339`, `:357`.

`due.ts`: `:162`, `:506` and `:512` (`expireCreate`), `:582` (`ORDER BY id LIMIT 1`), `:610`, `:630`.

`recover.ts`: `:27`.

Any freeze that reconcile makes before a capture uses the whole-order helper.

### 3. Per PayPal order

- **Create resend.** `resendCreate` rebuilds the create of ONE PayPal order: its own units, its own `invoice_id` (`po_ref`), its own key `umsC-<po_ref>`, then `UPDATE provider_orders ... WHERE id`.
- **Create expiry.** `expireCreate` ends the whole order (the whole-order helper, nothing charged) when a PayPal order never got a provider order id.
- **Recovery selectors.** `IN_FLIGHT` and `UNPOLLED_ORDERS` (`recover.ts`) select by provider order state, not order status. A reopened PO2 capture is `prepared` but carries a send timestamp; it must not be marked `unknown`. A never-sent capture (`first_sent_at` NULL) must not be marked `unknown` either, because the capture retry refuses it (`due.ts:386`).
- **Capture retry.** `maybeRetryCapture` works per PayPal order, with that order's own operation and key.
- **Reads.** `readAndApply` and the paid re-read read every PayPal order by its stored id and apply each read to its own slice. `abandonOne` reads every PayPal order.
- **Webhooks.** A webhook (`webhooks.ts:279`) makes due only the read-back of the PayPal order it names.

### 4. Rule 3 treats `declined` like `failed`

In overview section 3 and in `composite.ts` ~102: a `declined` PayPal order with no send, beside an `approved` one, must not derive `awaiting_buyer`. The strict `declined` rule below is unchanged.

### 5. Continuation selector

The due pass picks every `approved` PayPal order whose order has `capture_sent` (overview section 3). That means a sibling PayPal order whose own capture operation has `first_sent_at` and whose state is not `approved`.

- Each pick is counted against the due budget.
- These orders are never sent to the sweep, which looks only at `awaiting_buyer` orders (`due.ts:558`).

For each pick:

1. Read it fresh.
2. If the read shows APPROVED and the match holds, capture it through the DP-2a gate with its own key, then read it back.
3. If the read shows COMPLETED, any capture, or `ORDER_ALREADY_CAPTURED`, go to read-back and match. That ends in `captured` or `frozen`.

### 6. The strict `declined` rule

A PayPal order becomes `declined` only when condition 1 holds and either case 2a or case 2b holds.

- **Condition 1.** The PayPal order is `approved`, and none of its capture operations is `sent` or `unknown`. This is checked again under `lockOrderGraph`, inside the transaction that writes `declined`.
- **Case 2a.** A fresh GET shows VOIDED or not found, with no capture on the unit.
- **Case 2b.** The deadline has passed, and a fresh GET shows no capture on the unit, whatever the status.

The capture gate takes the same lock. A decline and a capture are therefore mutually exclusive.

**Deadline.** The deadline is `first_approved_at + pack_approval_window_ms + reconcile_window_ms`, or the D-014 key cap, whichever comes first. When the PayPal order cannot be read at the deadline, raise one `payment_unresolved` alert.

### 7. Pack window, 24 h sweep and abandonment

- **Pack window (L1).** The due pass enforces the pack approval window as well as the return path; otherwise the step-page promise does not hold. When the window has run out and no capture was sent, read every PayPal order (the `abandonOne` path):
  - all APPROVED and matching: capture once (P17);
  - otherwise: every PayPal order is `abandoned`, nothing charged.
- **Approval that disappears.** An approved PayPal order that stops being approved after the window is abandoned by the next due pass, without waiting for a second return.
- **Sweep.** The 24 h sweep applies the same rule.
- **Never after a send.** A pack is never abandoned while `capture_sent` holds.

Inputs: DP-2a on main (`composite.ts`, `lockOrderGraph`, the gate, `deriveOrderStatus`), `domain/payments/src/{reconcile,due,recover,webhooks}.ts`, CO-2 rules, D-014, D-018.

Outputs: the DP-2b files in overview section 4, plus `composite.ts` (shim removal and rule 3) and `composite.test.ts`.

## Red-first tests (commit 1)

`composite.due.state.test.ts`:

- `crash after PO1 captured: the next due pass captures PO2 once with umsK-<ref>-p2`
- `kill switch between the captures: after reset exactly one PO2 capture`
- `lost lease on PO2 capture: one same-key resend`
- `PO2 GET COMPLETED after a lost capture answer: captured, never declined`
- `PO2 GET VOIDED, no send: declined, paid_partial, partial alert`
- `PO2 VOIDED but a send is unknown: not declined`
- `ORDER_ALREADY_CAPTURED on PO2: read-back decides`
- `payer_action on PO2 after PO1 captured: approve_url on PO2 only; declined after the deadline on a no-capture read`
- `pack payer_action on the due path: only that PayPal order reopens; the order is never awaiting_buyer while PO1 is unresolved`
- `D-014 cap reached: deadline applies`
- `deadline, PO2 unreadable: one payment_unresolved alert`
- `continuation counted against the due budget`
- `24 h sweep, nothing sent, PO2 unapproved: abandoned`
- `window run out, both APPROVED: captured once (P17)`
- `window run out on the due pass, no return: abandoned`
- `lost PO2 create resent with a single-unit body (one unit, own invoice_id, own key)`
- `expireCreate with a PayPal order that never got an id: whole order failed`
- `late DUPLICATE_INVOICE_ID on a dead operation: no change`
- `D-02 PO1 DECLINED at capture, crash before PO2: continuation captures PO2, paid_partial, one partial_composite alert`
- `single payer_action: awaiting_buyer, unchanged`
- `pack with nothing sent, PO1 reopened: not picked`
- `PO2 APPROVED before / after the deadline: not declined / declined (case 2b)`
- `a unit we declined whose capture later shows COMPLETED raises unexpected_capture declined_unit_received and unlocks nothing` (`reconcile.ts:224`; this mutant survives every test today)

`composite.recover.state.test.ts`:

- `a never-sent prepared PO2 capture is not marked unknown`
- `a reopened PO2 capture (prepared, send timestamp) is not marked unknown`
- `a sent PO2 capture is read first`

`composite.webhooks.state.test.ts`:

- `PO2 event makes only PO2's read-back due`

`composite.test.ts`:

- `rule 3: declined (no send) beside approved is not awaiting_buyer`

`composite.continuation.adversarial.test.ts`:

- `return, poll, sweep and webhook at once: one capture per PayPal order`
- `crash between captures: terminal within 2 passes after the lease ends`
- `decline and capture race: exactly one wins`
- `source scan: no UPDATE orders SET status outside composite.ts`
- `lock order spy`

## Acceptance tests

- `corepack pnpm vitest run --project unit --project state --project adversarial domain/payments`: all pass.
- `corepack pnpm mutation --targets domain/payments/src/due.ts,domain/payments/src/reconcile.ts,domain/payments/src/recover.ts`, with the exact narrowed test command recorded: the PR lists the score and every surviving mutant, each with a one-line reason (money-relevant survivors must be killed or justified).
- `corepack pnpm test && corepack pnpm lint && corepack pnpm typecheck`: exit 0.

## Do not

- change the DP-2a gate, return, checkout or apply logic beyond calling it;
- touch `refunds.ts`, the transport, safety, the web app or composition;
- abandon a pack while `capture_sent` holds;
- mark a PayPal order `declined` on any read that shows a capture;
- add a dependency.

## Evidence for the PR

- Red summary, pass counts, the mutation command and survivors, and the PayPal call list of the crash-between-captures test.
- Disclosure (L2): every existing test edited after the red commit, one line each, saying what changed and why.

Branch: `feat/payments-composite-continuation`
Commit: `feat(payments): background paths per provider order and pack continuation (DP-2b)`
