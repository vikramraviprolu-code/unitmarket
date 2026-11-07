Task: Remove the contradiction between "there are no fees" and the platform fee in the publisher terms.
Package: apps/web (copy and tests) Owner: YC Reviewer: Vikram or Sakthi (not the author)
Goal: The publisher terms no longer say "there are no fees" while the Commission section states a 10 percent platform
fee. Proposed wording (owner to approve): "In this demo either side may stop at any time at no charge. The only fee is
the platform fee described under Commission." Found by the read-only public QA of the live site on 2026-11-07.
Inputs: QA report finding; PR 67 (the Commission sentence); `apps/web/src/lib/legal-copy.ts` line 227.
Outputs: `apps/web/src/lib/legal-copy.ts`, `apps/web/src/golden/legal-copy.golden.txt`,
`apps/web/src/legal-copy.golden.test.ts`.
Acceptance tests:

- `git grep -n "there are no fees" -- apps` prints nothing.
- `corepack pnpm exec vitest run apps/web/src/legal-copy.golden.test.ts` passes.
- `corepack pnpm test:golden` passes with the same test count.
- `corepack pnpm lint && corepack pnpm typecheck && corepack pnpm format:check` pass.
  Do not: change any other wording; deploy (a deploy resets the PayPal flag; this ships with the next planned deploy).
  Evidence for the PR: commit 1 run red; the commands above green.
  Branch: feat/web-terms-fee-wording Commit: test(web): terms fee wording (UNI-83) then feat(web): terms fee wording (UNI-83)
