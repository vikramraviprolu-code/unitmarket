# INT-OPS-B: operator transactions, quick-find and activity log

Task: Find any transaction in seconds, and see who did what, when and from where.
Package: `apps/web` (shared filter bar, Money › Transactions, the `/` quick-find, Controls › Activity and Invariants, the timeline verified mark). Builder: Sonnet 5.5 medium. Reviewer: Opus 5.5 gate.
Items: OPS-B.1 to OPS-B.5, 9 points, all "must". Needs UI0, SR0 (with `REFUSED_FIELDS`), SR1 and TR1 merged. Sources: operator items 5, 10, 19; search T3.1, T3.4, T3.5; UX-21. Includes `int-wave2-conventions.md`. Round 2 passed 11/12 (`ops-scorecard.md`); build notes below override the text above where they differ.

## Goal

**OPS-B.1, the filter bar.** One shared filter bar: chips, presets, and state kept in the URL. Its logic is `lib/filter-bar-view.ts`: URL to chips to the `TxnQuery` URL map, with comma lists as in SR0.
- Fields are hidden per persona by `REFUSED_FIELDS` from `packages/contracts/src/txn-query.ts` (B1). SR0's spec now exports that const and `scopeQuery` reads it, so the bar and the server share one table and the bar never offers a field the server refuses with `field_not_allowed`. If SR0 merged without it, stop and report.
- Status chips use SR0's `STATUS_GROUPS` words.
- BUY and SEL reuse the bar.

**How pages read lists (B4).** The Transactions and Activity pages are server shells that mount a client table. The table calls the existing session route through `getJson` in `lib/client-api.ts`: `GET /api/ops/transactions` (SR1) and `GET /api/ops/activity` (TR1). So the cursor hash `h` and `withOpsIdentity` stay in the route handlers, and nothing is copied. The view logic in `lib/*-view.ts` is tested against those routes' answers.

**OPS-B.2, Transactions.** `/ops/money/transactions` lists `GET /api/ops/transactions` (identity only with MFA), with SR1's four saved views as presets. The CSV button calls the session export of the same query.

