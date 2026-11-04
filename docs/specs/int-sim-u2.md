# INT-SIM-U2: headline "trades became money movements" on /sim/market (SIM)

Task: One headline line on the simulation market dashboard: "10,000 trades became N money movements (T top-ups and P payout items)".
Package: `apps/web/sim-ui/market` in `AIC_Hackathon_UnitMarket` (simulation repo only). Builder: Sonnet 5.5 medium. Reviewer: Opus 5.5 gate.
Items: SIM-U2.1, 1 point (S), cut "must". Source: `/mnt/project-files/upi-learnings/upi-learnings-for-unitmarket.md` recommendation 2 ("100 million payments, 800 settlements"), approved by Vikram 4 Nov (decision 52).

## Goal

Above the existing ledger activity text, `/sim/market` shows one headline sentence built only from the run's own view: `view.trades` (or the trade count the dashboard already shows), `view.ledger_activity.top_ups` and `view.ledger_activity.payout_items`. N = top-ups + payout items. Numbers use the existing `formatInt`. With zero trades the line is hidden. The words come from one copy function, not inline strings, so the golden test pins them. No harness or model change: the counts already exist (`simulation/harness/src/market/market.ts`).

## Outputs

`apps/web/sim-ui/market/headline.ts` (pure function `movementsHeadline(view)`), `apps/web/sim-ui/market/headline.test.ts`, one line in `apps/web/sim-ui/market/MarketDashboard.tsx`. Branch `feat/sim-market-headline`, PR title prefix `[SIM]`.

## Acceptance tests (commit 1: tests only, run red)

| Test | Command | Expected |
|---|---|---|
| `apps/web/sim-ui/market/headline.test.ts` | `pnpm test:module market` (or `pnpm vitest run apps/web/sim-ui/market/headline.test.ts`) | 10,000 trades, 100 top-ups, 98 payout items gives "10,000 trades became 198 money movements (100 top-ups and 98 payout items)."; 0 trades gives `null`; 1 trade, 1 top-up, 0 payouts uses singular words |
| `pnpm lint && pnpm typecheck` | | Green; import rules 4, 5, 10 hold (no simulation import in product screens) |

## Do not

Touch the sandbox repo, the harness, or any product screen; add a dependency.

Commit: `feat(sim-ui): trades to money movements headline on /sim/market (INT-SIM-U2)`.
