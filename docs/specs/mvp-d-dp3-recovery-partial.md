# DP-3: refunds per unit's PayPal order and the partial composite message

Task: make every refund read of a composite use the unit's own PayPal order, and tell the buyer of a partial pack, in plain words, what is ready and what was not charged. Keep-what-worked is the default by doing nothing; a refund goes through the paths that already exist; nothing is substituted.
Package: `domain/payments` (`refunds.ts` only), `domain/recovery` (`messages.ts`, `cases.ts` for the message input) Owner: Sonnet 5.5 builder, effort medium ($ for the refund lookups) Reviewer: Opus 5.5 high on `refunds.ts`; Sakthi merges
Wave: MVP-D W3, after DP-2b; parallel with DP-4 (disjoint files). Owner decision: OQ-8 (wording). Coordinator decisions used: OQ-7, OQ-10 (table A). Requirements: D-02 (case opened, message), D-03, ASM-61 (accepted, D-039), nfr P9. DP-2a and DP-2b may go to the host only after this lane merges.

Goal. **Refunds (OQ-10):** `refunds.ts` reads the unit's own provider order wherever it reads PayPal for a refund. Today two places use the order's first provider order (~796, ~1122). A refund of one publisher's unit never changes the other unit, its entitlements, its ledger rows or its read-back. A partial refund never revokes (ASM-61). The refund path itself is unchanged: N refunds for N units, no new operation, header, scope or seal change. **Message (OQ-8, H1):** a `partial_composite` case (raised by DP-2a only when a provider order is `declined`, `failed` or `abandoned`) gets the buyer message "Part of your order did not go through. <ready titles> are ready in your library. You were not charged for <not-charged titles>. If you would rather have a refund for what you paid, tell us on the help page." Titles come from the case's order; there are no internals and no ids. A provider order that is `frozen` is shown as on hold, whether or not a capture was sent for it, and is never named as "not charged": the existing `frozen_order` case covers it. On an order that also has ready items (`paid_partial` with a hold, L-6), that case's buyer message names both: "<held title> is on hold while we check it. <ready titles> are ready in your library." The whole-order text "Your order is on hold…" is kept only when nothing is ready. **Default and refund (OQ-7):** no buyer choice API. Doing nothing keeps what worked; the case follows its existing SLA and closing rules. A buyer who wants a refund uses the existing help-page report on the order. It opens a `payment_unresolved` case (a buyer kind with a 4 h SLA; `composition.server.ts:1181-1190`; `/api/cases` takes no kind). This is the smaller of the two options; adding `refund_requested` to `/api/cases` is cut to the later list. The operator then refunds each captured unit through the existing MFA refund route (`POST /api/refunds`, CO-8, which requests and executes) and closes the case with `close_no_fault`, giving the refund as the reason. The operator does **not** use `offer_refund`: it would park an unexecuted request and block the unit with `refund_in_flight`. No recovery path creates an order, quote, proposal or approval (D-03).

Inputs: DP-2a and DP-2b (provider order per unit, `partial_composite` rule), `domain/payments/src/refunds.ts`, `domain/recovery/src/{cases.ts,messages.ts,rules.ts}`, CO-4, CO-5 and CO-8 refund rules.

Outputs: the DP-3 files in `mvp-d-overview.md` section 4.

Red-first tests (commit 1):

- `domain/payments/src/refunds.composite.state.test.ts`: `refund of the Quayside unit reads the Quayside PayPal order, not the first one` (both read paths); `refund of one publisher leaves the other unit, its entitlements and its ledger untouched`; `partial refund of a unit does not revoke (ASM-61)`; `a frozen sibling provider order does not block this refund`; `full refund of the Harbour unit revokes only Harbour items`.
- `domain/recovery/src/partial-message.state.test.ts`: `paid_partial with PO2 declined: one case, message names the ready title and the not-charged title`; `paid_partial with PO2 frozen: no partial_composite case; the frozen_order message names the held title as on hold and the ready title as ready, never "not charged"`; `frozen order with nothing ready keeps the whole-order hold text`; `a second rule pass opens nothing`; `D-03: across open, rule and resolve, the counts of orders, quotes, proposals and approvals do not change`; `buyer report on a partial order (the composition's openCase path, order id, no kind) opens payment_unresolved beside the partial case`; `operator refunds the captured unit through requestRefund and executeRefund, then close_no_fault: case closed, no refund_in_flight left on the unit`.

Acceptance tests:

- `corepack pnpm vitest run --project state domain/payments/src/refunds.composite.state.test.ts domain/recovery`: all pass.
- `corepack pnpm mutation --targets domain/payments/src/refunds.ts --require-targets`: at least 80 percent (narrowed command allowed as in CO-G).
- `corepack pnpm test && corepack pnpm lint && corepack pnpm typecheck`: exit 0.

Do not: add a buyer choice API, route or auto-close rule (cut, overview section 5); let a buyer action call `requestRefund` or PayPal; propose or create another offer; touch `apply.ts`, `capture.ts`, `return.ts`, `due.ts`, ledger, receipts, the web app or composition; add a dependency.

Evidence for the PR: red summary, pass counts, mutation score, the buyer messages as rendered text.

Branch: `feat/payments-composite-refund-reads` Commit: `fix(payments): composite refunds read the unit's own PayPal order (DP-3)`
