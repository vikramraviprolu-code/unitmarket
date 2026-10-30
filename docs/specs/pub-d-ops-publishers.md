# Spec: operator publishers page and suspend (PUB-D)

Task: `/ops/publishers` (S7) for the operator: per publisher status, payee last 4, verified, units captured, refunds open,
held units and exposure per currency; and a suspend action.
Package: `domain/publisher-console` (exposure read model), `domain/catalogue` (status filter), `apps/web` Owner: builder
(Sonnet) Reviewer: Opus, one round
Branch: `feat/web-pub-d-ops-publishers` Commit: `feat(<package>): <what> (PUB-D)` Decisions: D-041, D-051; proposal 3I.
Depends on: PUB-A2 (requests page to link), PUB-B (catalogue write module), PUB-C (package exists). Common rules: plan section 2.

Goal: the operator sees in one table what UnitMarket holds or owes per publisher and can stop one publisher's offers without
stopping anything else.

Behaviour:

- `domain/publisher-console/src/exposure.ts`: `publisherExposure(db)` (operator only; the caller checks the role) returns per
  publisher: slug, display name, status, payee last 4, `payee_verified_at`, `payee_shared`, offers live, and per currency:
  units captured (count, statuses `captured_verified`, `partially_refunded`), captured not refunded (sum of `amount_minor` minus `refunded_minor` over captured statuses), refunds open (count and sum of refund requests not in a final state), held (count
  of units `pending`, `reversal_suspected`, `mismatch`). Counts may be shown; no figure is projected.
- Suspend: `setPublisherStatus(deps, operator, { publisher_id, status: 'suspended' | 'active', reason })` in
  `domain/catalogue/src/status.ts`; one `audit_log` row. Route `POST /api/ops/publishers/status` (auth operator, MFA required,
  CSRF, rate 20 per hour per actor, `.strict()`). Effect: `listAuthorisedOffers` and `getOffer` callers treat a suspended
  publisher's offers as not available: add `AND p.status = 'active'` to `listAuthorisedOffers`, and have `startFromOffer`
  report `no_match` reason `not_authorised` for a suspended publisher (one condition in `domain/offer-entry/src/start.ts`).
  Existing entitlements, orders and refunds are untouched. If `domain/approval` re-reads the offer through these functions,
  new approvals stop too; if it does not, record "approval does not re-check suspension" as a follow-up and do not change
  `domain/approval` (money path).
- Page `apps/web/src/app/ops/publishers/page.tsx` (operator only), with a link to `/ops/payee-requests` and a suspend or
  reactivate form asking for a reason. Copy in `apps/web/src/lib/ops-publishers-copy.ts`. Nav: link from `/ops`.

Tests first: `domain/publisher-console/src/exposure.state.test.ts` (two publishers, two currencies, captured, partly
refunded, held, open refund); `domain/catalogue/src/status.state.test.ts` (suspend hides offers from the list and from a new
quote, reactivate restores, an existing entitlement still opens); `apps/web/src/ops-publishers.adversarial.test.ts`
(publisher and buyer sessions get 403 or 404 on the page data and the route; operator without MFA gets `mfa_required`;
CSRF); `apps/web/src/ops-publishers-copy.golden.test.ts`.

Acceptance: `corepack pnpm test:state domain/publisher-console domain/catalogue domain/offer-entry apps/web`,
`corepack pnpm test:adversarial apps/web domain/offer-entry`, `corepack pnpm test:golden apps/web`, `corepack pnpm
check:routes`, plan section 3. All pass, including every existing offer-entry test unchanged.
Do not: change `domain/approval`, `domain/payments`, migrations or the ledger; add approve-applicant (SHOULD, later); edit
`globals.css`; show full merchant ids.
Evidence: outputs, red run, screenshot of S7 in dry run if a browser runs, follow-up list, cost line.
