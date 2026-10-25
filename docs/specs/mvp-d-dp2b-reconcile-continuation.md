# DP-2b: background paths per provider order and pack continuation after the first capture

Task: make reconcile, the due pass, startup recovery and webhooks work per provider order, and make sure a pack whose first capture was sent always finishes: every remaining approved PayPal order is captured once, or ends not charged only when PayPal proves nothing was taken.
Package: `domain/payments` (`reconcile.ts`, `due.ts`, `recover.ts`, `webhooks.ts`) Owner: Sonnet 5.5 builder, effort high ($) Reviewer: Opus 5.5 high, diff review plus mutation checks; Sakthi merges
Wave: MVP-D W2b, after DP-2a. Decisions: table A (OQ-4, OQ-6). Requirements: P3, P4, P17, REL-2, REL-3, D-014/D-018, D-020, ASM-75, INV5, C-11 and C-12 (composite form). Names and status rules: `mvp-d-overview.md` section 3. Do not deploy to the host before DP-3 merges.

Goal.

**Per provider order.**

- `readAndApply` (`reconcile.ts:46`) and the paid re-read read every provider order by its stored id and apply each read to its own slice.
- `expireCreate` (`due.ts:502`) resends an unknown create with its own `umsC-<po_ref>`.
- The capture retry (`due.ts:351`, `:375-399`, `:407`) uses each provider order's own operation and key.
- `abandonOne` (`due.ts:556-560`, `:582`) reads every provider order.
- A webhook (`webhooks.ts:279`) makes due only the read-back of the provider order it names.
- `IN_FLIGHT` (`recover.ts:20`) excludes never-sent captures (`prepared` with `first_sent_at` NULL). The capture retry refuses such a capture (no `idem_safe_until`, `due.ts:386`), so marking it `unknown` would strand it.
- `UNPOLLED_ORDERS` also selects by provider order state.

**Continuation selector (M-1 a).** The due pass picks every `approved` provider order whose order has `capture_sent`, in the overview's sense: a sibling PayPal order whose own capture operation has `first_sent_at` and whose state is not `approved` (this includes `captured`, in flight, and `frozen`, `declined` or `failed` after its own send). A reopened capture's `first_sent_at` alone does not count (H-A), so a `single` order after payer_action, or a pack with nothing in flight, stays with the buyer and the return path. Each one is counted against the due budget. These orders are never sent to the sweep: the sweep only looks at `awaiting_buyer` orders (`due.ts:558`). For each one:

- read it fresh;
- if the read shows APPROVED and the match holds, capture it through the DP-2a gate with its own key, then read it back;
- if the read shows COMPLETED, any capture, or `ORDER_ALREADY_CAPTURED`, go to read-back and match, which ends `captured` or `frozen`.

**`declined` is strict (H-2, M-B).** A PayPal order becomes `declined` (not charged) only when condition 1 holds and one of cases 2a or 2b holds.

- **Condition 1.** Its state is `approved`, and no capture operation of it is `sent` or `unknown`. This is checked again under `lockOrderRows`, inside the transaction that writes `declined`.
- **Case 2a.** A fresh GET shows VOIDED or not found, with no capture on its unit.
- **Case 2b.** The deadline below has passed, and a fresh GET shows no capture on its unit, whatever the order status.

The capture gate (DP-2a) takes the same lock and requires `approved` while it moves the operation to `sent`. Re-checking condition 1 under that lock makes a decline and a capture mutually exclusive: whichever transaction commits first wins, and the other finds the state changed and does nothing.

**Deadline (M-1 c).** A provider order can stay `approved` with no unknown operation, for example after payer_action, after `ORDER_NOT_APPROVED`, or once the D-014 key cap is reached. It is given a deadline: `first_approved_at + pack_approval_window_ms + reconcile_window_ms`, or the key cap, whichever comes first. At the deadline:

