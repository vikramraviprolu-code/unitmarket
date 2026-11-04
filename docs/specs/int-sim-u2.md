# INT-SIM-U2: headline "trades became money movements" on /sim/market (SIM), round 2

Task: One headline line on the simulation market dashboard: "10,000 trades became N money movements (T top-ups and P payout items)."
Package: `apps/web/sim-ui/market` in `AIC_Hackathon_UnitMarket` (simulation repo only). Builder: Sonnet 5.5 medium. Reviewer: Opus 5.5 gate.
Items: SIM-U2.1, 1 point (S), cut "must". Source: `/mnt/project-files/upi-learnings/upi-learnings-for-unitmarket.md` recommendation 2, approved by Vikram on 4 Nov (decision 52). Round 2 answers `sim-u2-scorecard.md` findings 1 to 6.

## Goal

`/sim/market` shows one headline sentence built only from the run's view. The inputs are `view.trades`, `view.ledger_activity.top_ups` and `view.ledger_activity.payout_items` (`packages/contracts/src/market.ts` lines 107, 118, 121). N = top-ups + payout items. Numbers use the existing `formatInt`.

The words come from one pure function, `movementsHeadline(view): string | null`, which returns `null` when `view.trades` is 0.

The line is a `<p className="text-sm" data-testid="movements-headline">`. It sits in the fees section, directly after the `fee-headline` or `fee-early` paragraph (`MarketDashboard.tsx` lines 362 to 372) and before the three `FeePanel`s. It is not rendered when the function returns `null`. There is no harness, contract or model change.

## Exact strings

| trades | top-ups | payout items | Output |
|---|---|---|---|
| 10000 | 100 | 98 | `10,000 trades became 198 money movements (100 top-ups and 98 payout items).` |
| 1 | 1 | 0 | `1 trade became 1 money movement (1 top-up and 0 payout items).` |
| 2 | 1 | 1 | `2 trades became 2 money movements (1 top-up and 1 payout item).` |
| 5 | 0 | 0 | `5 trades became 0 money movements (0 top-ups and 0 payout items).` |
| 0 | any | any | `null` |

Singular only for exactly 1: trade, money movement, top-up and payout item.

## Outputs (only these files)

New:
- `apps/web/sim-ui/market/headline.ts`
- `apps/web/sim-ui/market/headline.test.ts`
- `docs/specs/sim/sim-market-headline.md` (this spec, copied in the build commit)

Changed:
- `apps/web/sim-ui/market/MarketDashboard.tsx` (one paragraph)
- `apps/web/app/sim/market/market.integration.test.tsx` (one assertion)
- `docs/decision-log.md`: one row in the latest table, as follows. Date `4 Nov 2026`. Decision `UPI learnings: what to build (decision 52)`. Options `build items 1 to 5; build item 2 only; build none`. Choice `Build item 2 only: one headline line on /sim/market; items 1 and 3 are pitch slides; items 4 and 5 go to the post-12-Nov backlog`. Reason `small, simulation only, makes the pooling result readable`. Owner `Vikram`.

Branch `feat/sim-market-headline`, PR title prefix `[SIM]`.

## Acceptance tests (commit 1: tests only, run red)

| Test | Command | Expected |
|---|---|---|
| `apps/web/sim-ui/market/headline.test.ts` | `corepack pnpm vitest run apps/web/sim-ui/market/headline.test.ts` | Each row of the table above, exact string or `null` |
| `apps/web/app/sim/market/market.integration.test.tsx` | `corepack pnpm vitest run apps/web/app/sim/market/market.integration.test.tsx` | With a run of trades greater than 0, `movements-headline` holds the function's string; with 0 trades it is absent |
| Regression | `corepack pnpm test:module ui-sim` | Green |
| `corepack pnpm lint && corepack pnpm typecheck` | | Green; import rules 4, 5 and 10 hold (no simulation import in product screens) |

## Safety

Offline and simulation only: no network call, no PayPal, no credential, `SIM_INPROCESS=1`. The gitleaks pre-commit hook (lefthook) runs on the commit.

## Do not

Touch the sandbox repo, the harness, the contracts or any product screen; add a dependency.

Commit: `feat(sim-ui): trades to money movements headline on /sim/market (INT-SIM-U2)`.
