# INT-OPS-C: operator buyer, seller, agent and money pages

Task: A detail page for every buyer, seller and agent key, and a money tab that opens into ledger lines.
Package: `apps/web` (Buyers, Sellers, Agents and API, Money tabs), two operator revoke functions (`domain/mandates`, `packages/security`). Builder: Sonnet 5.5 high. Reviewer: Opus 5.5 gate.
Items: OPS-C.1 to OPS-C.5, 12 points, cut "should". Needs UI0, TR1, SR1 and OPS-A merged (OPS-A creates the Buyers landing page, S2). Sources: operator items 11 to 15; UX-09, UX-19 (operator half), UX-20. Includes `int-wave2-conventions.md`. Round 2: fixes S2, S3 and C1 to C7 of `ops-scorecard.md`.

## Identity rule for this lane (C2)

Every page here follows C3. Without MFA, a page uses TR1's identity-free rule:
- no buyer id or name ("a buyer");
- agent key and API key ids as `"…" + last 4`;
- `capture_id` and `refund_id` as `"…" + last 4`.

With MFA the full values show. The buyer page (OPS-C.1) needs MFA outright. Every action needs MFA.

## Goal

- **OPS-C.1, buyer page** `/ops/buyers/[id]`: one buyer's orders (SR1 session list, filtered by `buyer`), library count, refunds, caps and keys. It needs an MFA session, because it is identity by definition; without MFA it answers "needs your authenticator code".
- **OPS-C.2, seller page** `/ops/sellers/[id]`: offers, sales, payee status and agreement version. It shows no buyer identity.
- **OPS-C.3, Agents and API** `/ops/agents`: caps with spent and remaining in money and count, reservations, agent purchases, keys, webhook subscriptions and their deliveries, under the identity rule above.
  - **Webhook subscriptions (C1).** The read selects only `id`, `owner_kind`, the URL **host** (parsed from `url`; path and query never leave the read), `event_types`, `created_at`, `disabled_at`, and the last delivery's status and `last_error`. It never selects `signing_secret` (stored in plain text, `0020_webhooks.sql:25`), and the key read never selects `api_keys.secret_hash`.
  - Actions are **revoke cap** and **revoke key**, each with a reason code, posting to `POST /api/ops/mandates/[id]/revoke` and `POST /api/ops/api-keys/[id]/revoke`. Both are `auth: 'operator'`, MFA, `csrf: true`, `idempotent: true`, `risk: 'high'`, rate 30 per hour per actor. The routes import their write functions from `src/composition/ops-agents.ts` (C7).
  - There is no pause, as in the plan row OPS-C.3: `mandates` has no paused state (0021).
- **OPS-C.4, Money tab** `/ops/money`: problems (from OPS-A), the reconciler state, totals **per environment, currency and kind**, each with an `EnvLabel` from the stored `environment` (C6). Each total opens a ledger list `/ops/money/ledger?environment=&currency=&kind=`. Today's exchange rates also show.
- **OPS-C.5, money-flow strip on Home**: counts for the 24 hours ending at the injected `now`, plus stuck counts (C5):

| Stage | Source and rule |
|---|---|
| Find | `briefs` rows with `created_at` in the window |
| Quote | `quotes` rows with `created_at` in the window |
| Approve | `approvals` rows with `used_at` in the window |
| Pay | `order_units` with `captured_verified_at` in the window |
| Unlock | `access_events` of kind `access_ready` with `at` in the window |
| Refund | `refund_requests` in state `completed` with `updated_at` in the window |
| Stuck: sent | `operations` with `state = 'sent'` and `lease_until < now` |
| Stuck: unknown | `operations` with `state = 'unknown'` and `reconcile_until < now` |

**Composition modules (S3).** Buyer page: `ops-buyers.ts`. Seller page: `ops-sellers.ts`. Agents page and both revoke writes: `ops-agents.ts`. Money tab and ledger list: `ops-money.ts`. Strip: `ops-home.ts`. Each wraps the upstream read (SR1, TR1) without copying it.

## Domain changes (C3, C4)

