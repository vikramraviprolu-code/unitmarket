Task: ORDER-A, a buyer can cancel an unpaid order and resume payment (overnight assumption 29)
Package: domain/payments (cancel.ts, due.ts), apps/web Owner: builder Reviewer: Opus, then coordinator
Branch: feat/order-a-cancel Commit: type(payments|web): <what> (ORDER-A)

Goal: an order in status `awaiting_buyer` that nobody has approved at PayPal can be (a) cancelled by its buyer and (b) resumed.
Nothing changes in capture, refund, webhook, approval, `packages/paypal` or `packages/transport`.

Design (smallest safe)

- Resume needs no domain change. `beginCheckout` already answers an `awaiting_buyer` order with the stored approve link and creates no
  PayPal order. The order page gets a "Continue to payment" button that POSTs the existing `/api/orders/[ref]/checkout` and goes where
  the approval page goes (dry-run page in dry-run, the stored link in sandbox).
- Cancel reuses the abandon transition. `due.ts` `abandonOne` keeps its behaviour; its transaction body moves, unchanged, into an
  exported `abandonLocked(d, order, gone, strict?)`. `strict` (buyer cancel only) adds guards under the row locks: status must be
  `awaiting_buyer` (not `created`); every PayPal order is `prepared` or `awaiting_buyer`; no operation is `sent` or `unknown`; no unit
  has a capture id or verification; then it writes one audit row with the actor. The sweep passes no `strict`, so it is unchanged.
- New `cancel.ts` `cancelOrder(d, {order_id, actor})`, in order: owner only (anyone else, or an unknown id, is `not_found`); status
  `abandoned` is `ok` with `already: true` (idempotent, no second audit row); any status but `awaiting_buyer` is `wrong_state`;
  switch `paypal_outbound` off is `unavailable`; a PayPal order stored as `approved` is `payment_started`; each stored PayPal order is read
  (`getOrder`, same read as the sweep): a capture on any unit or any status except CREATED or VOIDED is `payment_started`; blocked or
  unreadable is `unavailable` (fail closed); not_found counts as gone (nothing can capture). Then `abandonLocked` with `strict`.
- Ledger: untouched. An unpaid order has no ledger rows; the test counts them before and after.
- Race: PayPal approval is only learnt by a read or the buyer return, and a webhook never wakes an `awaiting_buyer` or `abandoned` order
  (webhooks.ts `wantsReadback`). If the buyer approves at PayPal after our read, the order is `abandoned`, nothing is ever captured (the
  return path answers an abandoned order from the database), and the unused PayPal approval lapses at PayPal. This is the sweep's exposure too.
- Route `POST /api/orders/[ref]/cancel`: auth buyer, csrf, rate `order-cancel` 5 per minute per actor, strict schema `{ref}`, body 1 KB,
  risk high. Maps: not_found 404; wrong_state 409; payment_started 409; unavailable 503; ok 200 `{order_ref,status,already}`.
- DP-5b amended narrowly: `OrderStatus.tsx` still has no form, button, approve link or onClick. The only addition is
  `<OrderActions` rendered under `orderActions(view).resume || .cancel`. `orderActions` (pure, lib/order-actions.ts) is true only for
  `awaiting_buyer`; the order view is already null for a non-owner, so the page never renders for one. A state test lists all 10 statuses.

Inputs: docs/design/architecture.md (state machine, INV1 to INV7), domain/payments, apps/web order page.
Outputs: this spec; domain/payments/src/{cancel.ts,due.ts,index.ts,cancel.state.test.ts,cancel.adversarial.test.ts}; apps/web
composition.server.ts (facade `cancelOrder`), route, lib/order-actions.ts (+test), OrderActions.tsx, OrderStatus.tsx, tests.
Do not: change capture, refund, webhook, approval, paypal, transport; touch ledger rows; edit globals.css; add dependencies.

Acceptance tests (run from the worktree)

- `corepack pnpm exec vitest run --project state domain/payments/src/cancel.state.test.ts` passes: cancel ok; units declined; access
  denied; no capture call; no ledger row; audit row with the buyer actor; INV1 to INV7 hold; double cancel idempotent.
- `... cancel.adversarial.test.ts` passes: other buyer, guessed ref, cancel after approval, after capture, PayPal order APPROVED or with a
  capture, unreadable read, switch off, status created, pack with an approved order, cancel then late approval then return captures nothing.
- `... apps/web/src/order-cancel.state.test.ts`, `lib/order-actions.test.ts`, `order-pages.state.test.ts`, `maintenance.adversarial.test.ts`
  pass; `corepack pnpm check:routes` lists the new route.
- `due.state.test.ts`, `due.notfound.state.test.ts`, `due.survivors.state.test.ts` pass unchanged (the sweep is not changed).
- lint, typecheck, format check, check:isolation, check:no-live-host, check:secrets-names pass; `@umsbx/web` build passes.
  Evidence for the PR: command output (counts), the red run of commit 1.
