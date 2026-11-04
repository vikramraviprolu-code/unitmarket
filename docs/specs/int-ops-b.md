# INT-OPS-B: operator transactions, quick-find and activity log

Task: Find any transaction in seconds, and see who did what, when and from where.
Package: `apps/web` (shared filter bar, Money › Transactions, the `/` quick-find, Controls › Activity and Invariants). Builder: Sonnet 5.5 medium. Reviewer: Opus 5.5 gate.
Items: OPS-B.1 to OPS-B.5, 9 points, all "must". Needs UI0, SR1 and TR1 merged. Sources: operator items 5, 10, 19; search T3.1, T3.4, T3.5; UX-21. Includes `int-wave2-conventions.md`.

## Goal

**OPS-B.1, the filter bar.** One shared filter bar: chips, presets, and state kept in the URL. Its logic is `lib/filter-bar-view.ts`: URL to chips to `TxnQuery`, with comma lists as in SR0.
- Fields are hidden per persona by the same role table as SR0's `scopeQuery`, so the bar never offers a field the server would refuse with `field_not_allowed`.
- Status chips use SR0's `STATUS_GROUPS` words.
- BUY and SEL reuse the bar.

**OPS-B.2, Transactions.** `/ops/money/transactions` lists `GET /api/ops/transactions` (identity only with MFA), with SR1's four saved views as presets. The CSV button calls the session export of the same query.

**OPS-B.3, quick-find.** Pressing `/` in the shell slot opens quick-find over `GET /api/ops/find`, with results grouped Orders, Sellers, Offers, Keys, and Buyers (MFA only). Enter on the first Orders hit opens `/ops/money/orders/[ref]`.

**OPS-B.4, Activity log.** `/ops/controls/activity` lists `GET /api/ops/activity` with actor, channel, event, time and context, using TR1's filters and paging. A "switch history" preset filters `event_type` prefix `safety_switches.`. Without MFA the page shows TR1's identity-free shape.

**OPS-B.5, verify tile.** Controls › Invariants shows the `trace_verify` result: ok with counts, or the first broken chain and seq. Every timeline (TR1 entries, through UI0's `Timeline`) shows "verified" or "first broken row at seq N".

## Outputs (only these files)

New:
- `apps/web/src/ui/FilterBar.tsx`, `apps/web/src/ui/ops/{QuickFind,ActivityTable,VerifyTile}.tsx`
- `apps/web/src/lib/{filter-bar-view,quick-find-view,activity-view,verify-view}.ts`
- pages `apps/web/src/app/ops/money/transactions/page.tsx`, `ops/controls/activity/page.tsx`, `ops/controls/invariants/page.tsx`
- the tests below

Changed:
- `apps/web/src/ui/shell/SearchSlot.tsx` (hosts QuickFind)
- `apps/web/src/ui/Timeline.tsx` (verified mark)
- composition modules `ops-money.ts`, `ops-controls.ts` (read functions only)

No API, domain or migration change: every route used already exists from SR1 and TR1.

## Acceptance tests (commit 1: tests only, run red)

| Item | Test file | Command | Expected |
|---|---|---|---|
| OPS-B.1 | `apps/web/src/filter-bar-view.golden.test.ts`, `apps/web/src/filter-bar.adversarial.test.ts` | `corepack pnpm vitest run apps/web/src/filter-bar-view.golden.test.ts apps/web/src/filter-bar.adversarial.test.ts` | 20 URL cases round-trip through chips and back unchanged. For buyer, seller and operator, the offered fields equal SR0's allowed set, so a seller never gets `buyer`, `agent_key`, `environment` or `flags`. Status chip words equal `STATUS_GROUPS`. A URL with a refused field drops it and never sends it |
| OPS-B.2 | `apps/web/src/ops-transactions-view.state.test.ts` | `corepack pnpm vitest run apps/web/src/ops-transactions-view.state.test.ts` | Each saved view gives SR1's seeded counts (4, 2, 5, 3); the CSV request carries the same canonical query as the list; with no MFA the rows have no buyer or provider id |
| OPS-B.3 | `apps/web/src/quick-find-view.test.ts`, `apps/web/e2e/quick-find.spec.ts` | `corepack pnpm vitest run apps/web/src/quick-find-view.test.ts`; `corepack pnpm --filter @umsbx/web test:e2e quick-find.spec.ts` | Groups render in the fixed order, with Buyers absent without MFA. e2e: `/`, then a short ref, then Enter opens the order page in 2 actions |
| OPS-B.4 | `apps/web/src/activity-view.state.test.ts` | `corepack pnpm vitest run apps/web/src/activity-view.state.test.ts` | A switch turned off shows the operator, `mfa`, channel `web` and the time; filters narrow; the switch-history preset lists only switch events; the next-page link carries TR1's cursor unchanged |
| OPS-B.5 | `apps/web/src/verify-view.test.ts` | `corepack pnpm vitest run apps/web/src/verify-view.test.ts` | A healthy result gives "verified" with counts; a broken-chain fixture names the chain and seq; a drift fixture names the table and column |

No L item, so no mutation target. C4 to C7 apply.

## Do not

Call a route other than SR1's and TR1's; build a second filter parser; show identity without MFA; log the quick-find text.

Branch: `feat/int-ops-b`. Commit: `feat(web): operator transactions, quick-find and activity log (INT-OPS-B)`.
