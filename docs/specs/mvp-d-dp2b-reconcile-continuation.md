# DP-2b: background paths per provider order and pack continuation after the first capture

Task: make reconcile, the due pass, startup recovery and webhooks work per provider order, and make sure a pack whose first capture was sent always finishes: every remaining approved PayPal order is captured once, or ends not charged, never abandoned.
Package: `domain/payments` (`reconcile.ts`, `due.ts`, `recover.ts`, `webhooks.ts`) Owner: Sonnet 5.5 builder, effort high ($) Reviewer: Opus 5.5 high, diff review plus mutation checks; Sakthi merges
Wave: MVP-D W2b, after DP-2a. Coordinator decisions used: OQ-4, OQ-6 (table A). Requirements: P3, P4, P17, REL-2, REL-3, D-014/D-018, D-020, ASM-75, INV5, C-11 and C-12 (composite form). Do not deploy to the host before DP-3 merges.

Goal. **Per provider order:** `readAndApply` (`reconcile.ts:46`) and the paid re-read read every provider order of the order by its stored id and apply each to its own slice. `expireCreate` (`due.ts:502`) resends an unknown create with its own `umsC-<po_ref>` inside the 5 h window. The capture retry (`due.ts:351`, `:375-399`, `:407`) works per provider order with its own operation and key. `abandonOne` (`due.ts:556-560`, `:582`) reads every provider order. Startup recovery (`recover.ts` `IN_FLIGHT`, `UNPOLLED_ORDERS`) selects by provider order state as well as order status. A webhook (`webhooks.ts:279`) makes only the read-back of the provider order it names due; a capture id leads to its unit's provider order. No call inside a transaction (P14); locks as DP-2a. **Pack continuation (H2):** once any capture of a pack was sent, the order is no longer `awaiting_buyer`, so the return handler stops acting. The due pass therefore owns every remaining `approved` provider order. It reads it fresh; if the read shows APPROVED and the match holds, it captures through the one compare-and-set path with that provider order's own key (D-014 cap per provider order), then reads back. If the read shows no approval any more (VOIDED, or PayPal no longer offers the capture), that provider order becomes `declined` (not charged) and the order `paid_partial`. It keeps trying inside the reconcile window and never abandons a pack once a capture was sent. **24 h sweep and pack window:** a pack with no capture sent is captured by the sweep only when every provider order reads APPROVED and matches (P17, once). Otherwise every provider order is `abandoned` and nothing is charged. The pack approval window of DP-2a is also enforced here, for buyers who never come back.

Inputs: DP-2a (states, keys, `deriveOrderStatus`, `lockOrderRows`), `domain/payments/src/{reconcile,due,recover,webhooks}.ts`, CO-2 webhook rules, D-014, D-018.

Outputs: the DP-2b files in `mvp-d-overview.md` section 4.

Red-first tests (commit 1):

- `composite.due.state.test.ts`: `PO1 captured, process stops before PO2 capture: the next due pass captures PO2 once with umsK-<ref>-p2`; `kill switch tripped between the two captures: PO2 blocked, nothing changes; after reset exactly one PO2 capture`; `lost lease on PO2 capture: after lease end one resend with the same key, one capture`; `PO2 read shows VOIDED after PO1 captured: PO2 declined, order paid_partial, partial_composite alert`; `D-014 cap per provider order: PO2 spends its own keys`; `24 h sweep, PO2 never approved, no capture sent: abandoned, zero capture calls`; `24 h sweep, both approved, buyer never returned: two captures once`; `pack window enforced by the due pass`; `expireCreate resends the unknown PO2 create with its own key`; `paid re-read reads both provider orders`.
- `composite.recover.state.test.ts`: `startup recovery finds a sent PO2 capture of a paid_partial-in-flight order and reads it first`; `UNPOLLED provider orders of an unresolved order are polled`.
- `composite.webhooks.state.test.ts`: `PAYMENT.CAPTURE.COMPLETED for PO2 makes only PO2's read-back due`; `CHECKOUT.ORDER.APPROVED for PO2 on an awaiting order: no_op (return path owns it)`.
- `composite.continuation.adversarial.test.ts`: `return, poll, sweep and webhook on one pack at once: one capture per provider order, one sale each`; `a crash between the two captures, then 3 due passes: terminal within 2 passes after the lease ends`; `lock order spy for the continuation path`.

Acceptance tests:

- `corepack pnpm vitest run --project state --project adversarial domain/payments`: all pass, including the titles above.
- `corepack pnpm mutation --targets domain/payments/src/due.ts,domain/payments/src/reconcile.ts,domain/payments/src/recover.ts --require-targets`: each at least 80 percent (narrowed test command allowed as in CO-G).
- `corepack pnpm test && corepack pnpm lint && corepack pnpm typecheck`: exit 0.

Do not: touch the return, checkout, capture or apply logic beyond calling it; touch `refunds.ts`, the transport, safety, the web app or composition; abandon a pack after a capture was sent; capture a provider order without a fresh APPROVED read; add a dependency.

Evidence for the PR: red summary, pass counts, mutation scores, the provider-call list of the crash-between-captures test.

Branch: `feat/payments-composite-continuation` Commit: `feat(payments): background paths per provider order and pack continuation (DP-2b)`
