# DP-6: MVP-D offline gate: acceptance twins D-01 to D-07, evidence and owner steps

Task: run every MVP-D acceptance test that needs no PayPal as an offline twin through public entry points, write the gate evidence, and write the owner steps for the MVP-D sandbox run.
Package: `tests/mvp-d`, `docs/evidence`, `docs/owner`, `docs/READINESS.md`, `docs/ASSUMPTIONS.md` Owner: Sonnet 5.5 builder, effort high (gate) Reviewer: Opus 5.5 high, full gate review in SOP 22 format; Sakthi merges
Wave: MVP-D W5, after DP-5. Prerequisites: every OQ answered or explicitly deferred in `docs/decision-log.md`. Requirements: mvp-plan MVP-D table and gates; nfr.md MVP-D list (SOP 16 if uploads exist, P18, P5 per unit, P11 per publisher).

Goal. One file per group under `tests/mvp-d`, each test titled by its id, through `createApp` and the route handlers (as `tests/mvp-c` does), dry-run model only, never a socket: D-01 `two_captures` (two capture ids, one per publisher, per-item entitlements; offline twin of the real run), D-02 `partial_capture` (one captured, one declined: `paid_partial`, captured items available, failed item locked and not charged, case opened), D-03 `no_substitution` (no order, quote, proposal or approval appears after the partial, across every recovery path), D-04 `unverified_payee_refused` (no snapshot for a publisher without `payee_verified_at`; also when it is lost between approval and order), D-05 `per_unit_match` (unit mismatch after capture freezes that provider order only; order-level mismatch before capture freezes the order with zero captures), D-06 `ledger_per_publisher` (INV7 per publisher after happy, partial and refund), D-07 `mixed_currency` (refused before approval). Plus `d-offline.adversarial.test.ts` (zero `net.connect`, `tls.connect`, `http(s).request`, `dns.lookup`, `fetch` across the whole D run) and the A and C suites still green (no regression of the single-publisher path). SOP 16: there is no upload endpoint in MVP-D (content is seeded), so it is recorded as not applicable with that reason. The gate report lists D-01 (real half) and D-02 (real, only if the sandbox can produce a decline: UNVERIFIED, not assumed) as "owner window". `docs/owner/MVPD-OWNER-STEPS.md`, in the style of `MVPC-OWNER-STEPS.md`: the decision-log approval row the owner writes (OQ-13: scope, operations, cap per PayPal order and the pack total, calls per day, valid until, operator, and the payee mapping stated plainly, for example "Harbour Ledger and Quayside Gazette are both paid into the owner's own sandbox Business account (…last 4); this proves two PayPal orders and two captures, not two merchants"), `safety:approve` and `safety:resume` at the owner's TTY, one two-publisher pack through both approvals, the evidence to bring back (two order ids and two capture ids, last 6 characters, debug ids, `provider_calls` count at most 13), the stop conditions (any capture before both approvals, any create with two units, any payee other than the stored one, any `DUPLICATE_INVOICE_ID`), and `safety:stop` at the end. New ASSUMPTIONS rows for the accepted OQ answers.

Inputs: DP-1 to DP-5, `tests/mvp-c/*` (patterns), `docs/evidence/TEMPLATE-gate-report.md`, mvp-plan MVP-D, nfr.md sections 1.3 and the MVP-D list.

Outputs: `tests/mvp-d/{d01-d03-composite, d04-d05-gates-match, d06-d07-ledger-currency}.integration.test.ts`, `tests/mvp-d/d-offline.adversarial.test.ts`, `tests/mvp-d/{d-support.ts, package.json, tsconfig.json}`, `docs/evidence/mvp-d-offline-gate-<date>.md`, `docs/owner/MVPD-OWNER-STEPS.md`, `docs/READINESS.md` (one section), `docs/ASSUMPTIONS.md` (rows), one `NAMED_EXEMPTIONS` entry (no-package-escape for `tests/mvp-d`) and its pin if needed.

Order: commit 1 is the tests, run red against the merge point of DP-5 if useful, then green. No product code changes in this lane: a failing twin is a stop-and-report to the owning lane.

Acceptance tests:

- `corepack pnpm vitest run --project integration tests/mvp-d`: D-01 to D-07 pass, each title starts with its id.
- `corepack pnpm vitest run --project adversarial tests/mvp-d/d-offline.adversarial.test.ts`: zero socket, TLS, DNS or fetch calls.
- `corepack pnpm vitest run --project integration tests/mvp-a tests/mvp-b tests/mvp-c`: still green.
- `corepack pnpm ci`: exit 0; `corepack pnpm mutation --targets domain/payments/src/composite.ts,domain/payments/src/apply.ts,domain/ledger/src/sums.ts,domain/recovery/src/cases.ts --require-targets`: each at least 80 percent.
- gitleaks on the full history: no finding.

Do not: change product code or other lanes' tests; mark an owner-window item as passed; write the approval row (the owner does); connect to anything.

Evidence for the PR: the gate report with each D id, PASS or OWNER WINDOW, the command output, open findings by severity (zero critical or high to pass).

Branch: `feat/mvp-d-offline-gate` Commit: `test(mvp-d): offline acceptance twins, gate evidence, owner steps (DP-6)`
