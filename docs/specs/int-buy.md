# INT-BUY: buyer screens

Task: Give buyers a home, their purchases, their order timeline, and control of their agents' spending caps and API keys.
Package: `apps/web` (buyer tabs, two session route groups), reusing `domain/mandates` unchanged. Builder: Sonnet 5.5 high. Reviewer: Opus 5.5 gate.
Items: BUY.1 to BUY.10, 23 points: BUY.1 to BUY.5 "must" (11), BUY.6 to BUY.10 "should" (12). Needs UI0, TR1, SR1 and OPS-B.1 (filter bar) merged. Decision V7. Sources: `/mnt/project-files/operator-ux/buyer-home.html` items 1 to 10; UX-04, 05, 10, 11, 12, 19, 22. Includes `int-wave2-conventions.md`. Round 2: fixes F1 to F10 of `buy-scorecard.md`.

## Goal

URLs follow UI0: Home `/buyer`, Find `/discover`, Library `/library`, Spending `/buyer/spending`, Agents `/buyer/agents`. Receipts, approvals and keys live under `/buyer/*`. The order page stays `/orders/[ref]`.

**BUY.1, Agents (L).**
- The page lists each agent key's cap: money and count, spent, remaining, expiry and its purchases.
- **New cap** asks for money, count or both, plus expiry. Before submit it shows the confirm sentence from `lib/buyer-copy.ts`, for example "Your agent may spend up to $5.00 and make up to 50 purchases until 30 Nov." The confirm button sets `terms_accepted: true`; the cap is created only then.
- **Revoke** ends a cap.
- The browser cannot call the apikey `/api/v1/mandates` routes. New session routes call the same `domain/mandates` functions (`createMandate`, `revokeMandate` in `store.ts`), unchanged:

| Route | Meta |
|---|---|
| `POST /api/buyer/mandates` | `auth: 'buyer'`, `csrf: true`, `idempotent: true`, `risk: 'high'`, `max_body_bytes: 4096`, `rate: {name: 'buyer_mandate_create', per: 'actor', limit: 30, window_ms: 3_600_000}` |
| `POST /api/buyer/mandates/[id]/revoke` | as above, `max_body_bytes: 1024`, `rate: {name: 'buyer_mandate_revoke', per: 'actor', limit: 60, window_ms: 3_600_000}` |
| `GET /api/buyer/orders/export` | `auth: 'buyer'`, `csrf: false`, `idempotent: false`, `risk: 'medium'`, `max_body_bytes: 1024`, `rate: {name: 'buyer_export', per: 'actor', limit: 10, window_ms: 60_000}` |

- The create body is exactly `MandateCreateRequestSchema` from contracts (F1). Its `terms_accepted: z.literal(true)` is the confirm flag, so no contract change. A body without it gets 422 `invalid_input` naming `terms_accepted` (the non-v1 wrapper status).
- Refusals (F10): bearer only 401 `unauthenticated`; seller or operator session 403 `forbidden`; missing CSRF 403 `csrf`; missing `Idempotency-Key` 422 `idempotency_key`; the same key with another body 422 `idempotency_key_reused`. Another buyer's cap or key gives 404 with the unknown-id body.
- **Reads (F8)**, in `src/composition/buyer.ts`, with no domain change:
  - `listCaps(buyer_id)`: `mandates WHERE buyer_id = $1 ORDER BY created_at DESC, id DESC`, each through `remainingOf`.
  - A cap's purchases: SR1's buyer list with `agent_key=<id>` (the buyer projection carries `agent_key_id` and `mandate_id`). Not `agent_purchases`, which holds idempotency claims, not orders.
- **Decision row (F9).** The next free D-number at merge (D-095 unless taken) amends D-093 under V7 (Vikram, 4 Nov 23:23Z): a buyer may also create and revoke a cap from a signed-in session. Reason: a signed-in buyer can already mint an `api_client` key with `mandates:write` through `/api/v1/api-keys` and call `/api/v1/mandates`, so the session route adds no authority; it is a shorter path behind CSRF and idempotency. An agent key still never creates, widens, revokes or un-revokes a cap. In sandbox, `buy_unit` still stops at `buyer_approval_required` (D-093 (4)).
- Pause is out: there is no paused state (0021), the same as OPS-C.

