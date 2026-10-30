Task: fix the defects the Opus end-to-end gate 3-5 found on main (lane GATE35-FIX)
Package: apps/web (plus one line in domain/ledger-free copy files only) Owner: builder Reviewer: coordinator (Opus)
Goal: the unpaid item page agrees with the library and offers no dead receipt link; the refund policy says
only what is true; the operator without the authenticator code is told why; payee and fee words match the
stored facts; the publisher sales page counts paid units only; a publisher is told /discover is for
buyers; the home search runs and survives sign in; narrow tables hint at sideways scroll; e2e screenshots
stop rewriting tracked files. No money path, no globals.css, labels from stored data, no dashes or italics.
Not in this lane: links from /publisher and /ops to their sub-pages (PUB-D).

Inputs: lib/buyer-copy.ts, legal-copy.ts, payee-copy.ts, statement-copy.ts, the pages named below.
Outputs (all under apps/web):

- D2 library/[entitlement]/page.tsx, lib/buyer-copy.ts: Payment line says "Not paid yet" when the status
  is NOT_PAID_YET; "View receipt" only when receipt_versions is not empty.
- D3 lib/legal-copy.ts, golden/legal-copy.golden.txt: refund policy says there is no refund request form
  yet; the only help case from an item is "The content did not open"; an operator reads cases and decides.
- D4b app/ops/payee-requests/page.tsx, lib/payee-copy.ts: an operator without the code sees a plain message.
- D5 lib/payee-copy.ts, payout-account/page.tsx, lib/statement-copy.ts, sales and statement pages,
  lib/legal-copy.ts: "marked as checked" wording unless an operator verified a request; dry run fee shows
  "Not reported"; privacy notice and sign-in note name the um_skin cookie (skin name only).
- D6 sales/page.tsx, lib/statement-copy.ts: count and list only paid units; the rest is one note.
- D7 discover/page.tsx, lib/nav.ts: a signed in publisher or operator gets a plain line and a link home
  (a rendered page, not a redirect, so PUB-D files stay untouched).
- D8 lib/next-path.ts (safeNext moved out of signin/page.tsx), discover/DiscoverForm.tsx: the sign in link
  keeps the typed need in next=; a need arriving in the URL runs the search for a signed in buyer.
- D9 home shelf already passes the stored option label as the tag (verified); pinned by a test.
- D10 app/tables.css (new), publisher/sales/page.tsx: "Scroll sideways to see more" hint at narrow width.
- D11 e2e/zcomposite.spec.ts, playwright.config.ts: screenshots go to apps/web/test-results/shots.
  Tests: src/gate35-fixes.test.ts (new, unit); pinned copy updated only where it was wrong (see PR report).

Acceptance tests (run from the repo root, expected: all pass):

- `corepack pnpm exec vitest run apps/web/src/gate35-fixes.test.ts` (red first, then green)
- `corepack pnpm exec vitest run apps/web/src/legal-copy.golden.test.ts apps/web/src/legal.state.test.ts apps/web/src/payee-copy.golden.test.ts apps/web/src/statement-copy.golden.test.ts apps/web/src/gate12-copy.test.ts apps/web/src/payee.state.test.ts apps/web/src/publisher-console.state.test.ts`
- `corepack pnpm lint && corepack pnpm typecheck && corepack pnpm format:check`
- `corepack pnpm check:isolation && corepack pnpm check:no-live-host && corepack pnpm check:secrets-names`
- `corepack pnpm --filter @umsbx/web build` succeeds.
  Do not: touch money-path code, globals.css, other packages, add dependencies, edit PUB-D files for links.
  Evidence: red run of the new test, final counts, browser check on an offline dry run with synthetic values.
  Branch: fix/gate35 Commit: fix(web): <what> (GATE35-FIX)
