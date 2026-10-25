# DP-6: MVP-D offline gate: acceptance twins D-01 to D-07, evidence and owner steps

Task: run every MVP-D acceptance test that needs no PayPal as an offline twin through public entry points, write the gate evidence, and write the owner steps for the MVP-D sandbox run.
Package: `tests/mvp-d`, `docs/evidence`, `docs/owner`, `docs/READINESS.md`, `docs/ASSUMPTIONS.md` Owner: Sonnet 5.5 builder, effort high (gate) Reviewer: Opus 5.5 high, full gate review in SOP 22 format; Sakthi merges
Wave: MVP-D W5, after DP-5. Decisions: D-041 (payees, P18) and D-042 (approval row, ASM-55 waiver for the single MVP-D sitting), both decided; the offline twins need none. Requirements: mvp-plan MVP-D table and gates; nfr.md MVP-D list (SOP 16 if uploads exist, P18, P5 per unit, P11 per publisher).

Goal. One file per group under `tests/mvp-d`, each test titled by its id, through `createApp` and the route handlers (as `tests/mvp-c` does). Dry-run model only, never a socket:

- D-01 `two_captures`: two capture ids, one per publisher, per-item entitlements (offline twin of the real run).
- D-02 `partial_capture`: one captured, one declined: `paid_partial`, captured items available, the declined item locked and not charged, case opened.
- D-03 `no_substitution`: no order, quote, proposal or approval appears after the partial.
- D-04 `unverified_payee_refused`: no snapshot for a publisher without `payee_verified_at`, also when it is lost between approval and order.
- D-05 `per_unit_match`: a unit mismatch after capture puts that provider order on hold (mismatch flag, `frozen_order`, never "not charged"); a mismatch in the pre-capture pass freezes the order with zero captures.
- D-06 `ledger_per_publisher`: INV7 after happy, partial and refund.
- D-07 `mixed_currency`: refused before approval.

Also covered:

- The continuation: a crash or kill switch between the two captures ends with exactly one PO2 capture.
- The pack window: abandoned, nothing charged.
- `d-offline.adversarial.test.ts`: zero `net.connect`, `tls.connect`, `http(s).request`, `dns.lookup` and `fetch` across the whole D run.
- The A, B and C suites still green.
- SOP 16: there is no upload endpoint in MVP-D (content is seeded), so it is recorded as not applicable with that reason.

The gate report lists D-01 (real half) as "owner window" and D-02 real as "not attempted" (D-042). `docs/owner/MVPD-OWNER-STEPS.md` follows the style of `MVPC-OWNER-STEPS.md`:

- Prerequisites: D-041 and D-042 recorded. The sitting is local (the owner's laptop) with the webhook OFF. The coordinator decided this so that ASM-66 does not arise. A hosted webhook run added later needs its own ASM-66 waiver.
- The approval row: the owner writes the decision-log row with the fields D-042 lists. The operations list leaves out `verify_webhook_postback` and `fetch_webhook_cert`, and leaves out `refund_capture` and `get_refund` unless a real composite refund is in the sitting. The owner then inserts the matching `outbound_approvals` row with `pnpm safety:approve` at his own TTY. The calls-per-day figure is derived from the overview's call budget (at most 13 per happy pack, plus continuation reads).
- `pnpm safety:resume` at the owner's TTY, after the approve step above.
- One two-publisher pack through both approvals, within the pack window.
- The evidence to bring back: two order ids and two capture ids (last 6 characters), debug ids, a `provider_calls` count of at most 13 for a happy pack (more only if the continuation ran, with the reason), and the sentence "Two publishers settled as two PayPal orders into one test merchant account; multi-merchant payout not demonstrated" (D-041).
- The stop conditions: any capture before both approvals, any create with two units, any create body naming a payee, any `DUPLICATE_INVOICE_ID`, and any payee in a read-back other than the stored one.
- `safety:stop` at the end.

New ASSUMPTIONS rows record D-041, D-042 and the coordinator's table A decisions. ASM-75 already exists, with status unverified.

Inputs: DP-1 to DP-5, `tests/mvp-c/*` (patterns), `docs/evidence/TEMPLATE-gate-report.md`, mvp-plan MVP-D, nfr.md MVP-D list.

Outputs: `tests/mvp-d/{d01-d03-composite, d04-d05-gates-match, d06-d07-ledger-currency, continuation}.integration.test.ts`, `tests/mvp-d/d-offline.adversarial.test.ts`, `tests/mvp-d/{d-support.ts, package.json, tsconfig.json}`, `pnpm-lock.yaml` (the new workspace package; `pnpm install --frozen-lockfile` must pass after), `docs/evidence/mvp-d-offline-gate-<date>.md`, `docs/owner/MVPD-OWNER-STEPS.md`, `docs/READINESS.md` (one section), `docs/ASSUMPTIONS.md` (rows), and one `NAMED_EXEMPTIONS` entry (no-package-escape for `tests/mvp-d`) with its pin if needed.

Order: commit 1 is the tests, run red against the merge point of DP-5 if useful, then green. No product code changes in this lane: a failing twin is a stop-and-report to the owning lane.

Acceptance tests:

- `corepack pnpm vitest run --project integration tests/mvp-d`: D-01 to D-07 and the continuation pass, each title starting with its id.
- `corepack pnpm vitest run --project adversarial tests/mvp-d/d-offline.adversarial.test.ts`: zero socket, TLS, DNS or fetch calls.
- `corepack pnpm vitest run --project integration tests/mvp-a tests/mvp-b tests/mvp-c`: still green.
- `corepack pnpm run ci`: exit 0.
- `corepack pnpm mutation --targets domain/payments/src/composite.ts,domain/payments/src/apply.ts,domain/payments/src/due.ts,domain/ledger/src/sums.ts --require-targets`: each at least 80 percent.
- `gitleaks git --no-banner --redact` on the full history (Sakthi, if the binary is absent in the container): no finding.

Do not: change product code or other lanes' tests; mark an owner-window item as passed; write the approval row (the owner does); connect to anything.

Evidence for the PR: the gate report with each D id marked PASS, OWNER WINDOW or NOT ATTEMPTED, the command output, and open findings by severity (zero critical or high to pass).

Branch: `feat/mvp-d-offline-gate` Commit: `test(mvp-d): offline acceptance twins, gate evidence, owner steps (DP-6)`
