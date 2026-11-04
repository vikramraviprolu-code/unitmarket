# INT-OPS-C: operator buyer, seller, agent and money pages

Task: A detail page for every buyer, seller and agent key, and a money tab that opens into ledger lines.
Package: `apps/web` (Buyers, Sellers, Agents and API, Money tabs), two operator revoke functions (`domain/mandates`, `packages/security`). Builder: Sonnet 5.5 high. Reviewer: Opus 5.5 gate.
Items: OPS-C.1 to OPS-C.5, 12 points, cut "should". Needs UI0, TR1, SR1 and OPS-A merged. Sources: operator items 11 to 15; UX-09, UX-19 (operator half), UX-20. Includes `int-wave2-conventions.md`.

## Goal

- **OPS-C.1, buyer page** `/ops/buyers/[id]`: one buyer's orders (SR1 session list, filtered by `buyer`), library count, refunds, caps and keys. It needs an MFA session, because it is identity by definition; without MFA it answers "needs your authenticator code".
- **OPS-C.2, seller page** `/ops/sellers/[id]`: offers, sales, payee status and agreement version.
- **OPS-C.3, Agents and API** `/ops/agents`: caps with spent and remaining in money and count, reservations, agent purchases, keys, webhook subscriptions and their deliveries.
  - Actions are **revoke cap** and **revoke key**, each with a reason code, posting to `POST /api/ops/mandates/[id]/revoke` and `POST /api/ops/api-keys/[id]/revoke` (operator session, MFA, CSRF, idempotency key, `risk: 'high'`).
  - The plan says "pause and revoke". `mandates` has no paused state (0021), and adding one is a money-table change, so pause is out. A buyer can revoke and create a new cap. This is the one deviation.
- **OPS-C.4, Money tab** `/ops/money`: problems (from OPS-A), the reconciler state, totals per currency and kind that open a ledger list `/ops/money/ledger?currency=&kind=`, and today's exchange rates.
- **OPS-C.5, money-flow strip on Home**: find, quote, approve, pay, unlock and refund counts for the last 24 hours, plus stuck counts from operation states.

## Domain changes

- `revokeMandateAsOperator(db, deps, {id, operator_id, reason_code})` in `domain/mandates/src/store.ts`. It is the same `FOR UPDATE` and idempotent revoke as `revokeMandate`, without the buyer filter, with the audit actor `operator`.
- `revokeKeyAsOperator(deps, operator, key_id, reason_code)` in `packages/security/src/apikey.ts`, mirroring `revokeKey` without the owner filter.
- Reason codes: `abuse`, `owner_request`, `compromised`, `other`. There is no free text.

## Outputs (only these files)

New:
- pages `apps/web/src/app/ops/buyers/[id]/page.tsx`, `ops/sellers/[id]/page.tsx`, `ops/agents/page.tsx`, `ops/money/ledger/page.tsx`
- routes `apps/web/src/app/api/ops/mandates/[id]/revoke/route.ts`, `apps/web/src/app/api/ops/api-keys/[id]/revoke/route.ts`
- `apps/web/src/ui/ops/{EntitySummary,CapTable,MoneyFlow}.tsx`, `apps/web/src/lib/{ops-entity-view,ops-agents-view,ops-money-view,money-flow-view}.ts`
- the tests below

Changed:
- `domain/mandates/src/store.ts`, `domain/mandates/src/index.ts`, `packages/security/src/apikey.ts`, `packages/security/src/index.ts`
- `apps/web/src/app/ops/money/page.tsx` (UI0), `apps/web/src/app/ops/page.tsx` (strip)
- composition modules `ops-buyers.ts`, `ops-sellers.ts`, `ops-agents.ts`, `ops-money.ts`, `ops-home.ts`
- `apps/web/src/lib/shell-tabs.ts` (`ready: true` for Agents and API)

## Acceptance tests (commit 1: tests only, run red)

| Item | Test file | Command | Expected |
|---|---|---|---|
| OPS-C.1, C.2 | `apps/web/src/ops-entity-view.state.test.ts` | `corepack pnpm vitest run apps/web/src/ops-entity-view.state.test.ts` | Seeded buyer and seller pages list the expected rows; the buyer page without MFA returns only the MFA notice; a seller page shows no buyer identity |
| OPS-C.3 | `apps/web/src/ops-agents.adversarial.test.ts`, `domain/mandates/src/operator-revoke.state.test.ts` | `corepack pnpm vitest run apps/web/src/ops-agents.adversarial.test.ts domain/mandates/src/operator-revoke.state.test.ts` | Both revoke routes need MFA, CSRF and an idempotency key; buyer, seller and bearer callers are refused; a replay returns the stored answer; a revoked cap refuses `buy_unit` with the existing code; a revoked key gets 401 on its next call; the journal shows the operator, channel `web` and the reason code; a second revoke writes no second audit row; an unknown id gives 404 |
| OPS-C.4 | `apps/web/src/ops-money-view.state.test.ts` | `corepack pnpm vitest run apps/web/src/ops-money-view.state.test.ts` | Each total equals the sum of its ledger list per currency and kind; the reconciler state equals the job health read |
| OPS-C.5 | `apps/web/src/money-flow-view.state.test.ts` | `corepack pnpm vitest run apps/web/src/money-flow-view.state.test.ts` | Counts match a seeded journey run; stuck counts equal operations in `unknown` and `sent` past their lease |

Mutation (OPS-C.3 is L): `pnpm mutation --require-targets --targets domain/mandates/src/store.ts,apps/web/src/app/api/ops/mandates/[id]/revoke/route.ts,apps/web/src/app/api/ops/api-keys/[id]/revoke/route.ts --test-cmd "corepack pnpm vitest run apps/web/src/ops-agents.adversarial.test.ts domain/mandates" --threshold 80`. C4 to C7 apply.

## Do not

Add a paused state or any money-table change; change `revokeMandate` or `revokeKey`; show identity without MFA; add a `/api/v1` write.

Branch: `feat/int-ops-c`. Commit: `feat(web): operator buyer, seller, agent and money pages (INT-OPS-C)`.
