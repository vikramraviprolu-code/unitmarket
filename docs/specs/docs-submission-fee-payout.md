Task: Correct the Devpost submission texts for the shipped fee and payout design.
Package: docs/submission Owner: YC Reviewer: Vikram or Sakthi (not the author)
Goal: `docs/submission/submission-text.md` and `testing-instructions.md` no longer say "No commission", "planned 20
percent, not implemented", or that UnitMarket "never holds a publisher's money and uses no payout service". They say what
main `660bb62b` does: a 10 percent platform fee on top on offers published through the web import (seeded demo offers
carry no fee), a payout step after the access window that is built and tested in dry run only, and one sandbox test
account for every sandbox sale. Documentation only. Owner text: wording is for the owner to approve.
Inputs: D-089, D-096, `docs/business-rules/business-rules-reference.md` section 6a, PR 67 (fee sentence).
Outputs: the two submission files and this spec.
Acceptance tests:

- `git grep -n -i -E "no commission|20 percent|never holds|uses no payout" -- docs/submission` prints nothing.
- `corepack pnpm exec prettier --check docs/submission docs/specs/docs-submission-fee-payout.md` passes.
- `corepack pnpm check:secrets-names` passes.
  Do not: change evidence claims (real sittings, dates, evidence file links); claim a real payout or a second merchant;
  touch code or copy.
  Evidence for the PR: the diff and the check output.
  Branch: docs/submission-fee-payout Commit: docs(submission): fee and payout wording (BR-FEE)
