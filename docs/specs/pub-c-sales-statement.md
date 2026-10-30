# Spec: publisher sales and statement read models, pages S4 and S5 (PUB-C)

Task: a new pure read-model package `domain/publisher-console` (sales per unit, statement per currency, settlement wording
from stored data) and the pages `/publisher/sales` (S4) and `/publisher/statement` (S5).
Package: `domain/publisher-console` (new), `apps/web` Owner: builder (Sonnet) Reviewer: Opus, money review (sums against
the ledger invariant)
Branch: `feat/publisher-console-pub-c` Commit: `feat(<package>): <what> (PUB-C)` Decisions: D-004, D-041, D-051, D-065
item 36; proposal 3E, 3F, 3G, 4, 6. Depends on: PUB-A1. Common rules: plan section 2.

Goal: a publisher sees each unit it sold and a statement it can match to its PayPal activity, with honest words about where
the money is. Every figure comes from stored rows; nothing is projected.

Package setup: `domain/publisher-console/{package.json,tsconfig.json,src/index.ts}` copied in shape from
`domain/ledger` (dependency `@umsbx/contracts` and `@umsbx/ledger`, workspace only; dev `@umsbx/db`, `@umsbx/runtime`);
add `publisher-console` to the `DOMAIN` list in `eslint.config.mjs` (one line); add the package to `apps/web/package.json`;
run `corepack pnpm install` once to update `pnpm-lock.yaml` (workspace links only, no new external dependency: show the
lock diff is importers only).

Read models (`src/sales.ts`, `src/statement.ts`, `src/settlement.ts`), each taking `SqlExecutor` and the publisher actor
and filtering by `actor.publisher_id` in SQL:

- `salesFor(db, actor)`: one row per `order_units` row of the publisher: date (`captured_verified_at`, else `created_at`),
  order ref last 6, article title, access option, amount, PayPal fee (only when `paypal_fee_minor` is stored, else
  "not reported"), currency, status words. Words: `captured_verified` "Paid", `pending` "Payment pending at PayPal",
  `partially_refunded` "Partly refunded", `refunded` "Refunded", `reversal_suspected` "On hold: payment being checked",
  `reversed` "Reversed", `declined` "Not charged", `mismatch` "On hold: under review", `expected` "Awaiting payment".
  "Not charged" appears only for `declined` (D-051). No buyer id, name or email in the result (PRIV-1).
- `statementFor(db, actor)`: per currency, from `ledger_entries` joined to the publisher's units, summed with
  `publisherBalances` from `@umsbx/ledger` (sales, refunds, reversals, net) plus the sum of `paypal_fee` rows; each line
  links to its order ref. Reconciles: net equals `publisherBalances` net for the same rows (property test).
- `settlementMode(facts)`: pure, from `{ merchant_id, payee_shared, environment, own_merchant_id }` (composition passes
  `own_merchant_id` from config). Modes and sentences: `dryrun` "Dry run: no money moved."; `owner_account` (shared flag or
  equal to the owner id) "Collected into the UnitMarket team's sandbox test account. Not paid out: sandbox demo; UnitMarket
  has no payout mechanism."; `direct` "Paid by PayPal directly into your own sandbox account."; `not_set` "No PayPal account
  is linked yet." Never "paid out" in any other mode.
- Commission line, fixed: "No commission in this demo; planned 20 percent, not implemented."

Pages: S4 table with empty state "No sales yet."; S5 one block per currency, the settlement sentence, the commission line,
the label Sandbox or Dry run from the stored `environment` of the rows (none: from the app environment). Copy in
`apps/web/src/lib/statement-copy.ts`. Engine methods `publisherSales(actor)`, `publisherStatement(actor)`.

Tests first: `domain/publisher-console/src/sales.state.test.ts`, `statement.state.test.ts` (seeded units and ledger rows
for two publishers; sums; fee not reported; held unit never "Not charged"), `statement.property.test.ts` if a property
helper exists in the repo, else a table test of 20 generated cases with a seeded `Rng`; `settlement.test.ts` (each mode);
`publisher-console.adversarial.test.ts` (A never sees B's units or ledger rows, also when B's order ref is requested);
`apps/web/src/statement-copy.golden.test.ts` (copy per settlement mode, empty states, D-051 agreement).

Acceptance: `corepack pnpm install --frozen-lockfile` passes after the lock update; `corepack pnpm test:state
domain/publisher-console apps/web`, `corepack pnpm test:unit domain/publisher-console`, `corepack pnpm test:adversarial
domain/publisher-console`, `corepack pnpm test:golden apps/web`, `corepack pnpm check:isolation`, plan section 3.
Do not: write to any table; touch `domain/ledger`, `domain/payments` or migrations; add CSV (SHOULD, later); edit
`globals.css`; show any figure not read from a stored row.
Evidence: outputs, red run, lock diff summary, a statement screenshot from a dry-run pack if a browser runs, cost line.
