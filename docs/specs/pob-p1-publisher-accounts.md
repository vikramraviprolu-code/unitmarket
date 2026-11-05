# Spec: publisher accounts, invite, claim, terms and PayPal link (POB-P1)

Task: a new publisher goes from approval to a signed-in, terms-accepted account with a linked PayPal address, with no code change or deploy.
Package: `packages/security` (accounts reuse), `packages/db` (migration, planned 0028), `domain/catalogue`, `apps/web` Owner: builder (Sonnet) Reviewer: Opus (sign in surface, one round)
Branch: `feat/pob-p1-publisher-accounts` Commit: `feat(<package>): <what> (POB-P1)` Decision: D-089. Journey steps J2 to J6.

Goal: after an operator approves an applicant, the operator sees a one time invite code, once. The publisher claims an account with
it, signs in with a username and password, accepts the publisher terms with a real action, and links their own PayPal address, which
an operator verifies. The three demo personas keep working unchanged. UnitMarket never creates a PayPal account.

Inputs: `packages/security/src/accounts.ts` and `packages/db/migrations/common/0016_buyer_accounts.sql` (the buyer account model: scrypt
hash, policy, lockout, dummy hash for timing); `domain/catalogue/src/applicants.ts` (`decideApplicant`), `agreements.ts` (method is
typed `seeded_demo` only), `payee.ts` (existing payee request and operator verify); `apps/web/composition.server.ts` (sign in, actor
for a publisher persona); `apps/web/src/app/signin/seller/`, `app/publisher/payout-account/`, `app/ops/publishers/`.

Behaviour:

- Migration, planned 0028 (forward only, no defaults, no new dependency): `publisher_accounts` (publisher_id PK references publishers, username
  unique with the buyer pattern, password_hash, failed_attempts, locked_until, password_changed_at, created_at, updated_at);
  `publisher_invites` (id, publisher_id, code_hash, expires_at, used_at, created_by, created_at; a code is stored only as a hash, 7 day
  expiry, one live invite per publisher, a new invite voids the old); `publisher_paypal_links` (publisher_id PK, paypal_email, state
  `requested` or `verified`, verified_by, verified_at, created_at, updated_at); and allows agreement method `publisher_accepted`.
- Invite: `decideApplicant` approve (or an operator "issue invite" action for an active publisher with no account) returns the code
  once, 12 characters from a 32 symbol alphabet, shown on the operator screen only, never logged or audited in clear (audit row says
  issued, not the code). Operator reissue and "reset sign in" (voids the account password, issues a new invite) exist, with reason, second factor.
- Claim: public route `POST /api/publisher-accounts/claim` {code, username, password}: code hash match and unexpired and unused,
  username and password policy and lockout exactly as buyers (reuse `checkPasswordPolicy`, scrypt, dummy hash so a wrong code costs the
  same as a right one). Success creates the account, marks the invite used, signs in as the publisher (session as the persona flow).
- Sign in: `POST /api/session` accepts a publisher username and password as it does for buyers, resolving to the publisher actor.
  Wrong guesses are counted and locked as for buyers. Demo personas and the publisher passcode path are untouched.
- Terms: `POST /api/publisher/terms/accept` (publisher actor, CSRF) writes an agreement record with method `publisher_accepted`, the
  current `PUBLISHER_TERMS_VERSION`, accepted_by_label the username. The publisher page shows accepted or not; a changed version shows
  as changed (existing chip). Seeded demo records stay.
- PayPal link: the publisher enters the email of their own PayPal Business account on the payout page (`requested`); an operator with
  the second factor verifies it after typing it again in full (the existing retype pattern); a change returns it to `requested`.
  The page says in plain words that UnitMarket pays out to this account and never creates one. Copy rules D-051: no italics, no dashes.
- Seed and `PUBLISHER_PERSONAS` are not changed, and `seedAgreements` still takes only the three demo slugs.

Tests first (commit 1, run red): `packages/security/src/publisher-accounts.test.ts` and `.adversarial.test.ts` (invite code: wrong, expired,
reused, voided by reissue, brute force locks, timing shape; password policy; username clash), `packages/db/src/migration-NNNN.state.test.ts` (NNNN is the number you took),
`domain/catalogue/src/publisher-invites.state.test.ts`, `apps/web/src/publisher-accounts.state.test.ts` (approve shows code once and a second
read does not; claim then sign in; demo personas unchanged; terms accept; PayPal link request and verify; a buyer cannot use publisher routes),
`apps/web/src/publisher-accounts-copy.golden.test.ts`. The route list test (`maintenance.adversarial.test.ts` IMPORTERS) gains the new routes.

Acceptance (run, paste output):

- `corepack pnpm vitest run packages/security packages/db domain/catalogue apps/web/src/publisher-accounts` : all pass; red output shown for commit 1.
- `corepack pnpm check:routes check:isolation check:no-live-host check:secrets-names`, lint, typecheck, format check, six suites: pass.
  Do not: change the buyer account behaviour; touch payments, ledger, transport, paypal, safety; send email; log a code or password; add a dependency.
  Evidence for the PR: outputs, the red run, the invite once-only transcript from the state test.

## Review findings from the first build (binding, Opus review of 4 Nov; the first build was lost, rebuild with these)

- Migration numbers: 0020 to 0027 are taken on main by other lanes. Take the next free number on main when you start and again when you rebase (planned: P1 0028, M1 0029, I1 0030). Name the migration test after the number you use.
- Demo personas: the domain cannot import `PUBLISHER_PERSONAS`, so `InviteDeps` takes `demo_slugs` and the web composition injects the persona slugs.
  `issueInvite` and `resetPublisherSignIn` refuse a demo slug with `not_allowed` even if it has an account row; `listPublisherAccess` omits them.
- Sign in needs an active publisher: `verifyPublisherLogin` joins `publishers` and requires status `active`, after the single scrypt check, with the
  same generic failure, not counted as a failed attempt. `resetPublisherSignIn` works for any status; `issueInvite` needs an active publisher with no account.
- Migration: `CHECK ((state = 'verified') = (verified_by IS NOT NULL AND verified_at IS NOT NULL))` on `publisher_paypal_links`.
- `requestPaypalLink` returns `no_account` without a claimed account; the route answers 403 `no_account`. New copy string, pinned in the golden:
  "Only a publisher who claimed an account can link an address."
- Invite: 12 characters, 32 symbol alphabet, 7 days, stored as a SHA-256 hash.
- Also in this lane (was a gap): the old copy that says an approved applicant cannot sign in is pinned by the ops-applicants-copy and apply-copy goldens;
  change the copy and those goldens. Add the new access section to the publishers nav (`OPS_PUBLISHERS_SECTIONS`). Export `lockFor` from `packages/security/src/accounts.ts`
  (the only change there). Older tests that need edits for the new routes or agreement method (agreement state, migration-0017 state, scope-a and maintenance adversarial): edit and say so.
- Known gaps, not in this lane: no browser (e2e) test; Log in with PayPal replaces the operator check later (A3).
