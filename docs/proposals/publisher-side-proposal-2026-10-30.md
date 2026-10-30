# Publisher side for UnitMarket SBX: proposal (30 Oct 2026)

Status: PROPOSAL ONLY. Nothing is built. The owners decide the scope first (D-064). Written by an Opus research worker
from the repositories and PayPal's public documentation; saved here by the coordinator. "Verified" means the page or
file was read; "unverified" means it was not, or it could not be run. Simulation results prove modelled cases only, not
PayPal compatibility.

## 1. What the original requirements said, and how SBX ended up without a publisher side

Original plan (simulation repository, Build Bible Rev 11 as transcribed in `docs/dev/01-mvp-requirements.md`):

- PAY-01 Supply: in = two labelled sample publishers as separate sandbox merchants, 8 to 10 articles, an approved price
  range, a terms version, a rights log. Out = real publisher integration, publisher onboarding UI, scraping.
- PAY-07 PayPal: one purchase unit per publisher with payee and platform fee; acceptance: a two-publisher sandbox order
  captures with two capture ids. Out: Payouts, Vault, Disputes API.
- PAY-11 Screens: buyer screens, developer panel, evals. Out = seller dashboard, admin.
- Money rules: a publisher approves a range and terms; UnitMarket's rule sets the exact line price; platform share 20 percent
  (proposal); line floor USD 1.
- "What the demo cannot prove": that publishers authorise unit sales, and that platform-fee consent works outside the sandbox.