- `revokeMandateAsOperator(db, deps, operator: Actor, {id, reason_code})` in `domain/mandates/src/store.ts`. It is the same `FOR UPDATE` and idempotent revoke as `revokeMandate`, without the buyer filter. It refuses unless `operator.kind === 'operator'` and `operator.mfa === true`, like `refunds.ts:227`.
- `revokeKeyAsOperator(deps, operator: Actor, key_id, reason_code)` in `packages/security/src/apikey.ts`, mirroring `revokeKey` without the owner filter, with the same operator and MFA check.
- Reason codes: `abuse`, `owner_request`, `compromised`, `other`. There is no free text.
- **Where the code lands (C3, option a).** The audit row's `action` carries it in clear: `mandate.revoked.<code>` and `api_key.revoked.<code>`. TR0 copies `audit_log.action` in clear, so the journal is self-describing. `audit_log.reason` stays empty.

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
- `apps/web/src/flow-a11y.state.test.ts` (adds the four pages)

## Acceptance tests (commit 1: tests only, run red)

| Item | Test file | Command | Expected |
|---|---|---|---|
| OPS-C.1, C.2 | `apps/web/src/ops-entity-view.state.test.ts` | `corepack pnpm vitest run apps/web/src/ops-entity-view.state.test.ts` | Seeded buyer and seller pages list the expected rows; the buyer page without MFA returns only the MFA notice; a seller page shows no buyer identity (deep scan) |
| OPS-C.3 | `apps/web/src/ops-agents.adversarial.test.ts`, `domain/mandates/src/operator-revoke.state.test.ts`, `packages/security/src/operator-revoke.state.test.ts` | `corepack pnpm vitest run apps/web/src/ops-agents.adversarial.test.ts domain/mandates/src/operator-revoke.state.test.ts packages/security/src/operator-revoke.state.test.ts` | A seeded `whsec_` value, a webhook URL path and query, and `api_keys.secret_hash` appear in no page HTML or JSON, with or without MFA. Without MFA: no buyer id or name, key ids and provider ids as last 4 only. Both revoke routes need MFA, CSRF and an idempotency key; buyer, seller, bearer and operator-key callers are refused; a replay returns the stored answer; a revoked cap refuses `buy_unit` with the existing code; a revoked key gets 401 on its next call; the journal row has actor operator, channel `web` and `audit_log.action` `mandate.revoked.abuse` (or the key's); a second revoke writes no second audit row; an unknown id gives 404. Each domain function refuses an operator with `mfa: false` and a non-operator actor |
| OPS-C.4 | `apps/web/src/ops-money-view.state.test.ts` | `corepack pnpm vitest run apps/web/src/ops-money-view.state.test.ts` | Each total equals the sum of its ledger list per environment, currency and kind; a seed with `dryrun` and `sandbox` rows gives two separate totals, each labelled from the stored value; the ledger list without MFA shows `capture_id` and `refund_id` as last 4 only; the reconciler state equals the job health read |
| OPS-C.5 | `apps/web/src/money-flow-view.state.test.ts` | `corepack pnpm vitest run apps/web/src/money-flow-view.state.test.ts` | On a seeded run each stage count equals its table rule, with rows just inside and just outside the 24 hours; stuck counts equal the two operation rules |
| a11y | `apps/web/src/flow-a11y.state.test.ts` | `corepack pnpm vitest run apps/web/src/flow-a11y.state.test.ts` | The text-read check passes for the four pages |

Mutation (OPS-C.3 is L): `pnpm mutation --require-targets --targets "domain/mandates/src/store.ts,packages/security/src/apikey.ts,apps/web/src/app/api/ops/mandates/[id]/revoke/route.ts,apps/web/src/app/api/ops/api-keys/[id]/revoke/route.ts" --test-cmd "corepack pnpm vitest run apps/web/src/ops-agents.adversarial.test.ts domain/mandates packages/security/src/operator-revoke.state.test.ts" --threshold 80`. C4 to C7 apply.

## Do not

Add a paused state or any money-table change; change `revokeMandate` or `revokeKey`; select `signing_secret`, `secret_hash` or a full webhook URL; show identity without MFA; add a `/api/v1` write.

Branch: `feat/int-ops-c`. Commit: `feat(web): operator buyer, seller, agent and money pages (INT-OPS-C)`.
