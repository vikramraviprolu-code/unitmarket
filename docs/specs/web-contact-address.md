Task: Replace the placeholder contact address with the owner-supplied real one.
Package: apps/web (copy and tests), docs Owner: YC Reviewer: Vikram or Sakthi (not the author)
Goal: Every place the product shows the team contact address shows `unitmarket@raviprolu.com`, the
address the owner supplied on 2026-11-07 (an alias under the owner's admin mailbox; delivery not yet
tested by anyone). The placeholder `contact@unitmarket.example` no longer appears in code, tests or
golden files. Wording around the address does not change. Closes the "real contact address" row of
`docs/public-release-checklist.md`, except the delivery test, which stays with the owner.
Inputs: owner message of 2026-11-07 (address and alias status); D-106 (placeholder history).
Outputs: `apps/web/src/lib/account-copy.ts` (CONTACT_ADDRESS), `apps/web/src/lib/legal-copy.ts` (two
paragraphs), the two golden text files, the two golden tests, `apps/web/e2e/accounts.spec.ts`,
`docs/public-release-checklist.md`, `docs/decision-log.md` (row D-107).
Acceptance tests:

- `git grep -n "contact@unitmarket.example" -- apps packages` prints nothing.
- `corepack pnpm test:golden` passes, with the same test count as before (587).
- `corepack pnpm exec vitest run apps/web/src/account-copy.golden.test.ts apps/web/src/legal-copy.golden.test.ts` passes.
- `corepack pnpm lint && corepack pnpm typecheck && corepack pnpm format:check` pass.
- `corepack pnpm check:secrets-names` passes (an email address is not a secret).
  Do not: touch other packages; add dependencies; change any wording except the address; change a contract;
  send mail or test delivery from this session; touch the deploy, the PayPal flag or any approval.
  Evidence for the PR: command output for the five bullets; the commit 1 run showing the golden tests red.
  Branch: feat/web-contact-address Commit: test(web): contact address goldens (UNI-83) then feat(web): real contact address (UNI-83)
