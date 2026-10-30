Task: GATEFIX2, defects from the final end to end gate (items 2 to 7)
Package: apps/web, domain/offer-entry (one no-match reason), packages/contracts (the reason list) Owner: builder Reviewer: Opus, then coordinator
Branch: fix/gatefinal Commit: type(web): <what> (GATEFIX2)

Goal: say only what is true. Not touched: domain/payments, domain/approval, packages/paypal, packages/transport, globals.css.

- (2) /help/<topic> with no `item` has no button to open a case. It shows plain guidance and a link to My library. With `item` it
  keeps "Ask us to look at this". Pure view in lib/help-view.ts.
- (3) New no-match reason `unpaid_order` (contract enum, additive). startFromOffer answers it when the buyer's only hold on the
  article is an open unpaid order (same test as buyerStatusText: order awaiting_buyer or created, PayPal order not approved, money
  unknown or pending, unit not pending). `already_owned` stays for paid or active entitlements. The offer page says "You have an
  unpaid order for this article" with a link to the order (engine.unpaidOrderRef, route /api/quotes adds `order_ref`). Discovery says
  the same in its notice. The unpaid library item page links to the order (LibraryEntry.order_ref).
- (4) Buyer terms: replace "nothing is charged for that attempt. You can start again" with what is true: an unpaid order stays open
  until it is cancelled or it expires, nothing is charged until the buyer approves at PayPal. Legal copy and golden.
- (5) A quote refused at "Review and approve" (expired, offer changed) hides the price card and shows one message "This price is no
  longer available" with the reason and a way to ask again. No "Could not get a price" above a live Review button.
- (6) Publisher terms and the payee page: payees are marked as checked "when the demo data is loaded or by an operator check".
- (7) Buyer offer page: `on_sale` from stored data (authorised, not superseded, publisher active, inside validity). Not on sale shows
  "Not on sale" and no prices or form. Publisher version history: only the newest version of an authorised offer reads "On sale";
  older authorised versions read "Replaced by a newer version".

Inputs: docs/specs/order-a-cancel-resume.md, the screenshots of the gate. Outputs: lib/help-view.ts, lib/offer-flow-view.ts,
lib/offer-copy.ts, lib/legal-copy.ts, lib/buyer-copy.ts, the pages named above, composition.server.ts (unpaidOrderRef, on_sale,
order_ref), quotes route, start.ts, quote.ts, tests, golden files.
Do not: touch other packages, add dependencies, edit globals.css, edit a test except one whose pinned copy was wrong (named in the PR).

Acceptance tests (worktree, targeted)

- `corepack pnpm exec vitest run --project unit apps/web/src/lib/help-view.test.ts apps/web/src/lib/offer-flow-view.test.ts` passes.
- `... --project state domain/offer-entry/src/start.unpaid.state.test.ts apps/web/src/gatefix2.state.test.ts` passes (unpaid order says
  `unpaid_order`, paid says `already_owned`, cancelled quotes again, on_sale false when withdrawn or suspended).
- `... --project golden apps/web/src/legal-copy.golden.test.ts apps/web/src/offer-copy.golden.test.ts` passes.
- lint, typecheck, format check, check:isolation, check:no-live-host, check:secrets-names; `@umsbx/web` build once.
