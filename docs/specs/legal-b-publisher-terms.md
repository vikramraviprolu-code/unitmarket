# Spec: publisher terms rewrite and honest docs (LEGAL-B, DOC-FIX)

Task: say in plain English, and only what the product does today, what a publisher agrees to; add the honest settlement lines to the README and submission docs; correct the payee claim in the overnight plan.
Package: `apps/web` (copy and tests), docs Owner: builder Reviewer: Opus; owners approve the text
Branch: `feat/legal-b` Commit: `type(web): <what> (LEGAL-B)` Decisions: the owner approved the (a) demo defaults of `docs/design/publisher-questions-recommendations-2026-10-31.md` for Q2, Q3, Q16 to Q21, Q25, Q27, Q28 (non security items).

Goal: the publisher terms page covers: not exclusive; rights confirmation per revision and our licence to sell single article access; buyers get personal use access for the window shown; takedown is withdraw plus a full refund if an operator decides; corrections are new articles; refunds decided by an operator and PayPal keeps its fee; no Disputes API, evidence is the stored delivery record; offboarding is suspension, buyers keep access; commission none, planned 20 percent, not implemented; no tax and no tax invoice; contact placeholder; no governing law named. Banner stays "Draft for owner approval. This is not legal advice." No dashes, no italics, none of the words the copy rules bar.

Outputs: `apps/web/src/lib/legal-copy.ts` (publisher doc only), `apps/web/src/golden/legal-copy.golden.txt`, `apps/web/src/legal-copy.golden.test.ts` (one new test), `README.md`, `docs/submission/submission-text.md`, `docs/submission/testing-instructions.md`, `docs/specs/overnight-plan.md` (MT-5 claim only).
Acceptance tests:
- `corepack pnpm test:golden apps/web/src/legal-copy.golden.test.ts`: passes (red before the copy change).
- `corepack pnpm test:state apps/web/src/legal.state.test.ts`: passes unchanged.
- `corepack pnpm check:no-live-host` and `corepack pnpm check:secrets-names`: pass.
- `corepack pnpm exec prettier --check` on the changed files: passes.
Do not: touch other pages, tests whose pinned copy did not change, code outside the files above, add dependencies.
