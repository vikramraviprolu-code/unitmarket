# Spec: public "Apply to publish" screen (PUB-APPLY)

Task: a new publisher applies on a public screen; the operator sees and decides it on `/ops/publishers` (PUB-E2).
Package: `domain/catalogue`, `apps/web` Owner: builder (Sonnet) Reviewer: Opus (security review)
Branch: `feat/pubui-apply` Commit: `feat(web): <what> (PUB-UI-APPLY)` Decisions: D-041, D-051; PUB-E2.
Why: typing a new publisher name at sign in was rejected (name squatting, shared passcode, open write). This replaces it.

Goal: an anonymous visitor can leave one application. It creates an applicant record only: a `publishers` row with status
`applied`, no payee, no offers, no account, no sign in, no access. Nothing is paid or published until the operator approves,
and an approved applicant still has no sign in until the owners add a persona and passcode (a human decision).

Behaviour:

- `domain/catalogue/src/applicants.ts`: `submitApplication(deps, {display_name, country, note, ref_nonce})`, no actor.
  Name 2 to 80 chars, no control or bidi characters, no `<` or `>`; country `^[A-Z]{2}$`; note 3 to 200 chars, no control
  characters. The server derives the slug: ASCII lowercase of the name, `[a-z0-9]` runs joined by single hyphens (fallback
  `applicant`), cut to 27 chars, then `-` and the 12 hex chars of `ref_nonce` (40 chars at most, unique, reveals no slug).
  Same private INSERT as `addApplicant`. Refuses `busy` when 200 applicants are pending. A name equal (any case) to an
  existing publisher name is accepted and its stored note starts `DUPLICATE NAME: `. One `audit_log` row
  `publisher.application_submitted`, actor `system` (the audit CHECK has no `anonymous` kind and there is no new migration),
  detail `{actor: 'anonymous'}`; the note is the audit reason. `applicationStatus(db, ref)` answers `pending | approved |
rejected | unknown`; `unknown` for anything that was not made by `submitApplication`. `listApplicants` adds `note` and `source`.
- Engine `applyToPublish({display_name, country, note, website, ip_hash})` and `applicationStatus({ref})`: 5 submissions
  an hour per hashed address (token bucket `apply`), a filled `website` honeypot answers the normal success and stores nothing.
- Route `POST /api/applications`: public, CSRF origin check, `.strict()`, 2048 byte cap, 20 requests an hour per address,
  no cookie read by the handler, none set, generic errors, no internal id in any answer (the reference is the slug).
- Pages `/apply` (form, confirmation with the reference) and `/apply/status` (Chip: Waiting for review, Approved, Not
  approved, or a neutral not found), words in `lib/apply-copy.ts`; links from the publisher terms page and the sign in page.
- No migration, no new table, no new dependency. The note keeps no readable email address: the audit sink hashes them, so the
  copy asks for a website or public profile.

Acceptance tests (each prints green):

- `corepack pnpm test:state domain/catalogue apps/web` (validation, slug, no actor, no money rows, cap, honeypot, duplicate, audit)
- `corepack pnpm test:adversarial apps/web` (mass submission limit, oversize, unknown fields, inert script text, operator routes
  still refuse anonymous, route in the maintenance walk)
- `corepack pnpm test:golden apps/web` (apply-copy)
- `corepack pnpm check:routes`, lint, typecheck, format check, isolation, no-live-host, secrets-names

Do not: add a migration, table or dependency; create a persona, payee, offer, order or approval; read a cookie; log or store the
raw address; touch `globals.css`, `publisher.css`, money paths or PayPal code.
Evidence: red run, outputs, follow-ups (a readable contact field needs a migration: owner decision).
