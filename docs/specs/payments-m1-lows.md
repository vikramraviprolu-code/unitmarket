# M1-LOWS: close or defer the low findings of the two POB-M1 reviews

Task: re-check the ten low findings (M1-L1 to M1-L10) against main 660bb62b, fix the ones that are open and need no migration, and write a specific deferral for the rest.
Package: `domain/payments`, `domain/alerts`, `domain/publisher-console` (comment only), `apps/web` (copy and test support) Owner: Sonnet 5.5 builder Reviewer: Opus; the reviewer merges
Lane: M1-LOWS. Decisions in force: D-089, D-096, D-051 (copy: no dash, no italics).

Goal: every finding has a verdict with file and line evidence in `docs/owner/M1-LOWS.md`. Open findings that can be fixed offline, without a migration and without changing money beyond the finding, are fixed test first. Findings that need a migration or an owner decision are not built; each gets a deferral with the risk, the trigger and the cheapest future fix. No new migration.

Fix list (test first, commit 1 red):

- M1-L2 `refunds.ts` bookEntry: `splitRefund` moves inside the try; a RangeError raises the same `ledger_rule_split_` alert and the refund is still booked.
- M1-L4 `payout.ts` settle/sendPayouts: an accepted answer with an empty or blank provider reference is not applied (payout stays `sending`, counted `errored`, logged); a throw while applying an answer no longer aborts the rest of the pass.
- M1-L8 `payout.ts` prepare and `catalogue.ts`: a refusal of a payout already in `sending` uses reason `payout_refused_<id>_<why>_sending` and a cause that says the provider may already hold it. No change to what is sent or cancelled.
- M1-L5 `payout-copy.ts`: the tile "Next payout" becomes "Owed, not yet paid out" and its source line says sales inside their window are included. Figures do not change. CSV row `total_next_payout` is a column contract and is NOT renamed (deferred).
- M1-L9 `search-support.ts`: the restore mode is switched off again before the bulk script ends; a test pins it and pins that no payout is written.
- M1-L1, M1-L3, M1-L10: documented in code, behaviour pinned by tests, no change to money.
- M1-L6, M1-L7: deferral only (migration, owner decision).

Inputs: `domain/payments/src/{refunds,payout,payout-support}.ts`, `domain/ledger/src/parts.ts`, `domain/alerts/src/catalogue.ts`, `apps/web/src/lib/payout-copy.ts`, `apps/web/src/search-support.ts`, migration 0029 (read only).
Outputs: those files, `docs/owner/M1-LOWS.md`, tests: `domain/payments/src/payout.lows.state.test.ts`, `domain/alerts/src/catalogue.golden.test.ts` (one case added), `apps/web/src/payout-copy.golden.test.ts` (three expectations follow the new label, as the spec of M1-L5 says), `apps/web/src/search-support.restore.test.ts`.

Acceptance tests (commit 1 shows the red lines; commit 2 all green):

- `corepack pnpm vitest run --project state domain/payments/src/payout.lows.state.test.ts`: L2, L4, L8 red then green; L1, L3, L10 pinned green.
- `corepack pnpm vitest run --project golden domain/alerts/src/catalogue.golden.test.ts apps/web/src/payout-copy.golden.test.ts`: L8 text and L5 label red then green.
- `corepack pnpm vitest run --project unit apps/web/src/search-support.restore.test.ts`: L9 red then green.
- Neighbours stay green: `domain/payments/src/payout.state.test.ts payout.crash.state.test.ts refunds.complete.state.test.ts refunds.rollback.state.test.ts`, `domain/publisher-console/src/statement-fee.state.test.ts csv-fee.test.ts`, `apps/web/src/payout-pages.source.test.ts`.
- `lint`, `typecheck`, `format:check`, `check:isolation`, `check:no-live-host`, `check:routes`, `check:secrets-names`: exit 0.

Do not: add a migration; touch other packages or `packages/{transport,paypal,safety}`; change a contract; add a dependency; connect to PayPal or any hosted system.
Evidence for the PR: red then green output, the tracker.
Branch: `feat/payments-m1-lows` Commit: `type(payments): <what> (M1-LOWS)`
