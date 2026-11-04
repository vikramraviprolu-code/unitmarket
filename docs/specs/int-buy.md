# INT-BUY: buyer screens

Task: Give buyers a home, their purchases, their order timeline, and control of their agents' spending caps and API keys.
Package: `apps/web` (buyer tabs, two session route groups), reusing `domain/mandates` unchanged. Builder: Sonnet 5.5 high. Reviewer: Opus 5.5 gate.
Items: BUY.1 to BUY.10, 23 points: BUY.1 to BUY.5 "must" (11), BUY.6 to BUY.10 "should" (12). Needs UI0, TR1, SR1 and OPS-B.1 (filter bar) merged. Decision V7. Sources: `/mnt/project-files/operator-ux/buyer-home.html` items 1 to 10; UX-04, 05, 10, 11, 12, 19, 22. Includes `int-wave2-conventions.md`.

## Goal

URLs follow UI0: Home `/buyer`, Find `/discover`, Library `/library`, Spending `/buyer/spending`, Agents `/buyer/agents`. Receipts, approvals and keys live under `/buyer/*`. The order page stays `/orders/[ref]`.

**BUY.1, Agents (L).**
- The page lists each agent key's cap: money and count, spent, remaining, expiry and its purchases.
- **New cap** asks for money, count or both, plus expiry. Before submit it shows the confirm sentence from `lib/buyer-copy.ts`, for example "Your agent may spend up to $5.00 and make up to 50 purchases until 30 Nov." The cap is created only after the buyer confirms.
- **Revoke** ends a cap.
- The browser cannot call the apikey `/api/v1/mandates` routes. New session routes call the same `domain/mandates` functions: `POST /api/buyer/mandates` and `POST /api/buyer/mandates/[id]/revoke` (`auth: 'buyer'`, CSRF, idempotency key).
- A decision-log row amends D-093 under V7: a buyer may also create and revoke a cap from a signed-in session, and an agent key still never can.
- Pause is out: there is no paused state (0021), the same as OPS-C.

**BUY.2, cap line.** The agent hand-off page `/buy/agent/[ref]` shows the cap line (remaining money and count).

**BUY.3, order page.** `/orders/[ref]` shows the TR1 buyer timeline in words, a case card with steps and due time, and Report a problem. The frozen help page `/help/[case]` carries the order ref and the item.

**BUY.4, Spending.** `/buyer/spending` lists purchases with the shared filter bar, buyer fields only. CSV comes from a session route `GET /api/buyer/orders/export`, which uses SR1's buyer export read and the same `{filename, csv, truncated}` answer.

**BUY.5, Home.** `/buyer` shows, in this order: needs your OK (pending approvals), continue reading, the agent spend meter (the mandate numbers) and recent spending.

**Should items:**
- **BUY.6:** a receipts list `/buyer/receipts`, with each receipt's order ref, provider order id, seller of record and links back.
- **BUY.7:** an approvals inbox `/buyer/approvals` that wraps the existing `/approve/[id]`.
- **BUY.8 (L):** API keys `/buyer/keys`: list, create once-shown, revoke, using the existing `owner` routes `/api/v1/api-keys`.
- **BUY.9:** the payment return shows "Open now", and pending items show the expected time and order link.
- **BUY.10:** journeys B1 to B6.

## Outputs (only these files)

New:
- pages `apps/web/src/app/buyer/{agents,spending,receipts,approvals,keys}/page.tsx`
- routes `apps/web/src/app/api/buyer/mandates/route.ts`, `apps/web/src/app/api/buyer/mandates/[id]/revoke/route.ts`, `apps/web/src/app/api/buyer/orders/export/route.ts`
- `apps/web/src/ui/buyer/{CapCard,CapForm,SpendMeter,CaseCard,KeyList}.tsx`
- `apps/web/src/lib/{buyer-agents-view,buyer-spending-view,buyer-home-view,buyer-keys-view,buyer-copy}.ts`
- the tests below

