# Spec: operator side of publisher onboarding, applicants (PUB-E2)

Task: the operator adds an applicant, then approves or rejects it, on `/ops/publishers`.
Package: `domain/catalogue` (applicants), `packages/db` (migration 0013), `apps/web` Owner: builder (Sonnet) Reviewer: Opus
Branch: `feat/pub-e2-applicants` Commit: `type(<package>): <what> (PUB-E2)` Decisions: D-041, D-051; proposal 3A, 3I.
Closes the PUB-D gap: "approving an applicant is not built; the route refuses it with not_allowed".

Goal: an operator-visible applicant record, not self-service signup. Nobody creates an account by themselves. An approved
applicant gets no sign-in until the owners add a persona and passcode (the personas are a fixed list in composition).

Behaviour:

- Migration `0013_publisher_applicants.sql` (forward-only, no defaults, no down step): table `publisher_applicant_decisions`
  (id, publisher_id UNIQUE, decision `approved|rejected`, operator_id, reason, created_at, updated_at), append-only like
  `payee_decisions`. The 0012 CHECK has no `rejected` status, so a rejection is a decision row; the publisher stays `applied`.
- `domain/catalogue/src/applicants.ts` (operator with the second factor only, every call):
  `addApplicant({slug, display_name, country, reason})` inserts a `publishers` row with status `applied`, no payee, no
  offers; slug `^[a-z0-9]+(-[a-z0-9]+)*$` 3 to 40 chars, unique (`slug_taken`); country two capital letters; name 2 to 80
  chars; reason 3 to 200. `decideApplicant({publisher_id, decision: approve|reject, reason})` (reason 3 to 200): only an
  `applied` publisher with no decision; approve sets `active`; reject keeps `applied`. A second decision is
  `already_decided`; `active` or `suspended` is `not_allowed` (suspended stays suspended). `listApplicants` returns
  `applied` rows with state `pending|rejected`. One `audit_log` row per change. Orders, units, ledger, approvals untouched.
- Routes (operator, MFA, CSRF, `.strict()`, 20 per hour per actor): `POST /api/ops/publishers/applicants` (add),
  `POST /api/ops/publishers/applicants/decision`. Engine: `opsApplicants.{list,add,decide}`.
- Page: an Applicants section on `/ops/publishers` (existing classes, no `globals.css`, no inline style) with an add form
  and Approve and Reject with a reason. Applied publishers leave the main cards. Copy in `lib/ops-applicants-copy.ts`
  says an approved applicant cannot sign in until the owners add a persona and passcode.

Tests first: `domain/catalogue/src/applicants.state.test.ts`, `packages/db/src/migration-0013.state.test.ts`,
`apps/web/src/ops-applicants.adversarial.test.ts` (publisher, buyer, anonymous, operator without MFA, guessed ids, mass
assignment, duplicate slug, transitions only applied to active and rejected, suspended stays suspended, one audit row,
money tables unchanged), `apps/web/src/ops-applicants-copy.golden.test.ts`, maintenance walk lists both routes.

Acceptance: `corepack pnpm test:state domain/catalogue packages/db apps/web`, `corepack pnpm test:adversarial apps/web`,
`corepack pnpm test:golden apps/web`, `corepack pnpm check:routes`, lint, typecheck, format check. All pass.
Do not: change `domain/approval`, `domain/payments`, the ledger, migration 0012, `globals.css`; make signup dynamic.
Evidence: red run, outputs, follow-ups (Supabase policies for the new table), cost line.
