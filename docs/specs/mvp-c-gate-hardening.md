# CO-Gb: MVP-C gate hardening (tests and docs from the Opus gate review of CO-G)

Task: close the test gaps and the owner-step defects the Opus gate review found in CO-G (merged as 4c3844d). Tests and docs only; no product code.
Package: `tests/mvp-c`, `scripts`, `domain/payments` (one new test file), `docs` Owner: Sonnet 5.5 builder (CO-Gb) Reviewer: Opus 5.5; Sakthi merges

Goal: (M1) the "whole C run opens no socket" proof also sees the shapes a module-export replacement misses; (L1) the killed C-11 child is watched while it runs, not only when it reports; (L2) the C-07 keep and online tests assert that a link issued before the refund stops opening; (M2) a plain database error while booking a completed refund rolls back and is retried, which kills the `instanceof LedgerRuleError` mutant (`refunds.ts:937`); (L3, L4) the owner steps can be carried out as written; (gate report) the review verdict and open items are recorded.

Inputs: `tests/mvp-c/*`, `scripts/c11-restart.integration.test.ts`, `domain/payments/src/ops/support.ts`, `docs/evidence/mvp-c-offline-gate-2026-10-25.md`, `docs/owner/MVPC-OWNER-STEPS.md`, `docs/design/hosting.md`, `docs/decision-log.md` (D-037 to D-039).

Outputs:

- M1: `tests/mvp-c/c-offline.adversarial.test.ts` (subscribes to `diagnostics_channel` `net.client.socket`; blocks `net.Socket.prototype.connect`, `dns.promises`, `node:dns/promises`, `node:http2` `connect`, `http.Agent` and `https.Agent` `createConnection`; canary tests) and `tests/mvp-c/c-net-probe.ts` (a helper that imports the network modules so it sees the patched ones). Lint bars network imports outside `packages/transport`, so one pinned exemption (`no-restricted-imports`, that file only) goes in `eslint.config.mjs` with its pin in `scripts/lint-rules.test.ts`. `netSpies()` in `packages/transport/src/test-support.ts` cannot be reused: that file is sealed to its package (SEAL2), so the same list is rebuilt here.
- L1: `scripts/c11-restart.integration.test.ts` (live `net` messages, throwing wrappers, more shapes, a child canary). The child stays a string: a real file would need S2/S6 exemptions for `node:net`, `Date.now()` and `new Date()`; a comment says so.
- L2: `tests/mvp-c/c06-c07-refunds.integration.test.ts`.
- M2: `domain/payments/src/refunds.rollback.state.test.ts` (new).
- L3, L4: `docs/owner/MVPC-OWNER-STEPS.md` (Steps 1 and 3 only), `docs/design/hosting.md` (step 5).
- Report: `docs/evidence/mvp-c-offline-gate-2026-10-25.md`.

Acceptance tests:

- `corepack pnpm vitest run --project adversarial tests/mvp-c/c-offline.adversarial.test.ts`: green; the canary shows each of the five shapes recorded (red before the harness change).
- `corepack pnpm vitest run --project integration scripts/c11-restart.integration.test.ts tests/mvp-c/c06-c07-refunds.integration.test.ts`: green; the child canary records every shape live.
- `corepack pnpm vitest run --project state domain/payments/src/refunds.rollback.state.test.ts`: green; with line 937 changed to `if (false) throw e;` it fails ("promise resolved instead of rejecting").
- `corepack pnpm mutation --targets domain/payments/src/refunds.ts --test-cmd "<narrowed>" --timeout 600`: the mutant at 937 is killed; file score reported.
- `corepack pnpm run ci && corepack pnpm check:hosting`: exit 0.

Do not: change product code; touch Step 6, Step 7 or any pin text in `MVPC-OWNER-STEPS.md`, `packages/safety/src/cli-resume.ts`, `apps/web/src/server/webhook.ts` or `packages/paypal` (lanes CO-7b and CO-1d); add a dependency; contact PayPal or any network; read or write a secret.
Evidence for the PR: red and green output, the mutation result, diff stat.
Branch: `feat/mvp-c-gate-hardening` Commit: `test(tests): <what> (CO-Gb)`; `docs(tests): <what> (CO-Gb)`
