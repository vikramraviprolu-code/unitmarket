# INT-OPS-B: operator transactions, quick-find and activity log

Task: Find any transaction in seconds, and see who did what, when and from where.
Package: `apps/web` (Money › Transactions, top-bar quick-find, Controls › Activity log and Invariants). Builder: Sonnet 5.5 medium. Reviewer: Opus 5.5 gate.
Items: OPS-B.1 to OPS-B.5, 9 points. Needs UI0, SR1, TR1. Sources: operator items 5, 10, 19; search T3.1, T3.4, T3.5; UX-21.

## Goal

A shared filter bar (chips, presets, URL state, fields hidden per persona) drives the operator Transactions page with the four saved views and CSV. Pressing `/` opens quick-find with results grouped by type. The Activity log lists journal rows with actor, channel, event, time and context, filtered like the API, and a switch-history preset. Controls › Invariants shows the trace verify result, and every timeline shows "verified" or the first broken row.

## Outputs

`apps/web/src/components/FilterBar.tsx` (shared, used later by BUY and SEL), pages `apps/web/src/app/ops/money/transactions`, `apps/web/src/app/ops/controls/activity`, quick-find component in the shell slot, the `ops-money` and `ops-controls` composition modules.

## Acceptance tests (commit 1: tests only, run red)

| Item | Test file | Command | Expected |
|---|---|---|---|
| OPS-B.1 | `apps/web/src/filter-bar.test.tsx` | `pnpm test -- filter-bar` | Chips round-trip through the URL; seller persona never renders the buyer field |
| OPS-B.2 | `apps/web/src/ops-transactions.state.test.ts` | `pnpm test:state -- ops-transactions-page` | Saved views and CSV link use the same query |
| OPS-B.3 | e2e `tests/e2e/quick-find.spec.ts` | `pnpm test:e2e -- quick-find` | `/` then a short ref opens the order page in 2 actions |
| OPS-B.4 | `apps/web/src/ops-activity.state.test.ts` | `pnpm test:state -- ops-activity` | A switch turned off shows operator, MFA, channel web, time; filters narrow |
| OPS-B.5 | `apps/web/src/trace-verify-tile.test.tsx` | `pnpm test -- trace-verify-tile` | Healthy shows verified; a fixture with a broken chain shows the chain and seq |

Branch: `feat/int-ops-b`. Commit: `feat(web): operator transactions, quick-find and activity log (INT-OPS-B)`.
