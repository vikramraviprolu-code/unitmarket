# Spec: sales page totals agree with the statement (PUB-F1)

Task: a totals row on the publisher sales page (S4) read from the statement (S5) read model, and one cross check test.
Package: `domain/publisher-console` (read model), `apps/web` (page, copy, test) Owner: builder (Sonnet) Reviewer: Opus
Branch: `feat/pub-f1` Commit: `feat(web): <what> (PUB-F1)` Closes: memo Q22; traceability MT-2, MT-3 (sales vs statement part), P-E2 (totals row only).
Depends on: PUB-C merged. Read only, publisher scoped, no money path file, no new class, no new dependency, no `globals.css` change.

Goal: S4 shows one totals row per currency and stored environment: paid units, gross, refunds, reversals, net (gross minus refunds
minus reversals) and the PayPal fee beside the net, never subtracted. The figures are the statement block figures, so S4 and S5
carry the same numbers by construction. One test builds a world and proves every S4 total equals the S5 figure where both are
defined, and pins each place where they differ.

Mismatch (assumption 30): UNCHANGED. A `mismatch` unit is still listed on S4 (it is counted there, with the existing "under
review" note) and still has no ledger sale row, so it is in no S5 block and in no totals row. `isCountedSale` and
`MISMATCH_NOTE` are not touched. The totals row follows the ledger, so it leaves the unit out like S5 does.

Inputs: `StatementBlock` (`statement.ts`), `salesFor`, `engine.publisherSales`, `engine.publisherStatement`.
Outputs:

1. `domain/publisher-console/src/statement.ts`: `StatementBlock.units_sold` (count of distinct units with a ledger sale row).
2. `domain/publisher-console/src/totals.ts` (new) and `index.ts`: pure `salesTotals(blocks)`, one `SalesTotal` per block.
3. `apps/web/composition.server.ts`: re-export `salesTotals` and `SalesTotal`.
4. `apps/web/src/lib/statement-copy.ts`: totals heading, columns and note; `apps/web/src/golden/statement-copy.golden.txt` and
   `statement-copy.golden.test.ts` pin them.
5. `apps/web/src/app/publisher/sales/page.tsx`: totals table under the sales table; fee text through `feeText` as on S5.
6. `apps/web/src/publisher-sales-statement.integration.test.ts` (new): the cross check.

Cross check world (PGlite, rows written directly): two publishers; USD dry run with a plain sale, a partial refund, a full
refund, a reversal, a held unit (`reversal_suspected`) and a mismatch unit; USD sandbox with a fee and a partial refund; EUR dry
run; a second publisher with a USD sale and a mismatch only block. Expectations come from `order_units` (S4 side) and from the
ledger (S5 side), not from the totals function.

Documented differences, each pinned: (a) a mismatch unit is a listed row on S4 and in `mismatch_units` on S5, in no totals row
(S4 listed count minus paid units equals `mismatch_units`); (b) a publisher with only mismatch units has S4 rows and no totals
row; (c) the dry run and sandbox blocks never add into each other; (d) the PayPal fee is beside the net, never inside it.

Acceptance tests (run in the worktree, one at a time under the shared lock):

- `corepack pnpm exec vitest run --project integration apps/web/src/publisher-sales-statement.integration.test.ts` : all pass
  (red before the implementation: `salesTotals` is not exported).
- `corepack pnpm exec vitest run --project golden apps/web/src/statement-copy.golden.test.ts` : pass with the new lines.
- `corepack pnpm exec vitest run --project state domain/publisher-console apps/web/src/publisher-console.state.test.ts` : pass.
- `corepack pnpm lint`, `corepack pnpm typecheck`, `corepack pnpm check:isolation`, `corepack pnpm --filter @umsbx/web build` : clean.

Do not: change how mismatch is counted; touch payments, ledger, db or safety packages; add a dependency or a CSS class; show a
buyer; write an environment word by hand.
Evidence for the PR: red output, green output, the check outputs.