- a fresh read showing no capture: case 2b, so the provider order becomes `declined` and `partial_composite` is raised;
- a read showing a capture: read-back and match;
- the order cannot be read: one `payment_unresolved` alert.

**Never abandoned after a send.** A pack is never abandoned while `capture_sent` holds (overview section 3).

**24 h sweep and pack window, no capture sent (L-3).** Read every provider order first (the `abandonOne` path). All APPROVED and matching: capture once (P17). Otherwise every provider order is `abandoned`, nothing charged. `first_approved_at` is the moment we first saw an approval, not PayPal's time.

Inputs: DP-2a (states, gate, `deriveOrderStatus`, `lockOrderRows`), `domain/payments/src/{reconcile,due,recover,webhooks}.ts`, CO-2 rules, D-014, D-018.

Outputs: the DP-2b files in overview section 4.

Red-first tests (commit 1):

- `composite.due.state.test.ts`:
  - `crash after PO1 captured: the next due pass captures PO2 once with umsK-<ref>-p2`;
  - `kill switch between the captures: after reset exactly one PO2 capture`;
  - `lost lease on PO2 capture: one same-key resend, one capture`;
  - `PO2 GET COMPLETED after a lost capture answer: captured, never declined`;
  - `PO2 GET VOIDED, no send: declined, paid_partial, partial alert`;
  - `PO2 GET VOIDED but a capture send is unknown: not declined, read-back continues`;
  - `ORDER_ALREADY_CAPTURED on PO2: read-back decides`;
  - `payer_action on PO2 after PO1 captured: stays approved until the deadline, then declined on a no-capture read`;
  - `D-014 cap reached on PO2: deadline applies`;
  - `deadline and PO2 unreadable: one payment_unresolved alert`;
  - `continuation counted against the due budget`;
  - `24 h sweep, nothing sent, PO2 unapproved: abandoned`;
  - `window run out, both read APPROVED: captured once (P17)`;
  - `expireCreate per provider order`; `D-02 PO1 DECLINED at capture, crash before PO2: continuation captures PO2, paid_partial, one partial_composite alert`; `single payer_action: awaiting_buyer, unchanged, no continuation pick`; `pack with nothing sent, PO1 reopened after payer_action: not picked, buyer can approve again`; `PO2 APPROVED read before the deadline: not declined`; `PO2 APPROVED read after the deadline with no capture on the unit: declined (case 2b)`.
- `composite.recover.state.test.ts`:
  - `a never-sent prepared PO2 capture is not marked unknown`;
  - `a sent PO2 capture is read first`.
- `composite.webhooks.state.test.ts`: `PO2 event makes only PO2's read-back due`.
- `composite.continuation.adversarial.test.ts`:
  - `return, poll, sweep and webhook at once: one capture per PayPal order`;
  - `crash between captures: terminal within 2 passes after the lease ends`;
  - `decline and capture race on PO2 (both under lockOrderRows): exactly one of declined or capture_requested, never both, never a capture after declined`; `lock order spy`.

Acceptance tests:

- `corepack pnpm vitest run --project state --project adversarial domain/payments`: all pass.
- `corepack pnpm mutation --targets domain/payments/src/due.ts,domain/payments/src/reconcile.ts,domain/payments/src/recover.ts --require-targets`: each at least 80 percent (a narrowed command is allowed, as in CO-G).
- `corepack pnpm test && corepack pnpm lint && corepack pnpm typecheck`: exit 0.

Do not:

- change the DP-2a gate, return, checkout or apply logic beyond calling it;
- touch `refunds.ts`, the transport, safety, the web app or composition;
- abandon a pack while `capture_sent` holds;
- mark a PayPal order `declined` on any read that shows a capture;
- add a dependency.

Evidence for the PR: red summary, pass counts, mutation scores, the PayPal call list of the crash-between-captures test.

Branch: `feat/payments-composite-continuation` Commit: `feat(payments): background paths per provider order and pack continuation (DP-2b)`
