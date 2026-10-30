# Spec: flow fixes from the end to end gate (FIX-FLOW)

Task: fix the flow defects found by the gate 12 browser run: no sign out (D1), an unpaid order shown as "Confirming payment" and a false "No match" (D4, D5), lost focus and silent status (D8, D10), and wrong nav items for a publisher or operator (D11).
Package: `apps/web` (one small addition in `packages/security`) Owner: builder Reviewer: Opus
Branch: `fix/gate12-flow` Commit: `fix(web): <what> (FIX-FLOW)`

Goal: every signed in actor can sign out from the header; an order that is not paid says so in plain words in the library and on the order page; a search blocked by an open unpaid order says so and links to the library; keyboard use of the skin control and of Find articles keeps focus and announces the result; each role sees only its own nav items. Nothing in `domain/payments`, approval, paypal or transport changes.

Causes found. D1: no revoke path in the app. D4: the library read model words every `unknown` money state as "Confirming payment", and an `awaiting_buyer` order has a pending entitlement. D5: `startFromOffer` answers `already_owned` for a pending entitlement, discovery folds it into `no_match` with `reasons: ['already_owned']`, and the form ignores `reasons`. A buyer cancel needs a per order abandon in `domain/payments`; only the 24 hour sweep exists (`sweepAbandoned`, not exported). That is a domain change, so it is out of scope: see "Needs an owner".

Inputs: `packages/security/src/session.ts`, `apps/web` pages and `lib` copy. Outputs:
- `POST /api/session/signout` (auth public, CSRF Origin check, ip rate 30 per minute): revokes the one session of the cookie (never the actor's other sessions: personas are shared) and clears the cookie. `revokeSession` in `@umsbx/security`; `RouteContext.session_id`; `engine.signOut`.
- `SignOutButton` in the header for a signed in actor; `lib/nav.ts` decides the items: signed out: Find articles, Help, Sign in; buyer: Find articles, My library, Help, Sign out; publisher: Publisher, Help, Sign out; operator: Operations, Help, Sign out.
- Library and order page: an `awaiting_buyer` (or `created`) order with no approved PayPal order reads "Not paid yet. We have not received a payment for this order." Never "Confirming payment" for it.
- `/discover`: a `no_match` whose reasons include `already_owned` shows "Already in your library or on an open order" with a link to My library.
- `AppearanceControl`: radios stay enabled, the skin is applied by setting `data-skin` on `<html>` (no reload), status text announces the result in a `role="status"` region.
- `DiscoverForm`: after a search, focus moves to the results heading (`tabIndex={-1}`).

Acceptance tests (each run with `corepack pnpm test:unit -- <file>` style targeted runs, red first):
- `packages/security/src/session.state.test.ts`: `revokeSession` ends one session, leaves the actor's other one, audits it.
- `apps/web/src/signout.state.test.ts`: signout route clears the cookie and the session no longer resolves; a second session of the same persona stays live; `lib/nav.ts` items per role.
- `apps/web/src/flow-honesty.state.test.ts`: a pack left at `awaiting_buyer` gives the order message and library text above and not "Confirming payment"; a paid order is unchanged; the discover no match view for `already_owned`.
- `apps/web/src/skin.state.test.ts` (one assertion changed, see below) and `flow-a11y.state.test.ts`: the focus and status source checks.
- `lint`, `typecheck`, `format:check`, `check:isolation`, `check:no-live-host`, `check:secrets-names`, `check:routes` all exit 0.

Changed test, and why: `skin.state.test.ts` pinned `window.location.reload()` in `AppearanceControl`. A reload cannot keep focus on the radio, so the spec contradicts it; the assertion now pins the in place `data-skin` change.

Do not: touch `domain/payments`, approval, paypal, transport; edit `globals.css`; add a dependency or an inline style.

Needs an owner (not built): a buyer "Cancel this order" and a "Continue to payment" action on the order page. Cancel needs an exported per order abandon next to `abandonOne`. Continue is possible (`beginCheckout` resumes an `awaiting_buyer` order) but `order-pages.state.test.ts` pins that the order page has no approve or checkout link or button (DP-5b), so it is a product decision.

Evidence for the PR: red run, green run, real browser pass of sign out, abandon then library and order wording, discover message, keyboard skin change and focus after Find articles.
