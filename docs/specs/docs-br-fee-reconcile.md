Task: Reconcile BR-FEE-1, -3 and -7 with the implemented fee and payout behaviour.
Package: docs/business-rules Owner: YC Reviewer: Vikram or Sakthi (not the author)
Goal: The business rules reference describes what main `660bb62b` does for the platform fee, settlement and fee
timing, cites the implementation by file and line, and keeps the 4 Nov wording as an accurate historical record.
Documentation only; no code, copy or behaviour changes.
Inputs: D-089, D-096, migration 0029, `domain/catalogue/src/fee.ts`, `domain/ledger/src/parts.ts`,
`domain/payments/src/payout.ts`, `apps/web/src/app/api/ops/fee/route.ts`, `apps/web/src/lib/legal-copy.ts`.
Outputs: `docs/business-rules/business-rules-reference.md` (rows BR-FEE-1, -3, -7, the two summary lines, section 15
item 2, new section 6a), `docs/business-rules/configurable-rules-design.md` (two status notes).
Acceptance tests:

- `git grep -n "CONFLICT" -- docs/business-rules/business-rules-reference.md` shows BR-FEE-1 and -3 only in the history table of section 6a, not in section 6 or the summary table.
- `corepack pnpm exec prettier --check docs/business-rules docs/specs` passes.
- `corepack pnpm check:secrets-names` passes.
- Each file and line cited in the three rows exists on `660bb62b` (reviewer spot check with `sed -n`).
  Do not: touch code, copy or goldens; claim a PR number that was not checked; hide the open items (legal copy, second
  operator, payout delay).
  Evidence for the PR: the diff, the check output, the list of open items in section 6a.
  Branch: docs/br-fee-reconcile Commit: docs(business-rules): reconcile BR-FEE-1, -3, -7 (BR-FEE)
