# Spec: publisher personas, migration 0012 and the publisher shell (PUB-A1)

Task: one sign-in persona per publisher behind a separate publisher passcode, the publisher-side schema (migration 0012),
and a read-only `/publisher` home page (S1, minimal).
Package: `packages/db` (migration), `apps/web` (personas, shell) Owner: builder (Sonnet) Reviewer: Opus, one round
Branch: `feat/web-pub-a1-personas-shell` Commit: `feat(<package>): <what> (PUB-A1)` Decisions: D-065 items 27, 34;
D-040 (shared passcode risk); proposal `docs/proposals/publisher-side-proposal-2026-10-30.md` sections 3A, 5, 6.
Depends on: CFG-0 merged (`publisher_passcode_hash`). Common rules: `docs/specs/overnight-plan.md` section 2.

Goal: a tester picks "Harbour Ledger (publisher)", "Quayside Gazette (publisher)" or "Northfield Quarterly (publisher)" on
`/signin`, types the publisher passcode and lands on `/publisher`, which shows only that publisher's name, status, number
of offers live and payee state (verified or not, last 4 only). The schema for the later publisher lanes exists.

Migration `packages/db/migrations/common/0012_publisher_side.sql` (forward-only, header comment like 0010):

1. `publishers.status text NOT NULL DEFAULT 'active' CHECK (status IN ('applied','active','suspended'))`.
2. `payee_change_requests` (id, publisher_id FK, requested_merchant_id ums_id, note text, created_by text, created_at,
   updated_at). Append-only: `ums_deny_mutation` and `ums_deny_truncate` triggers as in 0001.
3. `payee_decisions` (id, request_id FK UNIQUE, decision CHECK in ('verified','rejected'), operator_id text NOT NULL,
   reason text NOT NULL, created_at, updated_at). Append-only, same triggers. A request is open while it has no decision.
4. `publisher_authorisations.attestation_version text` (NULL for existing rows).
5. `articles.created_by text` (NULL for existing rows) and a trigger refusing an UPDATE of `sha256` or `content_key` when
   any offer with status `authorised` references the article (errcode `check_violation`).
   No change to ledger, orders, units, operations, 0010 or the Supabase set (Supabase is unused, D-049; follow-up listed in
   the plan).

Personas (`apps/web/composition.server.ts`, `apps/web/src/app/signin/SignInForm.tsx`, new
`apps/web/src/lib/publisher-copy.ts`): replace the single `publisher` persona with `publisher-harbour-ledger`,
`publisher-quayside-gazette`, `publisher-northfield-quarterly`, each mapped to the publisher row by slug. They verify
against `config.publisher_passcode_hash` only; the demo hash never signs a publisher in, and with the publisher hash unset
publisher personas are refused with the same cost as an unknown persona. Buyer and operator sign-in are unchanged.

Shell: `apps/web/src/app/publisher/page.tsx` (rule: publisher actor, else redirect to `/signin?next=/publisher`), an engine
method `publisherHome(actor)` returning `{ display_name, status, offers_live, payee: { last4 | null, verified_at | null } }`
or null for a non-publisher actor; a "Publisher" nav link in `layout.tsx` for a publisher session. Every query filters by
`actor.publisher_id`. Copy in `publisher-copy.ts` (D-051, no italics, no dashes). Empty and suspended states.

Tests first: `packages/db/src/migration-0012.state.test.ts` (columns, defaults, both append-only tables refuse UPDATE,
DELETE, TRUNCATE; immutability trigger; existing rows keep values); update the pinned migration list in
`schema.state.test.ts` line ~1516 (it lists 0010 and 0011; it now gains 0012: say so); `apps/web/src/publisher-shell.state.test.ts`
(each persona lands on its own publisher; demo passcode refused for a publisher persona; unset hash refuses; buyer and
anonymous get no `publisherHome`); `apps/web/src/publisher-shell.adversarial.test.ts` (publisher A's session never reads
B's row, also with B's id in a query string); a golden of `publisher-copy.ts`. Tests that pin the old `publisher`
persona contradict this spec: update them and name each.

Acceptance: `corepack pnpm test:state packages/db apps/web`, `corepack pnpm test:adversarial apps/web`,
`corepack pnpm test:golden apps/web` all pass; `corepack pnpm check:routes` passes; the plan's common list (section 3).
Do not: add API routes (PUB-A2 onwards); edit `globals.css` (use existing classes); show a full merchant id anywhere; touch
domain packages, `infra/`, or the payee guard of 0010.
Evidence: outputs (counts), red run, tests changed and why, screenshot of `/publisher` if a browser runs, cost line.
