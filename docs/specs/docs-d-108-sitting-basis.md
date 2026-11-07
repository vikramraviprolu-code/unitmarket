Task: Record the owner's written approval basis for the next hosted sandbox sitting (D-108).
Package: docs Owner: YC Reviewer: Vikram or Sakthi (not the author)
Goal: `docs/decision-log.md` holds a row D-108 with the owner's own approval sentence of 2026-11-07, the terms
of D-103 unchanged, the reference the secret `UMS_OUTBOUND_APPROVAL_REF` must hold, and the statement that the row
authorizes no insertion, flag, deploy or PayPal call. Documentation only.
Inputs: the owner's message of 2026-11-07 (quoted in the row); D-103 for the terms.
Outputs: `docs/decision-log.md` (row D-108), this spec.
Acceptance tests:

- `git grep -n "^| D-108 |" -- docs/decision-log.md` prints one row.
- The terms in D-108 equal those in D-103: `scope`, five operations, 500 minor units, 40 calls, four hours.
- `corepack pnpm exec prettier --check docs/decision-log.md docs/specs/docs-d-108-sitting-basis.md` passes.
- `corepack pnpm check:secrets-names` passes.
  Do not: insert an approval row; set the connect flag; touch the secret, the service or any code; add terms wider
  than D-103.
  Evidence for the PR: the row, the check output. After merge the owner runs the steps of
  `docs/owner/MVPC-OWNER-STEPS-GCP.md` Step I at their own terminal; no agent takes part.
  Branch: docs/d-108-sitting-basis Commit: docs(decisions): D-108 sandbox sitting basis (D-108)
