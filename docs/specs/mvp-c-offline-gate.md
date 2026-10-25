# CO-G: MVP-C offline gate: acceptance twins, evidence, and the MVP-C owner steps

Task: run every MVP-C acceptance test that needs no PayPal and no host as an offline twin through public entry points, write the gate evidence, and write the owner step list for the MVP-C window.
Package: `tests/mvp-c`, `docs/evidence`, `docs/owner` Owner: Sonnet 5.5 builder, effort high (gate) Reviewer: Opus 5.5 high, full gate review in SOP 22 format; Sakthi merges
Wave: W6, after every CO lane and BU-3. Assumptions: all ASM-50 to ASM-60. Requirements: mvp-plan MVP-C table; nfr.md MVP-C list.

Goal: one file per group, each test named by its acceptance id, all through `createApp` and the route handlers (as `tests/mvp-a` and `tests/mvp-b` do), dry-run or a fake Wire, never a socket: C-02 (forged signature, one changed byte, wrong webhook id, re-serialised body: 400, audit row, no state change), C-03 (off-list cert URL: 400, zero transport calls), C-04 (cert unreachable: 503, not recorded as forgery), C-05 (same event three times: one enqueue, 200 each; replay after refund leaves access revoked), C-06 (partial then remainder, two refund rows, two ledger entries by refund id, double click one refund, over-refund refused), C-07 (full refund revokes online, keep links stop, receipt v2), C-08 (operator without TOTP 403, with it allowed, idle 30 min ends the session, and switch-on without mfa is refused through the public path, in `tests/mvp-c/c08-c09-operator-headers.integration.test.ts`), C-09 (HSTS, CSP nonce, `frame-ancestors 'none'`, nosniff, Referrer-Policy; body over 64 KB 413; COST-3 limits 429), C-11 (a child process running the app is killed with SIGKILL between capture send and answer; after restart the order is terminal or frozen within two reconciler passes; run from `scripts/c11-restart.integration.test.ts` because only scripts may spawn), C-12 (webhook and poller on one order at once: one transition, one sale). The gate report lists C-01, C-10 (real part), C-13 and the real halves of C-06 and C-07 as "owner window", with the steps that prove them in `docs/owner/MVPC-OWNER-STEPS.md`, written in the same short, exact style as `MVPB-OWNER-STEPS.md` (host prerequisites O-C1 to O-C8, deploy, approval row for `mvp_c_refunds`, resume, webhook registration, one genuine delivery, one partial and one full refund, evidence to bring back).

Inputs: every CO lane, BU-2 (fake Wire seam), `tests/mvp-b/*` (patterns), `docs/evidence/TEMPLATE-gate-report.md`, mvp-plan MVP-C, nfr.md section 1.3.

Outputs: `tests/mvp-c/{c02-c05-webhooks, c06-c07-refunds, c08-c09-operator-headers, c12-race}.integration.test.ts`, `tests/mvp-c/c-offline.adversarial.test.ts`, `scripts/c11-restart.integration.test.ts`, `docs/evidence/mvp-c-offline-gate-<date>.md`, `docs/owner/MVPC-OWNER-STEPS.md`, `docs/READINESS.md` (one new section). One `NAMED_EXEMPTIONS` entry (no-package-escape for `tests/mvp-c`) and its pin if the folder needs it.

Order: commit 1 is the tests, run red against main before the last CO lane merges if useful, then green on the merged main. No product code changes in this lane: a failing twin is a stop-and-report to the owning lane.

Acceptance tests:

- `corepack pnpm vitest run --project integration tests/mvp-c scripts/c11-restart.integration.test.ts`: every C id above passes, each test title starts with its id.
- `corepack pnpm vitest run --project adversarial tests/mvp-c/c-offline.adversarial.test.ts`: zero `net.connect`, `tls.connect`, `http(s).request`, `dns.lookup` and `fetch` calls across the whole C run.
- `corepack pnpm ci && corepack pnpm check:hosting`: exit 0; `corepack pnpm mutation --targets packages/paypal/src/webhook-verify.ts,domain/payments/src/webhooks.ts,domain/payments/src/refunds.ts,domain/access-clock/src/compute.ts --require-targets`: each at least 80 percent.
- gitleaks on the full history: no finding.

Do not: change product code or other lanes' tests; mark an owner-window item as passed; connect to anything.

Evidence for the PR: the gate report with each C id, PASS or OWNER WINDOW, and the command output; open findings by severity (zero critical or high to pass).

Branch: `feat/mvp-c-offline-gate` Commit: `test(mvp-c): offline acceptance twins, gate evidence, owner steps (CO-G)`