So the Bible put a publisher onboarding UI and a seller dashboard explicitly OUT of the MVP, but required two separate
sandbox merchants. The simulation nevertheless built a seller side (screens S1 to S7 in `docs/specs/sim/sim-app-ui.md`
section 6: dashboard with payout panel, catalogue, offer editor with version history, publish, sales, ledger, refunds;
`packages/core/app/seller.ts`: a publisher sees and changes only its own resources; its payout panel said "Simulated
payouts. Nothing is paid out in this environment").

How SBX lost it, from the record (no blame):

- `docs/design/architecture.md` section 2 lists pages `/publisher/*` and `/ops/*` and a route auth rule `publisher` (9.8);
  section 8 has publisher-scoped row security. So the design intended a publisher area.
- Section 10 (apps/web row) says "screen ideas only"; no MVP lane A to F in `docs/design/mvp-plan.md` builds publisher
  screens (A-L14 is "Design system, buyer and ops screens"; A-L11 seeds 2 publishers and 8 articles). nfr.md SOP 16: MVP-A to
  MVP-C have no upload endpoint; content is seeded by the operator.
- MVP-D needed two sandbox Business accounts as publishers (the owner decides whether to create them; the plan assumed
  none). D-023: no new accounts unless the spike shows USD cannot complete. D-041 (OQ-1 option B, recommended by the Opus
  review of the MVP-D specs): both fictional publishers paid into the owner's own sandbox Business account; multi-merchant
  payout not demonstrated; a second merchant is a stretch item after the deadline needing spike step 16 and a new owner
  permission. OQ-18: the second publisher's verification "is a fiction".
- D-004 "No Payouts API" (reasons in ASM-06: the hackathon needs buy and refund, not seller settlement; nfr 2.6: payouts and
  money transmission out of scope; architecture 9.5: never collect then pay out). No commission until a model is chosen (D-3).
- D-047 (one MVP at a time) and D-048 (cost limits) kept work on the money path.
- D-064 (30 Oct) adds the publisher side to scope: proposal first, owner approval before any build.

Net: the original requirement dropped the publisher UI on purpose, and SBX also dropped the two-merchant part of PAY-01 and
PAY-07 through D-041. The deviation from the original plan is the single merchant, not only the missing dashboard.

What already exists in SBX code (the base to build on):

- Schema: `publishers` (slug, display name, country, paypal merchant id, payee verified at, payee shared) in
  `packages/db/migrations/common/0001_core.sql` and `0010_publisher_payee_shared.sql`; offers versioned by (id, version) with
  status draft, authorised or withdrawn, options (keep_retrieve, online_read with price in minor units), affordability floor,
  terms version, rights, validity, `superseded_by`; append-only `publisher_authorisations`; articles with sha256;
  `content_blobs`; `order_units.publisher_id`; `provider_orders.publisher_id` (0011); ledger kinds sale, paypal_fee,
  platform_fee, refund, reversal; `audit_log`; sessions with actor kind publisher.
- Supabase row security already has publisher policies (`packages/db/migrations/supabase/0001_roles_rls.sql`).
- Contracts and security: actor kind publisher, route rule `publisher`, session support.
- A `publisher` persona on the sign-in page that always signs in as the first publisher by slug
  (`apps/web/composition.server.ts`), but no page or API route accepts it.
- `domain/ledger` `publisherBalances` exists and is tested, but nothing in apps calls it.
- Guards: approval refuses a publisher without a merchant id or a verified payee (`domain/approval`); `placeOrder` re-checks
  the payee against the snapshot (`domain/payments/src/place.ts`); `startFromOffer` reports withdrawn and below-floor;
  the snapshot freezes offer version and price (A-08).
- Payee path: `packages/paypal/src/build-create.ts` leaves the payee out only when it equals the owner's own merchant id
  (D-028) and otherwise sends the payee; `packages/transport/src/sandbox.ts` allows a named payee only under scope
  `mvp_c_refunds`. So paying a second, separate merchant needs no money-path code change: only data, an approval row and a
  sandbox check.
- Ops: `/ops` shows the shared-payee line (last 4); `seedSandboxPayees` writes audit rows.
- Missing entirely: catalogue writes (domain/catalogue exports reads and seed only), any `/publisher` page or
  `/api/publisher` route, content upload, payee linking, operator publisher tools, statements.

## 2. Personas and jobs to be done

- P1 Small publisher (newsletter writer, local paper; demo: Quayside Gazette): sell one article to a reader who will never
  subscribe; set a price and what the buyer may do with it; see that it sold and that the money reached my PayPal; take a piece
  down when my rights end.
- P2 Publisher finance or admin: a statement I can match line by line to my PayPal activity; refunds and anything held or
  reversed; which PayPal account gets paid.
- P3 Rights or editorial manager: state the licence (personal use, redistribution, AI use); prove what the buyer agreed to
  (terms version); never let an old price or old terms apply to a new sale.
- P4 UnitMarket operator: approve a publisher before its offers go live; check the payee account is really theirs; see what we
  owe or hold per publisher and what is stuck; stop one publisher without stopping everything.
- P5 Judge (PayPal): see in two minutes who gets paid, by which PayPal mechanism, and what is real versus simulated.

## 3. Feature set (MUST = hackathon demo, SHOULD, LATER)

A. Sign-in and identity

- MUST: one persona per publisher on the existing passcode sign-in; session actor {publisher, publisher_id}; every publisher
  page and route uses rule `publisher`.
- SHOULD: publisher status (applied, active, suspended); suspended hides offers and refuses approvals.
- LATER: self-service sign-up, real accounts, team roles, MFA for publishers.

B. Linking a PayPal receiving account

- MUST: page "Where you get paid": stored payee (last 4 only), verified or not, when and by whom, and the honest settlement
  mode. A publisher may submit a payee change request; it does nothing until an operator verifies it with MFA.
- SHOULD: request history (append-only) visible to the publisher.
- LATER: PayPal Partner Referrals onboarding (needs approved partner status and a new allow-listed path; not before the deadline).

C. Offer management

- MUST (cut to this if short of time): list own offers with status and price; edit price per access option; withdraw. Every
  change writes a new offer version plus an authorisation row and sets `superseded_by` on the old one (no in-place price
  update). Price rules: integer minor units above 0, currency fixed by the corridor, at most the per-order cap of the active
  approval (2000 minor units under D-062). No universal floor (architecture 9.12).
- MUST: choose keep_retrieve and/or online_read (window fixed at 5 days by access policy).
- MUST: terms and rights shown read-only per offer.
- SHOULD: create a new offer for an existing own article; edit rights with an attestation checkbox stored with the
  authorisation; renegotiation floor.
- LATER: price ranges, scheduled validity, bulk import (WordPress feed, MVP-E), drafts with preview.

D. Content reference and delivery

- MUST: article facts read-only (title, abstract, short sha256, size, language); delivery stays the existing content route;
  content stays seeded.
- SHOULD: add a new article (plain text or Markdown, server-side sniff, cap 200 KB, stored with sha256, rendered inert, AI-1
  injection set re-run). Content is immutable once any offer for it is authorised; a correction is a new article.
- LATER: PDF or HTML upload, WordPress pull.

E. Sales and orders per publisher

- MUST: sales table from `order_units` for the actor: date, order ref (last 6), article, access option, amount, unit status in
  plain words, PayPal fee if observed. No buyer identity (PRIV-1).
- SHOULD: filters by status and date; totals row.

F. Earnings and settlement statement

- MUST: statement per currency from ledger rows via `publisherBalances`: sales, refunds, reversals, PayPal fee (observed), net;
  each line links to its order; settlement wording driven by stored data (section 4).
- SHOULD: CSV download.
- LATER: commission line (needs platform fees), multi-currency balances.

G. Refunds and disputes visibility

- MUST: refunded, partly refunded, held, reversal-suspected and reversed states per unit on the sales page.
- SHOULD: separate refunds list with reason and operator.
- No Disputes API (PAY-07 out): show only verified reversal states.

H. Notifications

- SHOULD: in-app "since your last visit" list from stored events. No email.
- LATER: email or webhook.

I. Operator tools

- MUST: `/ops/publishers` list: status, payee last 4, verified at, shared flag, offers live, units captured, refunds pending,
  open problems. Verify payee: the operator types the requested merchant id again, MFA required, audit row; a duplicate id is
  refused unless both rows are payee_shared (trigger already does this).
- MUST: exposure per publisher and currency: captured not refunded, refunds in progress, held or frozen units.
- SHOULD: approve an applied publisher; suspend a publisher (offers hidden, new approvals refused, existing entitlements kept).
- LATER: publisher-level kill switch.

## 4. PayPal sandbox options for paying publishers

(a) Today: all money to the owner's account, with a publisher ledger and a statement.

- Unchanged D-041. The statement says money was collected for the publisher and not paid out. Verified: this is what ran for
  real on 29 Oct (`docs/evidence/mvp-d-real-sitting-2026-10-29.md`: two separate Completed payments into one Business account).
- Trade-offs: zero new PayPal risk and no new approval scope, but it is the "platform collects then owes" model the design
  rejects (architecture 9.5), it shows no multi-merchant settlement, and a judge sees one merchant. A statement "owed" figure is a
  fiction unless a payout exists: label it "Not paid out: sandbox demo; UnitMarket has no payout mechanism".

(b) Per-publisher sandbox Business accounts as payees.

- b1, plain "pay another account" (Orders v2 `payee.merchant_id`, no platform fee, no auth assertion). Verified in PayPal's
  public docs (Checkout, standard, customize, "pay another account"): by default money is paid to the application owner's own
  account; include the email or merchant id of the account to receive the payment. Verified in the repo: the Orders OpenAPI
  lists 403 PAYEE_NOT_CONSENTED (architecture line 45). From a search summary only (page not opened): that error describes the
  caller lacking permission from the payee. UNVERIFIED: whether this sandbox app may create and capture an order for a
  third-party payee without consent. That is exactly spike step 16 (mvp-plan). UNVERIFIED and risky: whether refund and read
  calls on that third party's capture are allowed to our credentials; plan refunds of the second publisher as fixture-only or
  done in that publisher's own sandbox dashboard. Code: no money-path change. Data: set Quayside's merchant id to the new
  account, payee_shared false, verified by an operator; Harbour keeps the owner's id. The receiving preference of the new
  account must accept USD without manual approval, otherwise captures sit PENDING (architecture 14.1); a US Business account
  avoids that.
- b2, PayPal Complete Payments (platform). Verified in PayPal's multiparty docs: live use needs an approved platform; sandbox
  test with a standard developer account; platform fees are not supported for first-party integrations; checkout needs a
  PayPal-Auth-Assertion header and a partner attribution id; sellers must be onboarded first through Partner Referrals; the
  docs contradict themselves on whether partner APIs can be tested in sandbox before approval (one page says yes, and also says
  calls without approval return 401). Delayed disbursement releases funds after 28 days. Whether our default application can use
  partner APIs in sandbox is UNVERIFIED. Trade-offs: the real marketplace answer, but new endpoints, new headers, a seal change
  after the 2 Nov freeze, and a partner approval we do not have. Not achievable honestly by 9 Nov.

(c) Payouts API. D-004 excludes it. Verified (Payouts docs): a Business account with balance; live access must be requested;
sandbox testing is possible. Recommendation: do not revisit. It needs a new allow-list path and approval scope after the freeze,
makes UnitMarket the holder of publisher money (the compliance question nfr 2.6 puts out of scope; not legal advice), and shows
the weaker model to PayPal judges. Keep D-004.

(d) Collect, then pay out later: (a) plus (c) or a manual transfer. Same objections. A manual transfer from the owner's
dashboard is a fiction and must not be presented as product behaviour.

RECOMMENDATION: "(b1) for one publisher, (a) for the other, everything labelled".

- Quayside Gazette gets its own new sandbox Business account (US, USD) and is paid by PayPal directly through
  `payee.merchant_id`. Harbour Ledger stays on the owner's account and is presented as operated by the UnitMarket team.
- A pack of both then shows two PayPal orders landing in two different merchant accounts: real sandbox evidence of
  direct-to-publisher settlement. It restores the PAY-01 and PAY-07 intent, keeps UnitMarket out of holding publisher money, and
  needs no money-path code.
- Gate: spike step 16 plus one real single order to Quayside in an owner sitting before Mon 2 Nov. If it fails (PAYEE_NOT_CONSENTED
  or PENDING), fall back to (a) with no code to undo, and record the result as evidence.
- Must be labelled simulated or not demonstrated: (1) payee verification is by hand by an operator, not by PayPal onboarding;
  (2) UnitMarket takes no commission (platform fees need partner approval); (3) Harbour's money goes to the owner's test account
  and is not paid out there; (4) refunds of a Quayside sale through the API are untested and may be fixture-only; (5) publishers
  are fictional and authorisation is by a demo persona with a shared passcode; (6) simulation results prove modelled cases only.
- Proposed judge line: "Each publisher is a separate PayPal payee. Quayside Gazette is paid by PayPal directly into its own
  sandbox account. Harbour Ledger is our own test imprint. UnitMarket never holds a publisher's money and charges no commission in
  this demo; payee checks are done by an operator, not by PayPal onboarding."

## 5. Data model, code, tests, security

Migration `0012_publisher_side.sql` (common, forward-only):

- `publishers.status` (applied, active, suspended; existing rows active).
- `payee_change_requests` and a separate append-only `payee_decisions` table (deny update, delete, truncate like 0001).
- `publisher_authorisations.attestation_version`.
- `articles.created_by`; a trigger refusing a change of sha256 or content key once an authorised offer references the article.
- No change to ledger, orders, units, operations or 0010. Supabase: revoke update on `payee_shared` from the app role (the recorded
  gap, READINESS); publisher policies on the new tables.

Domain: `domain/catalogue` writes module (createOffer, reviseOffer, withdrawOffer, listOwnOffers, addArticle for SHOULD), every
function takes the publisher actor and filters by it, strict input schemas, a price rule function, injected clock and ids. A new
`domain/publisher-console` of pure reads (sales, statement, settlement mode derived from stored data). `domain/payments`: no change.

Packages: `packages/config` gets `UMS_OFFER_MAX_MINOR` (default 2000); `packages/security` route inventory and rate rules;
`packages/db` migration and tests; `packages/paypal` and `transport`: no change (the point of the recommendation).

apps/web: per-publisher personas; engine methods for dashboard, offers, revise, withdraw, sales, statement, payee view, payee
change request, operator publishers list, verify payee (operator, MFA, fail-safe without MFA), suspend. Routes under
`/api/publisher/*` and `/api/ops/publishers/*`, all through `withRoute`. An owner command `publisher:set-payee` (TTY only, same
pattern as `safety:approve`) for the one-off Quayside payee switch if b1 passes.

Tests (tests first): state (revise writes a new version and authorisation; withdraw gives no-match; price above cap, zero or wrong
currency refused; an approval made before a price change still charges the frozen price; content immutable after authorisation);
adversarial (publisher A cannot read or edit publisher B's offers, sales, statement or payee request, also with a guessed id;
buyer and anonymous refused; mass assignment refused; CSRF; a publisher cannot verify its own payee; an operator without MFA
cannot verify; a merchant id held by another unflagged publisher is refused; a payee change while an approval is open makes
`placeOrder` answer payee_unavailable; injection text in a new article changes neither price nor payee); golden (statement
copy per settlement mode; D-051 number agreement; "not charged" never on a held unit; labels from stored environment; empty
states); integration (full offline journey from a lowered price to the publisher's sales page, statement and operator exposure).

Security points: per-slug persona behind the shared demo passcode (D-040 risk accepted for the hackathon), so the money
destination is never changeable by a publisher session; payee changes need operator MFA or the owner's TTY command; data access
filters by publisher, with row security repeating it on Postgres; rights attestation recorded; the payee guard of migration 0010
kept; audit rows for every change with last 4 of merchant ids only; rate limits (offer writes 20 per minute per publisher, payee
requests 3 per day, article add 5 per hour; body caps); a publisher never sees buyer identity; no inline styles.

## 6. Publisher screens (text wireframes, summary)

Copy rules for all: labels Sandbox or Dry run from stored environment only; money figures only from stored rows, never projected;
empty states ("No sales yet."); D-051 verb follows the count; "not charged" only for declined, failed or abandoned PayPal orders;
never "paid out" unless PayPal paid the publisher directly; ids as last 4 (merchant) or last 6 (orders); every money line has a
source note.

- S1 `/publisher` dashboard: where your money goes, this period (sales, gross, refunded, PayPal fee from stored rows), since your
  last visit, offers live. States: loading, empty, payee not set (warning), suspended (read only), error with support code.
- S2 `/publisher/offers`: article, options, price, status, edit. States: empty, withdrawn, draft.
- S3 `/publisher/offers/[id]`: price per option, which options are offered, access window (set by UnitMarket), licence summary,
  terms version, rights attestation checkbox, save as new version, withdraw, note "buyers who already approved keep the price they
  saw", history. States: validation errors, saved, conflict.
- S4 `/publisher/sales`: date, order, article, option, amount, PayPal fee, status; filters; states: empty, held, refunded,
  reversal suspected.
- S5 `/publisher/statement`: per currency sales, refunds, reversals, PayPal fee, net; settlement sentence by mode; lines link to
  orders; no commission line, with a note.
- S6 `/publisher/payout-account`: current payee (last 4), verified by whom and when, how (operator check, not PayPal onboarding),
  request a change, request history.
- S7 `/ops/publishers` (operator): status, payee, verified, mode, captured, refunds open, held; actions verify (MFA), reject, suspend.

Style: in Bright Market (D) the settlement panel is a cobalt card with a route line from buyer to the publisher's account (two
routes for two payees); in Deep Harbour (E) the statement is a ledger shelf with the net figure in amber and held states in the warn
token. Both: system fonts, no inline styles, measured contrast tokens from the UX review, motion only on load and on save, off for
reduced motion. Build after the owners pick D or E; the function does not wait for it.

## 7. Phased plan (lanes of at most 90 minutes; three agents at once, D-064)

- Phase 0, Fri 30 Oct (owners): decide section 8 items 1 to 4 and record rows; if b1 is chosen, a human creates the second sandbox
  Business account.
- Phase 1, Sat 31 Oct to Sun 1 Nov (before the freeze; everything that touches who gets paid): PUB-0 specs; PUB-1 personas and
  publisher shell with S1 read-only and isolation tests; PUB-2 payee requests and operator verify (migration 0012, MFA, audit, owner
  TTY command, tests against trigger 0010; Opus money review); OWN-1 owner sitting of about 60 minutes under a new written approval
  row: spike step 16 with the new account, then one real single order for a Quayside offer; if it fails, fall back to (a).
- Phase 2, Mon 2 to Wed 4 Nov: PUB-3 sales and statement read models and pages S4, S5 (Opus review of sums against the ledger
  invariant); PUB-4 offer revise and withdraw in `domain/catalogue` (Opus review: snapshot freeze, versioning); PUB-5 offer pages
  S2, S3; PUB-6 ops publishers page S7 with exposure and suspend.
- Phase 3, Thu 5 to Fri 6 Nov: PUB-7 style pass in the chosen direction; PUB-8 offline gate and honesty pass (README and demo
  script wording, label and D-051 goldens); SHOULD lanes only if green: add article with upload limits and AI-1 re-run, "since
  your last visit", CSV.
- Sat 7 to Sun 8 Nov: rehearsal and recording under its own approval row. Mon 9 Nov: team target. Tue 10 to Thu 12: buffer, fixes only.

Cut first, in order: notifications; CSV; add-article upload (keep seeded content); suspend and approve-applicant (seed publishers
active); offer create (keep revise price and withdraw); a separate refunds view; style motion. Never cut: per-publisher isolation
tests, operator-only payee change, labels from data, the honest settlement wording.

Cost estimate: 9 builder lanes of 60 to 90 minutes, 7 Opus review rounds, one owner sitting.

## 8. Decisions, risks, human-only tasks

Decisions for the owners:

1. Publisher scope for the demo: the MUST list, or smaller (read-only console plus price edit and withdraw).
2. Settlement option: recommended (b1) for Quayside plus (a) for Harbour, gated by OWN-1 before Mon 2 Nov; or stay on (a) only.
3. A new decision row amending D-041 and D-023 (permission to create one new sandbox Business account) and a new written approval for
   OWN-1 that names the Quayside payee (last 4) and lifts the "any create body naming a payee is a stop" clause for that one id
   only. D-062 (hosted, valid to 3 Nov) does not cover it.
4. Whether the freeze on Mon 2 Nov also covers payee data changes and catalogue writes; whether publisher work overrides D-047.
5. Keep D-004 (recommended); whether to untick Payouts on the app (D-033, owner's choice).
6. A shared passcode for publisher personas (extends the D-040 risk) or a separate publisher passcode hash.
7. Price cap: tie the offer maximum to 2000 minor units (current approval cap) or raise the cap in a future approval row.
8. Style direction D or E (blocks the style pass, not the function).
9. Commission: confirm "no commission in this demo" wording.

Risks: PAYEE_NOT_CONSENTED or a permission error on create, capture or read for a third-party payee (unverified; OWN-1 decides;
fallback (a) needs no code change); a new account whose receiving preference leaves captures PENDING (use a US Business account);
refunds of Quayside sales through the API may be refused (label them dashboard-only or fixture); a hosted redeploy switches the
PayPal connection off (schedule deploys outside sittings); the wrong-database class of error (D-059) during the owner command (use
the same environment guard); a shared passcode lets any holder edit offer prices, though prices are capped and frozen per approval
and the money destination is unaffected; three agents shared with the screens and gap streams; judges reading "two publishers"
while one account is the owner's (mitigated by the judge line); the contradictory PayPal docs on sandbox partner APIs (do not
plan on b2).

Only a human can: create the second sandbox Business account (US, Business), set its receiving preference and note the merchant id
(last 4 only in documents); write and confirm the decision rows and the approval basis, insert the approval row with
`pnpm safety:approve` at their own terminal, then `safety:resume` and `safety:stop`; run OWN-1 on the owner's laptop as the sandbox
Personal buyer and confirm the payment in the new Business account; run the owner command that switches Quayside's payee if b1
passes; choose D or E, approve the publisher scope, decide on the Payouts tick and the passcode; record the demo video; sign in as
operator with the authenticator for payee verification on the hosted app; deploy to Cloud Run and set any new configuration.

Could not verify: whether b1 works in this sandbox app (spike step 16 never ran); refund and read permissions for a third-party
capture; the meaning of the "401" sentence in the partner docs for sandbox; the "20 agreed requirements" list cited in
`docs/briefing/mvp-status-2026-10-23.md` section 8 (no source file found in either repository); the Build Bible itself (private)
beyond the repository transcriptions.