**OPS-B.3, quick-find.** Pressing `/` in the shell slot opens quick-find over `GET /api/ops/find`, with results grouped Orders, Sellers, Offers, Keys, and Buyers (MFA only).
- QuickFind mounts only in the operator shell (B6). The buyer and seller shells render the slot without it and never call `/api/ops/find`.
- Enter on the first Orders hit navigates to `/ops/money/orders/[ref]` (OPS-A's page). "2 actions" means `/` and Enter; typing the ref is not counted (B2).
- The typed text is never logged.

**OPS-B.4, Activity log.** `/ops/controls/activity` lists `GET /api/ops/activity` with actor, channel, event, time and context, using TR1's filters and paging. A "switch history" preset filters `event_type` prefix `safety_switches.`.
- Without MFA (B5) the page shows TR1's identity-free shape, and the filter bar does not offer `actor_id`, so the page never triggers TR1's 403.
- With MFA it shows actor ids and `mfa`.

**OPS-B.5, verify tile and timeline mark.**
- **Tile (B3).** Controls › Invariants (`/ops/controls/invariants`) holds the trace verify tile and a link to `/ops/money#ops-invariants` for the platform invariants (B7). The tile has a "Run verify" button; it does not run on every page render. The button calls `traceVerifyDetail(actor)` in `ops-controls.ts`, a new read that runs TR0's in-process verify (the export `scripts/trace-verify.mjs` calls) on the app database, operator session only. It returns `{ok, chains, rows, seals, lines}`, where `lines` holds TR0's `drift <table> <id> <column>` and broken-chain lines. TR1's v1 verify route stays counts only. If the TR0 export is not reachable from `ops-controls.ts` the way TR1's reads reach the database there, stop and report.
- **Mark (S1).** OPS-B owns the "verified" mark in `src/ui/Timeline.tsx`, for every timeline. It is derived from the TR1 entries' own `verified` flags: all true gives "verified"; otherwise "first broken row at seq N" for the lowest `seq` with `verified: false`. No extra call. OPS-A does not draw it.

**Composition modules (S3).** Transactions page: `ops-money.ts` (page props only; the list comes from the route). Activity and Invariants pages: `ops-controls.ts`, where TR1's reads live.

## Outputs (only these files)

New:
- `apps/web/src/ui/FilterBar.tsx`, `apps/web/src/ui/ops/{QuickFind,ActivityTable,TransactionsTable,VerifyTile}.tsx`
- `apps/web/src/lib/{filter-bar-view,quick-find-view,activity-view,transactions-view,verify-view}.ts`
- pages `apps/web/src/app/ops/money/transactions/page.tsx`, `ops/controls/activity/page.tsx`, `ops/controls/invariants/page.tsx`
- the tests below

Changed:
- `apps/web/src/ui/shell/SearchSlot.tsx` (hosts QuickFind in the operator shell only)
- `apps/web/src/ui/Timeline.tsx` (verified mark)
- composition modules `ops-money.ts`, `ops-controls.ts` (read functions only; `traceVerifyDetail`)
- `apps/web/src/flow-a11y.state.test.ts` (adds the three pages)

No API, domain or migration change: every route used already exists from SR1 and TR1.

## Acceptance tests (commit 1: tests only, run red)

| Item | Test file | Command | Expected |
|---|---|---|---|
| OPS-B.1 | `apps/web/src/filter-bar-view.golden.test.ts`, `apps/web/src/filter-bar.adversarial.test.ts` | `corepack pnpm vitest run apps/web/src/filter-bar-view.golden.test.ts apps/web/src/filter-bar.adversarial.test.ts` | 20 URL cases round-trip through chips and back unchanged. For each `REFUSED_FIELDS` key, the offered fields are the full set minus that entry, so a seller never gets `buyer`, `seller`, `agent_key`, `environment` or `flags`. For every field and principal, the const agrees with `scopeQuery` (refused gives 400, offered does not). Status chip words equal `STATUS_GROUPS`. A URL with a refused field drops it and never sends it |
| OPS-B.2 | `apps/web/src/ops-transactions-view.state.test.ts` | `corepack pnpm vitest run apps/web/src/ops-transactions-view.state.test.ts` | Each saved view gives SR1's seeded counts (4, 2, 5, 3); the CSV request carries the same canonical query as the list; with no MFA the rows have no buyer or provider id; the page source has no `fetch(` outside `getJson` |
| OPS-B.3 | `apps/web/src/quick-find-view.test.ts`, `apps/web/e2e/quick-find.spec.ts` | `corepack pnpm vitest run apps/web/src/quick-find-view.test.ts`; `corepack pnpm --filter @umsbx/web test:e2e quick-find.spec.ts` | Groups render in the fixed order, with Buyers absent without MFA; the first Orders hit's href is `/ops/money/orders/<ref>`. The buyer and seller shell source holds no QuickFind and no `/api/ops/find`. e2e: `/`, a short ref, then Enter changes the URL to `/ops/money/orders/<ref>` (the page itself is checked in OPS-A's journeys) |
| OPS-B.4 | `apps/web/src/activity-view.state.test.ts` | `corepack pnpm vitest run apps/web/src/activity-view.state.test.ts` | On an MFA session a switch turned off shows the operator, `mfa`, channel `web` and the time. On a no-MFA session the rows are identity-free and `actor_id` is not offered. Filters narrow; the switch-history preset lists only switch events; the next-page link carries TR1's cursor unchanged |
| OPS-B.5 | `apps/web/src/verify-view.state.test.ts` | `corepack pnpm vitest run apps/web/src/verify-view.state.test.ts` | A healthy database gives "verified" with counts; a broken-chain fixture names the chain and seq; a drift fixture names the table, id and column; buyer and seller sessions are refused. The mark: all-verified entries give "verified", and entries with `verified: false` at seq 7 and 9 give "first broken row at seq 7" |
| a11y | `apps/web/src/flow-a11y.state.test.ts` | `corepack pnpm vitest run apps/web/src/flow-a11y.state.test.ts` | The text-read check passes for the three pages |

No L item, so no mutation target. C4 to C7 apply.

## Build notes (round 2, binding)

- N-B1: "Run verify" is a link to `/ops/controls/invariants?verify=1`. The server page calls `traceVerifyDetail` only when that parameter is present. No route and no server action (a server action would bypass `withRoute`).
- N-B2: buyer and seller sessions never reach the verify call (the page refuses them first).

## Do not

Call a route other than SR1's and TR1's; build a second filter parser or a second refused-field list; show identity without MFA; log the quick-find text; run verify on every page render.

Branch: `feat/int-ops-b`. Commit: `feat(web): operator transactions, quick-find and activity log (INT-OPS-B)`.
