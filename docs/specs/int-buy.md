# INT-BUY: buyer screens

Task: Give buyers a home, their purchases, their order timeline, and control of their agents' spending caps and API keys.
Package: `apps/web` (buyer tabs), buyer composition module. Builder: Sonnet 5.5 high. Reviewer: Opus 5.5 gate.
Items: BUY.1 to BUY.10, 23 points (BUY.1 to BUY.5 must, 11; BUY.6 to BUY.10 should, 12). Needs UI0, TR1, SR1, OPS-B.1 (filter bar). Decision V7. Sources: `/mnt/project-files/operator-ux/buyer-home.html` items 1 to 10; UX-04, 05, 10, 11, 12, 19, 22.

## Goal

Agents tab lists each agent key's cap in money and count, spent, remaining, expiry and purchases, creates a cap with a confirm sentence ("Your agent may spend up to $5.00 and make up to 50 purchases until 30 Nov"), and pauses or revokes it. The agent hand-off page shows the cap line. The order page shows the buyer timeline, a case card with steps and due time, and Report a problem; the frozen help page carries the order and item. Spending lists purchases with the filter bar and CSV. Home shows needs your OK, continue reading, the spend meter and recent spending. Should items: receipts list with full receipt fields and links back; approvals inbox; API keys (create once-shown, list, revoke); "Open now" on return; expected time on pending items; journey tests B1 to B6.

## Outputs

Pages under `apps/web/src/app/(buyer)/(home|agents|spending|orders/[ref]|receipts|approvals|keys)`, buyer composition module, copy in `apps/web/src/lib/buyer-copy.ts`. Uses existing `/api/v1` mandate and key routes; no new API.

## Acceptance tests (commit 1: tests only, run red)

| Item | Test file | Command | Expected |
|---|---|---|---|
| BUY.1, BUY.2 | `apps/web/src/buyer-agents.adversarial.test.ts`, `buyer-agents.golden.test.ts` | `pnpm test:adversarial -- buyer-agents` | Confirm sentence states money and count; buyer A cannot see or revoke buyer B's caps; CSRF required |
| BUY.3 | e2e `tests/e2e/buyer-order.spec.ts` | `pnpm test:e2e -- buyer-order` | Timeline shows approved, paid, ready, downloaded, refunded in words; a frozen order's help link opens its case |
| BUY.4, BUY.5 | `apps/web/src/buyer-spending.state.test.ts` | `pnpm test:state -- buyer-spending` | Filters and CSV match; spend meter equals the mandate numbers |
| BUY.6 to BUY.9 | `apps/web/src/buyer-should.state.test.ts`, `buyer-keys.adversarial.test.ts` | `pnpm test:adversarial -- buyer-keys` | Key secret shown once and never again; receipt has order ref, provider id, seller of record |
| BUY.10 | `tests/e2e/buyer-journeys.spec.ts` | `pnpm test:e2e -- buyer-journeys` | B1 to B6 pass; axe clean |

Branch: `feat/int-buy`. Commit: `feat(web): buyer home, agents, spending and order timeline (INT-BUY)`.
