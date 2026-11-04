# INT-E2E: integrated proof and tamper demo

Task: Prove the whole story offline through the public routes, and script the tamper demo for the video.
Package: `tests/int/` only. Builder: Sonnet 5.5 high. Reviewer: Opus 5.5 gate.
Items: E2E.1, E2E.2, 4 points. Needs every must lane merged.

## Goal

One test drives, through `createApp` and the route handlers with the dry-run transport: a person buys two units; an agent with a $5.00 and 10-purchase cap buys three units over MCP; the buyer downloads one; the operator refunds one unit with MFA; a forced `payment_unresolved` alert is raised, acknowledged, then auto-resolved when the reconciler settles the order; the cap reaches its limit and the agent is refused. Every step appears exactly once in the right timeline with the right actor and channel; the seller timeline has no buyer identity; no row is unattributed; `trace:verify` passes; the offline trace is empty (no fetch, socket or DNS). A second test, on the test database target only, disables triggers, edits one ledger amount, runs `trace:verify` (exit 1, names chain and seq), restores the value, and verifies again (exit 0). A script `scripts/demo-tamper.mjs` replays that second test for the video against a local in-memory database.

## Outputs

`tests/int/integrated-story.integration.test.ts`, `tests/int/tamper.adversarial.test.ts`, `tests/int/support.ts`, `scripts/demo-tamper.mjs`, `docs/demo/integrated-story.md` (steps and expected screen states). No product code.

## Acceptance tests

| Item | Command | Expected |
|---|---|---|
| E2E.1 | `pnpm test:integration -- integrated-story` | Pass; printed table of timeline events per order matches the expected table in the test |
| E2E.2 | `pnpm test:adversarial -- tamper` ; `node scripts/demo-tamper.mjs` | First verify exit 1 naming the chain, second exit 0; the script refuses any database target other than in-memory |

Branch: `feat/int-e2e`. Commit: `test(int): integrated story and tamper proof (INT-E2E)`.
