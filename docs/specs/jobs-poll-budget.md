# BU-5: polling that cannot starve checkout of the daily call budget

Task: give the job loop a call budget so reconcile polling and paid-order re-reads never use the calls a buyer's capture needs, and slow the paid re-read in sandbox mode.
Package: `packages/jobs`, `domain/payments` (`due.ts`), `packages/contracts` (`config.ts`, additive) Owner: Sonnet 5.5 builder, effort high (a starved budget blocks money) Reviewer: Opus 5.5 high, mutation check on `due.ts`; Sakthi merges
Wave: W0, starts now. Composition wiring of `callBudget` is done in BU-2. Assumptions: ASM-52 (new), ASM-07, ASM-13.

Goal: each paid order is re-read hourly for 7 days at about two calls a read (GET order, GET capture); six orders use about 288 of a 300-call day and then the gate blocks captures with `budget`. Add to `DomainConfig` (additive): `poll_budget_share` (0.5), `capture_reserve_calls` (30), `reread_paid_every_ms` (dry run 3,600,000; sandbox 21,600,000), `min_call_gap_ms` (500, PERF-9: at most 2 calls a second). `startLoop` takes an optional `callBudget(): Promise<{ remaining_today: number; max_calls_per_day: number } | null>`; null means unlimited (dry run). Before each pass it works out what polling may spend: nothing when `remaining_today <= max(capture_reserve_calls, (1 - poll_budget_share) * max_calls_per_day)`, else the difference, capped by `max_items`. `runDue` takes `{ max_items, allow: 'all' | 'money_only' }` (`money_only` = unknown capture and read-back operations only); priority within a pass stays: capture and read-back unknowns, then creates, then refunds, then abandonment, then paid re-reads last. A throwing `callBudget` skips the pass (fail closed, no calls). The return route's own capture is not routed through the loop and is decided by the gate as today.

Inputs: `packages/jobs/src/loop.ts`, `domain/payments/src/due.ts` (`runDue`, `rereadPaid`), `packages/contracts/src/config.ts` (`DomainConfig`), `packages/safety` `readSafetyStatus` (shape only; jobs does not import safety), nfr.md PERF-9, COST-1.

Outputs: `packages/jobs/src/{loop.ts, budget.ts}`, `domain/payments/src/due.ts`, `packages/contracts/src/config.ts` and its test, tests below. Not `domain/payments/src/{refunds.ts,index.ts}`; not composition.

Order: commit 1 is tests only, run red; then implement.

Acceptance tests:

- `corepack pnpm vitest run --project unit packages/jobs/src/budget.test.ts`: allowance table for remaining 300, 160, 151, 150, 30, 0 with max 300 and share 0.5 gives 100 (capped by max_items), 10, 1, 0, 0, 0; null budget gives max_items.
- `corepack pnpm vitest run --project state domain/payments/src/due.budget.state.test.ts`: `6 paid orders over a simulated sandbox day: re-reads use at most 150 calls and each order is read every 6 h`; `remaining at the reserve: re-reads skipped, an unknown capture is still read`; `money_only pass touches no create, refund, abandonment or re-read work`; `dry-run cadence stays hourly and existing due tests pass unchanged`.
- `corepack pnpm vitest run --project integration packages/jobs/src/loop.budget.integration.test.ts`: fake clock and counting port: never more than 2 calls in any 1 s window; a buyer capture at hour 23 still finds at least `capture_reserve_calls` left.
- `corepack pnpm vitest run --project adversarial domain/payments/src/due.budget.adversarial.test.ts`: `callBudget throws: no call in that pass`; `callBudget returns negative or NaN: treated as 0`; `two loops at once never exceed the allowance together` (shared allowance read under the operation lease).
- `corepack pnpm mutation --targets domain/payments/src/due.ts --require-targets`: at least 80 percent.
- `corepack pnpm test && corepack pnpm lint && corepack pnpm typecheck`: exit 0.

Do not: import `@umsbx/safety` in jobs or payments (the budget is injected); change the gate's reservation; change backoff or the 5 h and 24 h rules; touch composition; connect to PayPal.

Evidence for the PR: red summary; pass counts; the allowance table; mutation score.

Branch: `feat/jobs-poll-budget` Commit: `feat(jobs): budget-aware polling and slower paid re-read in sandbox (BU-5)`
