# BU-7: leave our own payee out of create_order (D-028, option c)

Task: the PayPal adapter omits `purchase_units[].payee` from `create_order` only when the unit's payee equals our own sandbox merchant id; the read-back still compares the payee and expects our own id.
Package: `packages/paypal` (plus the small edits listed) Owner: Sonnet 5.5 builder, effort high (money path) Reviewer: Opus 5.5 high; Sakthi merges
Branch: `feat/paypal-own-payee` (from `feat/web-unseal-outbound`; merges together with BU-2) Commit: `type(paypal): <what> (BU-7)`

Goal: approval needs a publisher merchant id, so every create body carries a payee, and scope `mvp_b_polling` refuses any payee before the gate (`PAYEE_SCOPES` holds only `mvp_c_refunds`). So create never reaches the Wire. Fix: new optional, non-secret config value `UMS_OWN_MERCHANT_ID` (13 characters, `A-Z` and `0-9`; anything else refuses boot naming the variable, never the value). `buildCreateBody(req, own)` leaves `payee` out of a unit only when `unit.payee_merchant_id === own` (strict equality: no case folding, trimming, prefix or normalisation). Own unset or null: never omit. Any other payee stays in the body and stays blocked before the gate under `mvp_b_polling`. When the payee was left out, PayPal's own account answers as payee: the expected payee at read-back is the stored one (our own id), `match.ts` is unchanged, so an order read that echoes no payee or another one is a `payee` mismatch and the order freezes (never paid, no access, no second charge, no new create with another body; a create retry resends the same request id and the same body). Do not change `UMS_OWN_MERCHANT_ID` while a create is unresolved: the body would differ under the same request id.

Sandbox seed: `seed()` in composition, in `sandbox` mode only and only when `UMS_OWN_MERCHANT_ID` is set, sets `paypal_merchant_id` and `payee_verified_at` of the one MVP-B publisher (`harbour-ledger`) when its merchant id is still null. The value comes from the owner's environment; none is committed. Offline mode and an unset value leave publishers as they are.

Inputs: `packages/paypal/src/{build-create.ts, adapter.ts}`, `packages/config/src/{schema.ts, load.ts}`, `apps/web/composition.server.ts`, `apps/web/src/server/dryrun-model.ts`, `packages/testkit/src/stack.ts` (the order models echo the configured own id when a unit names no payee, as PayPal does for the app's account).

Outputs: those files; `.env.example` (name only); `docs/owner/MVPB-OWNER-STEPS.md` and `docs/specs/testkit-sandbox-subject.md` (the first-run check below); the tests listed; two BU-2 review nits (below).

Acceptance tests:

- `corepack pnpm vitest run packages/paypal/src/own-payee.test.ts`: omit on exact own id only; unset never; case, whitespace, prefix, suffix and look-alike variants keep the payee; other payee kept; mixed units omit per unit.
- `corepack pnpm vitest run packages/config/src/own-merchant-id.contract.test.ts`: optional; bad charset or length refused naming only the variable; the name is in `.env.example` with no value.
- `corepack pnpm vitest run packages/testkit/src/own-payee.state.test.ts tests/mvp-b/own-payee.state.test.ts`: create, approve, capture, read-back match with own id echoed (order model and fixtures); the seed sets the one publisher from the config value.
- `corepack pnpm vitest run tests/mvp-b/own-payee.adversarial.test.ts`: another payee under `mvp_b_polling` is blocked before the gate, 0 Wire calls, 0 reservations; echo missing or different freezes the order with one create, one capture and no entitlement; own id copied into another publisher's unit does not omit it.
- `corepack pnpm vitest run tests/mvp-b/unseal-journey.integration.test.ts`: under `mvp_b_polling` the create now reaches the Wire; the old "documented gap" test (a spec change: F1 is resolved) is replaced by a passing journey.
- `corepack pnpm vitest run tests/mvp-b/sealed-callers.test.ts scripts/lint-rules.test.ts scripts/route-inventory.failsafe.test.ts`: pins unchanged and green, plus the nits.
- `corepack pnpm lint && corepack pnpm typecheck && corepack pnpm format:check && corepack pnpm check:isolation && corepack pnpm check:no-live-host && corepack pnpm check:secrets-names && corepack pnpm check:routes && corepack pnpm check:fixtures && corepack pnpm check:provenance`: exit 0.

First owner run (BU-6 picks this up; also in `MVPB-OWNER-STEPS.md`): after the first create, GET that order and confirm PayPal echoes our own merchant id as payee. Anything else STOPS the lane and goes to the owner. No retry with a changed body.

BU-2 nits folded in: `sealed-callers` pins `buildOutbound` exactly twice in `composition.server.ts` (the import and one call) and never exported, one call argument, no top-level function declaration in `outbound.server.ts` beyond today's, and the factory argument is the object literal inside `ensureBuilt`; `check:routes` rejects computed keys and spreads inside `routeMeta`.

Do not: change `packages/transport`, the scopes, `PAYEE_SCOPES`, the seal, `eslint.config.mjs`, `packages/safety` or `domain/payments/src/match.ts`; add a dependency; put a merchant id or any secret anywhere; touch `docs/decision-log.md` or `docs/ASSUMPTIONS.md`; contact PayPal.

Evidence for the PR: red run summary; pass counts; mutation scores; the F1 test diff. Simulation tests prove the modelled cases only, not PayPal compatibility: whether PayPal's order read echoes the account's merchant id is checked in the first owner run.
