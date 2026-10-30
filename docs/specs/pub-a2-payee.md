# Spec: "Where you get paid" and operator payee verification (PUB-A2)

Task: page S6 for a publisher (current payee, last 4 only, request a change, request history) and an operator page that
verifies or rejects a request with MFA and an audit row.
Package: `apps/web` (pages, routes, engine), `domain/catalogue` (payee module) Owner: builder (Sonnet) Reviewer: Opus,
money-path review (who gets paid)
Branch: `feat/web-pub-a2-payee` Commit: `feat(<package>): <what> (PUB-A2)` Decisions: D-041, D-028, D-062, D-065 items
28 to 31; proposal sections 3B, 3I, 5. Depends on: PUB-A1 merged (migration 0012, personas).
Must merge before Mon 2 Nov (item 31: payee changes only before the freeze). Common rules: plan section 2.

Goal: a publisher sees where its money goes and can ask for a change, which does nothing until an operator with a second
factor verifies it by typing the requested merchant id again. A publisher session can never change a payee.

Behaviour:

- `domain/catalogue/src/payee.ts` (exported from the package root): `payeeView(db, actor)`, `requestPayeeChange(deps,
actor, { merchant_id, note })`, `listOpenRequests(db)`, `decidePayeeRequest(deps, operator, { request_id, merchant_id_retyped,
decision, reason })`. Injected clock, ids and audit sink. Merchant id must match `^[A-Z0-9]{13}$`.
- Verify: refuses unless the retyped id equals the stored request id exactly; writes one `payee_decisions` row; sets
  `publishers.paypal_merchant_id`, `payee_verified_at`, `payee_shared = false` in the same transaction; one `audit_log` row
  with last 4 of old and new ids only. The 0010 trigger refusal (id held by another unflagged publisher) surfaces as
  `merchant_in_use`. Reject writes the decision row and changes nothing else.
- Mode guard (conflict with D-062, see plan section 5): in `sandbox` mode `decidePayeeRequest` with `verified` refuses with
  `owner_command_required` and changes nothing; the page says "Payee changes on the hosted app are made by the owner." Only
  dry-run (offline) verifies through the route. An owner TTY command is a separate, later lane.
- Routes (all `withRoute`, CSRF): `POST /api/publisher/payee-requests` (auth publisher, rate 3 per day per actor, body cap
  1 KB); `POST /api/ops/payee-decisions` (auth operator, MFA required: no `fail_safe_without_mfa`, rate 20 per hour per actor).
- Pages: `apps/web/src/app/publisher/payout-account/page.tsx` (S6: last 4, verified when and by "operator check, not PayPal
  onboarding", settlement sentence from stored data, request form, history newest first with state open, verified or
  rejected); `apps/web/src/app/ops/payee-requests/page.tsx` (open requests: publisher, requested last 4, age; verify or
  reject form that asks to type the full id again). Copy in `apps/web/src/lib/payee-copy.ts`.

Tests first: `domain/catalogue/src/payee.state.test.ts` (request stored; verify sets payee and decision; reject changes
nothing; retyped mismatch refused; second decision on one request refused by the unique key; sandbox mode refuses verify);
`domain/catalogue/src/payee.adversarial.test.ts` (publisher cannot verify, even its own; buyer and anonymous refused; a
publisher cannot see another publisher's requests; duplicate merchant id refused; audit and logs hold last 4 only, checked
with a canary id); `apps/web/src/payee.adversarial.test.ts` (operator without MFA gets 403 `mfa_required`; CSRF missing 403;
mass assignment with `publisher_id` in the body refused by `.strict()`); `apps/web/src/payee.state.test.ts` (through a
booted test app: a payee verified while an approval is open makes placing that order answer `payee_unavailable`; no
payments code change, and if it does not, stop and report: that is a money-path finding);
`apps/web/src/payee-copy.golden.test.ts`.

Acceptance: `corepack pnpm test:state domain/catalogue apps/web`, `corepack pnpm test:adversarial domain/catalogue apps/web`,
`corepack pnpm test:golden apps/web`, `corepack pnpm check:routes`, plan section 3 list. All pass.
Do not: change `domain/payments`, `domain/approval`, `packages/paypal`, `packages/transport` or migration 0010; set
`payee_shared` anywhere; print or store a full merchant id outside `payee_change_requests` and `publishers`; edit `globals.css`.
Evidence: outputs, red run, route inventory lines for the two routes, cost line.