**BUY.2, cap line.** The agent hand-off page `/buy/agent/[ref]` shows the cap line (remaining money and count). The cap is found through `mandate_reservations.order_id` for that order, scoped to the session buyer; no reservation shows no line.

**BUY.3, order page.** `/orders/[ref]` shows the TR1 buyer timeline in words, a case card with steps and due time, and Report a problem. The frozen help page `/help/[case]` carries the order ref and the item.

**BUY.4, Spending.** `/buyer/spending` lists purchases with the shared filter bar, buyer fields only. CSV comes from `GET /api/buyer/orders/export`, which uses SR1's buyer export read and the same `{filename, csv, truncated}` answer.

**BUY.5, Home (F6).** `/buyer` with a buyer session shows, in this order: needs your OK (pending approvals), continue reading, the agent spend meter (the mandate numbers) and recent spending. A signed-out visitor, a seller or an operator still gets today's public explainer text from `lib/account-copy.ts`, unchanged. So `e2e/accounts.spec.ts` and `account-copy.golden.test.ts` do not change.

**Should items:**
- **BUY.6:** a receipts list `/buyer/receipts`, with each receipt's order ref, provider order id, seller of record and links back.
- **BUY.7:** an approvals inbox `/buyer/approvals` that wraps the existing `/approve/[id]`.
- **BUY.8 (L):** API keys `/buyer/keys`: list, create once-shown, revoke, using the existing `owner` routes `/api/v1/api-keys`. The once-shown and list logic lives in `lib/buyer-keys-view.ts` (F5): the token is held only in the create answer's client state and is never written to the list model, the page or a replay.
- **BUY.9:** the payment return shows "Open now", and pending items show the expected time and order link.
- **BUY.10:** journeys B1 to B6.

## Outputs (only these files)

New:
- pages `apps/web/src/app/buyer/{agents,spending,receipts,approvals,keys}/page.tsx`
- routes `apps/web/src/app/api/buyer/mandates/route.ts`, `apps/web/src/app/api/buyer/mandates/[id]/revoke/route.ts`, `apps/web/src/app/api/buyer/orders/export/route.ts`
- `apps/web/src/ui/buyer/{CapCard,CapForm,SpendMeter,CaseCard,KeyList}.tsx`
- `apps/web/src/lib/{buyer-agents-view,buyer-spending-view,buyer-home-view,buyer-keys-view}.ts`
- the tests below

