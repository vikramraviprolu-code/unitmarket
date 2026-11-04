# Spec: fee on top, ledger split, payout after the refund window, statement (POB-M1)

Task: the buyer pays the publisher's price plus UnitMarket's fee. The money lands in the collection account. After the refund window of a
sale closes, the publisher's share is paid out to their linked PayPal, in dry run.
Package: `domain/catalogue`, `domain/ledger`, `domain/payments`, `domain/publisher-console`, `packages/db` (migration 0021),
`packages/jobs`, `apps/web` Owner: builder (Sonnet) Reviewer: Opus (money out, one round)
Branch: `feat/pob-m1-fee-and-payout` Commit: `feat(<package>): <what> (POB-M1)` Decision: D-089. Journey steps J9, J11 to J14.

Goal: a fee on top without changing how quotes, approvals, orders, browse and discovery read a price. The offer's listed price IS the
buyer price (seller price plus fee). The split is stored beside it and carried to the ledger at capture. A payout is created per
publisher and currency when its sales are due. Offline only: this lane adds NO real PayPal call.

Design (builder confirms against the code, tells the coordinator before deviating):

- Migration 0021 (forward only): `fee_settings` (append only: fee_bps 0 to 5000, set_by, set_at, reason; the latest row rules;
  seeded 1000 = 10 percent); `offer_price_parts` (offer id, version, option, seller_minor, fee_minor, fee_bps; seeded offers have
  fee 0 so demo prices and totals do not move); `payouts` (id, publisher_id, currency, amount_minor, state `due`, `sent`, `confirmed`,
  `failed`, `cancelled`, environment, idempotency key, created_at, updated_at) and `payout_items` (payout_id, order_unit_id, seller_minor);
  an `order_unit_parts` copy of the parts at the moment the order is created, so a later fee change never alters a sale.
- Domain: `applyFee(seller_minor, fee_bps)` returns {seller_minor, fee_minor, buyer_minor}, fee rounded half away from zero, fee 0 gives
  buyer equals seller. Exported from `@umsbx/catalogue` as the one function every caller uses, and as an injectable `FeePolicy` port
  (`feeFor(seller_minor, currency)`) that the web import (POB-I1) calls at publish. Operator action `setFee` (second factor, reason, audit).
- Ledger: at capture verification the sale row stays the gross buyer total (INV1 keeps holding); new rows of new kinds record `fee` and
  `payable` (seller_minor) per unit. A refund reverses sale, fee and payable in proportion; a partial refund rounds half away from zero
  and the parts always sum to the refund. Existing invariants INV1 to INV7 still hold and a new INV8 says per unit sale equals fee plus payable.
- Payout: a job (`packages/jobs`) creates a `due` payout when a unit's access window has ended, no refund request is open and the unit
  was never refunded in full; it sums per publisher and currency, sends through a `PayoutPort` (contracts) whose only implementation in
  this lane is the dry run (deterministic ids, no network), idempotent by key. Refund after payout is out of scope: the unit's payable
  is already paid, the ledger records a `payout_adjustment` the operator sees as an alert. State plainly in the PR how it behaves.
- Statement and screens: the publisher statement and sales page show sale, fee, owed and paid out per currency; Operations shows payouts due,
  sent and failed. Seller statements and CSV keep the original currency. Copy rules D-051.

Tests first (commit 1, run red): `domain/catalogue/src/fee.test.ts` (rounding table, zero fee), `packages/db/src/migration-0021.state.test.ts`,
`domain/ledger/src/fee-split.state.test.ts` (capture, full and partial refund, invariants incl. INV8), `domain/payments/src/payout.state.test.ts`
(not due inside the window, due after, one payout per publisher and currency, idempotent, refund inside the window cancels, dry run only),
`domain/publisher-console/src/statement-fee.state.test.ts`, `apps/web/src/fee-setting.state.test.ts`, and a pin test that quote, approval and order
amounts for a fee 0 offer are byte for byte the same as today.

Acceptance (run, paste output): `corepack pnpm vitest run domain/catalogue domain/ledger domain/payments domain/publisher-console packages/db apps/web/src/fee-setting`
all pass with the red run shown first; `check:isolation check:no-live-host check:routes`, lint, typecheck, format check, six suites pass;
`rg "api-m.sandbox|payouts" packages/transport packages/paypal` shows no new PayPal path.
Do not: touch `packages/transport`, `packages/paypal`, `packages/safety`, approval scopes or any real call; add a dependency; copy code from the
simulation; change a price shown for an existing seeded offer.
Evidence for the PR: outputs, red run, the ledger rows for one sale with fee, one full refund and one partial refund.
