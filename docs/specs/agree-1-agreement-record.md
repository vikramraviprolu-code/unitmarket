Task: A seeded, read-only record of each demo publisher's acceptance of the publisher terms (memo Q1 and Q27, owner default)
Package: packages/db (migration 0015), domain/catalogue, apps/web (composition, two pages, copy) Owner: AGREE-1 builder Reviewer: Sakthi (coordinator)
Goal: Each demo publisher has one append-only record of accepting the current publisher terms version: terms_version, accepted_at,
accepted_by_label (a demo label, no personal data), method 'seeded_demo'. The record is written only by the boot seed and read only
through a domain read function. There is no click-through gate and no write route: a publisher can never create or edit it. The
publisher home (S1) shows it read only with a link to /legal/publisher-terms. The operator publishers page (S7) shows it per
publisher and flags "terms version changed, not re-accepted" when the stored version differs from the current one. Applicants
(status applied) have no record and show "not accepted". The version comes from one constant, PUBLISHER_TERMS_VERSION, in the legal
copy module.
Inputs: apps/web/src/lib/legal-copy.ts, domain/catalogue seed data (demo publisher slugs), migration 0013 as the style model.
Outputs: packages/db/migrations/common/0015_publisher_agreements.sql (new table publisher_agreements, append-only triggers, no
defaults, no delete; 0014 belongs to PUB-E1 and is not required); domain/catalogue/src/agreements.ts (seedAgreements,
getAgreement, listAgreements) exported from the index; composition: boot seed call, engine.publisherAgreement(actor),
engine.opsAgreements.list(actor); apps/web/src/lib/agreement-copy.ts; edits to app/publisher/page.tsx and app/ops/publishers/page.tsx;
PUBLISHER_TERMS_VERSION in legal-copy.ts. Existing CSS classes only; globals.css is not edited.
Acceptance tests (run from the worktree root, each prints a pass count and no failures):

- corepack pnpm exec vitest run packages/db/src/migration-0015.state.test.ts : table exists, applied once, appended after earlier ones, no
  DEFAULT, no update/delete/truncate, method CHECK, one row per publisher and version.
- corepack pnpm exec vitest run domain/catalogue/src/agreements.state.test.ts : seed gives the demo publishers a record at the given
  version, a second run adds nothing, applicants get none, a bumped version is not seeded over an existing record, a publisher reads only its own.
- corepack pnpm exec vitest run apps/web/src/agreement.state.test.ts : engine.publisherAgreement is own-record only; opsAgreements.list needs
  an operator with the second factor; no route or action file writes publisher_agreements; page sources show the sentence, the link, the flag.
- corepack pnpm exec vitest run apps/web/src/agreement-copy.golden.test.ts : the copy matches golden/agreement-copy.golden.txt.
- corepack pnpm exec vitest run apps/web/src/maintenance.adversarial.test.ts : unchanged and green (no new write route).
  Do not: add a write route or form; add a click-through gate; edit globals.css; add a dependency; change contracts or earlier migrations.
  Evidence for the PR: red run of the new tests, then green; counts of the six suites.
  Branch: feat/agree-1 Commit: feat(web): seeded read-only publisher agreement record (AGREE-1)