Changed:
- `apps/web/src/app/buyer/page.tsx`, `apps/web/src/app/orders/[ref]/page.tsx`, `apps/web/src/app/buy/agent/[ref]/page.tsx`, `apps/web/src/app/help/[case]/page.tsx`, `apps/web/src/app/checkout/return/page.tsx`
- composition module `buyer.ts`
- `apps/web/src/lib/shell-tabs.ts` (`ready: true` for Spending and Agents)
- `docs/decision-log.md` (D-093 amendment)

No domain or migration change.

## Acceptance tests (commit 1: tests only, run red)

| Item | Test file | Command | Expected |
|---|---|---|---|
| BUY.1 | `apps/web/src/buyer-agents-view.golden.test.ts`, `apps/web/src/buyer-mandates.adversarial.test.ts` | `corepack pnpm vitest run apps/web/src/buyer-agents-view.golden.test.ts apps/web/src/buyer-mandates.adversarial.test.ts` | Confirm sentences for money only, count only and both are exact. A create without the confirm flag gives 400. Buyer A cannot see, create on or revoke buyer B's caps or keys (404). Missing CSRF gives 403. A replay returns the stored answer. Agent keys, seller and operator sessions are refused. A revoked cap refuses the next `buy_unit`. The journal shows the buyer and channel `web` |
| BUY.2 | `apps/web/src/buyer-agents-view.golden.test.ts` | same as BUY.1 | The cap line for a seeded mandate is exact |
| BUY.3 | `apps/web/src/buyer-order-view.state.test.ts`, `apps/web/e2e/buyer-order.spec.ts` | `corepack pnpm vitest run apps/web/src/buyer-order-view.state.test.ts`; `corepack pnpm --filter @umsbx/web test:e2e buyer-order.spec.ts` | The timeline shows approved, paid, ready, downloaded and refunded in words, with no operator or context field; a frozen order's help link opens its case with the order ref |
| BUY.4 | `apps/web/src/buyer-spending-view.state.test.ts`, `apps/web/src/buyer-export.adversarial.test.ts` | `corepack pnpm vitest run apps/web/src/buyer-spending-view.state.test.ts apps/web/src/buyer-export.adversarial.test.ts` | Filters narrow, and the CSV rows equal the filtered list; buyer A's export never holds buyer B's rows; `buyer=` gives 400 `field_not_allowed`; CSV cells are neutralised |
| BUY.5 | `apps/web/src/buyer-home-view.state.test.ts` | `corepack pnpm vitest run apps/web/src/buyer-home-view.state.test.ts` | The spend meter equals the mandate's `spent_minor`, `used_count` and caps; sections appear in order; empty states have words |
| BUY.6, BUY.7, BUY.9 | `apps/web/src/buyer-should-view.state.test.ts` | `corepack pnpm vitest run apps/web/src/buyer-should-view.state.test.ts` | Each receipt has order ref, provider order id and seller of record; the approvals inbox lists exactly the pending approvals; return and pending copy are exact |
| BUY.8 | `apps/web/src/buyer-keys.adversarial.test.ts` | `corepack pnpm vitest run apps/web/src/buyer-keys.adversarial.test.ts` | The key secret appears in the create answer once and never in a list, page or replay; buyer A cannot revoke buyer B's key; an agent key cannot mint keys |
| BUY.10 | `apps/web/e2e/buyer-journeys.spec.ts` | `corepack pnpm --filter @umsbx/web test:e2e buyer-journeys.spec.ts` | B1 to B6 pass; the text-read a11y check (C2) passes for each new page |

Mutation (BUY.1 and BUY.8 are L): `pnpm mutation --require-targets --targets apps/web/src/app/api/buyer/mandates/route.ts,apps/web/src/app/api/buyer/mandates/[id]/revoke/route.ts,apps/web/src/lib/buyer-agents-view.ts --test-cmd "corepack pnpm vitest run apps/web/src/buyer-mandates.adversarial.test.ts apps/web/src/buyer-agents-view.golden.test.ts apps/web/src/buyer-keys.adversarial.test.ts" --threshold 80`. C4 to C7 apply.

## Do not

Let an agent key create, change or revoke a cap; add a paused state; change `domain/mandates` or the v1 mandate routes; show a key secret twice.

Branch: `feat/int-buy`. Commit: `feat(web): buyer home, agents, spending and order timeline (INT-BUY)`.
