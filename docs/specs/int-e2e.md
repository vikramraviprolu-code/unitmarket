# INT-E2E: integrated proof and tamper demo

Task: Prove the whole story offline through the public routes, and script the tamper demo for the video.
Package: new `tests/int/` (the pattern of `tests/mvp1-api/`), one script. Builder: Sonnet 5.5 high. Reviewer: Opus 5.5 gate.
Items: E2E.1 and E2E.2, 4 points, "must". Needs every "must" lane merged (TR0, SR0, UI0, CL1, TR1, AL, SR1, OPS-A, OPS-B, CTL must items, BUY.1 to BUY.5, SEL.1 to SEL.3). Includes `int-wave2-conventions.md`.

## Goal

**E2E.1, the story.** One test drives the app in dry-run through the route handlers and the web composition, exactly as `tests/mvp1-api/story.ts` does:
1. A person buys two units.
2. A buyer creates a $5.00, 10-purchase cap for an agent key through `/api/buyer/mandates`.
3. The agent buys three units over MCP.
4. The buyer downloads one.
5. The operator refunds one unit with MFA.
6. A forced `payment_unresolved` alert is raised, acknowledged through AL's route, then auto-resolved when the reconciler settles the order.
7. The cap reaches its limit, AL raises `mandate_near_cap`, and the agent's next buy is refused.

Then it checks:
- Every step appears exactly once in the right TR1 timeline, with the right actor and channel.
- The seller timeline and seller export have no buyer identity (deep scan).
- The v1 operator answers carry no identity.
- INV-T2 is empty and `trace:verify` exits 0.
- The offline probe (`tests/mvp-c/c-net-probe.ts`) records no fetch, socket or DNS.

**E2E.2, tamper.** On the in-memory test database only:
1. Disable the capture triggers and edit one ledger amount. `trace:verify` exits 1 and names the drift (table, id, column).
2. Restore the value. Verify exits 0.
3. Edit one journal row's body. Verify exits 1 and names the chain and seq.

`scripts/demo-tamper.mjs` replays these steps for the video against a fresh in-memory database. It prints each step in plain words and refuses with exit 2 if `UMS_DB` names anything but `pglite-memory`.

## Outputs (only these files)

New:
- `tests/int/{package.json,tsconfig.json,story.ts,support.ts}`
- `tests/int/integrated-story.integration.test.ts`, `tests/int/tamper.adversarial.test.ts`
- `scripts/demo-tamper.mjs`, `scripts/demo-tamper.test.ts`
- `docs/demo/integrated-story.md` (steps and expected screen states)

Changed:
- `eslint.config.mjs`: one exception entry for `tests/int/**/*.ts` with `sbx/no-package-escape` off, worded like the `tests/mvp1-api/**` entry
- `pnpm-lock.yaml` (workspace package)

No product code.

## Acceptance tests

| Item | Command | Expected |
|---|---|---|
| E2E.1 | `corepack pnpm vitest run tests/int/integrated-story.integration.test.ts` | Pass. The printed table of timeline events per order equals the expected table in the test. The deep scans find no buyer identity in seller or v1 operator answers. INV-T2 is empty, `trace:verify` exits 0, and the net probe is empty |
| E2E.2 | `corepack pnpm vitest run tests/int/tamper.adversarial.test.ts scripts/demo-tamper.test.ts`, then `UMS_DB=pglite-memory node scripts/demo-tamper.mjs` | The test shows drift exit 1 with table, id and column; restore exit 0; body edit exit 1 with chain and seq. The script test shows `UMS_DB=postgres` and `UMS_DB=pglite-disk` each give exit 2 with no database opened. The demo run prints the steps and ends with exit 0 |

This lane is the proof, so mutation does not apply. C4, C5 and C7 apply.

## Do not

Change product code; reach a network; run the tamper steps on any database but in-memory; skip a step to make the story pass.

Branch: `feat/int-e2e`. Commit: `test(int): integrated story and tamper proof (INT-E2E)`.
