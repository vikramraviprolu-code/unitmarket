Task: Replace "No commission in this demo." with the owner-approved platform fee sentence.
Package: apps/web, domain/publisher-console (copy and tests) Owner: YC Reviewer: Vikram or Sakthi (not the author)
Goal: The publisher terms page and the publisher statement show the owner-approved sentence of 2026-11-07, verbatim:
"A platform fee of 10 percent of the publisher price is added to the price shown. The publisher does not pay it."
The shipped fee (POB-M1, D-089, D-096 (2)) makes the old sentence untrue for offers published through the web import.
Inputs: owner message of 2026-11-07 (wording approved); BR-FEE-1 reconciliation (PR 61).
Outputs: `domain/publisher-console/src/settlement.ts` (COMMISSION_LINE and its comment),
`apps/web/src/lib/legal-copy.ts` (publisher terms paragraph), the two golden text files, and the tests that pin the
old sentence (`settlement.test.ts`, `publisher-console.state.test.ts`, `legal-copy.golden.test.ts`, `gate-final2.test.ts`).
Acceptance tests:

- `git grep -n "No commission in this demo" -- apps domain packages` prints nothing.
- `corepack pnpm exec vitest run domain/publisher-console/src/settlement.test.ts apps/web/src/publisher-console.state.test.ts apps/web/src/legal-copy.golden.test.ts apps/web/src/gate-final2.test.ts` passes.
- `corepack pnpm test:golden` passes with the same test count (587).
- `corepack pnpm lint && corepack pnpm typecheck && corepack pnpm format:check` pass.
  Do not: change any other wording; read the rate from the database (follow-up, see below); touch submission docs
  (owner text); change the heading "Commission".
  Known limit: the percentage is written in the copy. If an operator changes the fee setting the sentence goes stale
  until the copy is changed. Follow-up: render the rate from the stored setting.
  Test edits: `gate-final2.test.ts` pinned the old sentence and a "no plan" check; it now pins the new sentence and
  keeps the "no 20 percent / not implemented" check. This contradicts the spec only in the sentence itself.
  Evidence for the PR: the commit 1 run showing the tests red; the commands above green.
  Branch: feat/web-fee-copy Commit: test(web): fee sentence goldens (BR-FEE) then feat(web): platform fee sentence (BR-FEE)
