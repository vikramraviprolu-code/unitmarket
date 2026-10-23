# Spec: monotonic event time for the access log (CO-5b)

Task: stop a regressed writer clock from rewriting a revoked or ended window (ASM-62, CO-5 review probe P1).
Package: `domain/access-clock` Owner: Sonnet 5.5 builder, effort high (access follows money) Reviewer: Opus 5.5 high; Sakthi merges
Goal: an event inserted without an explicit time is stamped `max(now, latest stored time for that entitlement)`; an explicit time (the sweep's `window_ended`) is stored as given. A delivery event on a revoked window is kept as evidence and does not rewrite the window row. After a revoke or an end, a stepped-back clock earns no credit and moves no `ends_at`.
Inputs: `domain/access-clock/src/events.ts`, `credit.ts`, `compute.ts`, `sweep.ts`; ASM-59, ASM-62.
Outputs: `events.ts` (floor and revoked path), `monotonic.state.test.ts`, extended `refund.property.test.ts`.
Acceptance tests:

- `corepack pnpm vitest run --project state domain/access-clock/src/monotonic.state.test.ts`: 12 pass, including the exact P1 probe (credit 0, `ends_at` unchanged), 1 ms skew, reversal, stepped-back credit, same-instant ties in both orders.
- `corepack pnpm vitest run --project unit domain/access-clock/src/refund.property.test.ts`: 1,000 sequences with a regressing clock; stored times never decrease except `window_ended`.
- `corepack pnpm vitest run domain/access-clock domain/entitlements`: all green, golden files unchanged.

Do not: change golden outputs, touch payments, add a dependency.
Known limits (ASM-62): a clock step back across `ends_at` with nothing written after it can let an operator credit land on a just-ended window; the sweep cadence bounds this. A forward-jumped writer clock stamps later events at the future time (the early window end is pre-existing, `compute.ts` runs the time-end check first).
Evidence for the PR: command output, mutation score on `events.ts` (21 of 21).
Branch: `fix/access-clock-monotonic` Commit: `fix(access-clock): event time is monotonic per entitlement (CO-5b)`