Changed:
- `apps/web/src/lib/buyer-copy.ts` (additive only; existing strings and goldens unchanged) (F7)
- `apps/web/src/app/buyer/page.tsx` (buyer session gets Home; everyone else today's text), `apps/web/src/app/orders/[ref]/page.tsx`, `apps/web/src/app/buy/agent/[ref]/page.tsx`, `apps/web/src/app/help/[case]/page.tsx`, `apps/web/src/app/checkout/return/page.tsx`
- composition module `buyer.ts`
- `apps/web/src/lib/shell-tabs.ts` (`ready: true` for Spending and Agents)
- `apps/web/src/flow-a11y.state.test.ts` (adds the five new pages)
- `docs/decision-log.md` (the D-093 amendment row)

No domain, contract or migration change.

## Acceptance tests (commit 1: tests only, run red)

| Item | Test file | Command | Expected |
|---|---|---|---|
| BUY.1 | `apps/web/src/buyer-agents-view.golden.test.ts`, `apps/web/src/buyer-mandates.adversarial.test.ts` | `corepack pnpm vitest run apps/web/src/buyer-agents-view.golden.test.ts apps/web/src/buyer-mandates.adversarial.test.ts` | Confirm sentences for money only, count only and both are exact. A create without `terms_accepted` gives 422 `invalid_input` naming it. The F10 refusals hold with their statuses. Buyer A's `listCaps` holds none of buyer B's caps; buyer A cannot create on or revoke buyer B's cap or key (404, same body as unknown). Two concurrent creates on one key give one 201 and one 409 `mandate_active`. Expiry over 90 days gives 422 `invalid_expiry`. An `api_client` key id, a revoked agent key or another buyer's agent key gives 404. Revoke twice gives 200 with the first `revoked_at`. The 31st create in an hour gives 429. A replay returns the stored answer. A revoked cap refuses the next `buy_unit`. A cookie plus an agent bearer header is journaled with actor `buyer`, channel `web`, never `agent` (F2) |
| BUY.2 | `apps/web/src/buyer-agents-view.golden.test.ts` | same as BUY.1 | The cap line for a seeded mandate is exact; another buyer's order shows no line |
| BUY.3 | `apps/web/src/buyer-order-view.state.test.ts`, `apps/web/e2e/buyer-order.spec.ts` | `corepack pnpm vitest run apps/web/src/buyer-order-view.state.test.ts`; `corepack pnpm --filter @umsbx/web test:e2e buyer-order.spec.ts` | The timeline shows approved, paid, ready, downloaded and refunded in words, with no operator or context field; a frozen order's help link opens its case with the order ref |
| BUY.4 | `apps/web/src/buyer-spending-view.state.test.ts`, `apps/web/src/buyer-export.adversarial.test.ts` | `corepack pnpm vitest run apps/web/src/buyer-spending-view.state.test.ts apps/web/src/buyer-export.adversarial.test.ts` | Filters narrow, and the CSV rows equal the filtered list; buyer A's export never holds buyer B's rows; `buyer=` gives 400 `field_not_allowed`; CSV cells are neutralised; seller and operator sessions 403, anonymous 401; the 11th export in a minute 429 |
| BUY.5 | `apps/web/src/buyer-home-view.state.test.ts` | `corepack pnpm vitest run apps/web/src/buyer-home-view.state.test.ts` | The spend meter equals the mandate's `spent_minor`, `used_count` and caps; sections appear in order; empty states have words; a non-buyer gets the public text unchanged |
| BUY.6, BUY.7, BUY.9 | `apps/web/src/buyer-should-view.state.test.ts` | `corepack pnpm vitest run apps/web/src/buyer-should-view.state.test.ts` | Each receipt has order ref, provider order id and seller of record; the approvals inbox lists exactly the pending approvals; return and pending copy are exact |
| BUY.8 | `apps/web/src/buyer-keys.adversarial.test.ts` | `corepack pnpm vitest run apps/web/src/buyer-keys.adversarial.test.ts` | The key secret appears in the create answer once and never in a list, the list model of `buyer-keys-view.ts`, a page reload or a replay; buyer A cannot revoke buyer B's key; an agent key cannot mint keys |
| BUY.10 | `apps/web/e2e/buyer-journeys.spec.ts` | `corepack pnpm --filter @umsbx/web test:e2e buyer-journeys.spec.ts` | B1 to B6 pass; `e2e/accounts.spec.ts` still passes unchanged |
| a11y | `apps/web/src/flow-a11y.state.test.ts` | `corepack pnpm vitest run apps/web/src/flow-a11y.state.test.ts` | The text-read check passes for each new page |

Mutation (BUY.1 and BUY.8 are L): `pnpm mutation --require-targets --targets "apps/web/src/app/api/buyer/mandates/route.ts,apps/web/src/app/api/buyer/mandates/[id]/revoke/route.ts,apps/web/src/lib/buyer-agents-view.ts,apps/web/src/lib/buyer-keys-view.ts" --test-cmd "corepack pnpm vitest run apps/web/src/buyer-mandates.adversarial.test.ts apps/web/src/buyer-agents-view.golden.test.ts apps/web/src/buyer-keys.adversarial.test.ts" --threshold 80`. C4 to C7 apply.

## Do not

Let an agent key create, change or revoke a cap; add a paused state; change `domain/mandates`, the mandate contracts or the v1 mandate routes; show a key secret twice; change the public `/buyer` text for non-buyers.

Branch: `feat/int-buy`. Commit: `feat(web): buyer home, agents, spending and order timeline (INT-BUY)`.
