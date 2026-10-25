# DP-5: composite in the web app: pack selection, two PayPal approvals with progress, per-item lines

Task: let a buyer choose a two-publisher pack, approve once in UnitMarket, approve at PayPal once per publisher with "Step 2 of 2", and see one line per item from stored data; wire the engine and the seeding in composition.
Package: `apps/web` (including `composition.server.ts` and `src/server/dryrun-model.ts`) Owner: Sonnet 5.5 builder, effort high (holds composition) Reviewer: Opus 5.5 high (routes and composition), screenshot review for copy; Sakthi merges
Wave: MVP-D W4, after DP-3 and DP-4 merge. Owner decisions: OQ-1, OQ-8. Coordinator decisions used: OQ-5, OQ-17 (table A). Requirements: D-01 to D-03 and D-07 (user-visible side), P6, P13, P16, A11Y-4, A11Y-7, COMP-4, PAY-10.

Goal. **Pack (OQ-17):** `/discover` results get a checkbox per item and a "Buy selected together" button. The server decides; the page only explains `mixed_currency` and `too_many_publishers` in plain words. It posts the existing `proposal` selection with several `offer_ids`. **Approve:** `/approve/[id]` shows one block per publisher (display name, items, subtotal), the total, and, when `snapshot.settlement` is present, "You will approve 2 payments at PayPal, one for each publisher. You are charged only after you have approved both." **Checkout:** `POST /api/orders/[ref]/checkout` returns `{ approve_url, progress }`. **Between approvals (OQ-5):** `/checkout/return` calls `onBuyerReturn`. While a provider order still awaits the buyer, it renders "Step 2 of 2: approve your payment to <publisher> at PayPal" with one button to that stored approve URL (no automatic redirect) and "If you do not approve within 60 minutes, the whole order is cancelled and nothing is charged." It never uses an id from the URL. **Cancel:** a static `/checkout/cancel` page (PayPal's cancel URL already points there): "You did not approve this payment at PayPal. Nothing was charged. If you approved another payment of this order, it will not be taken unless you approve the rest." No cancel API (cut). **Dry run:** `/checkout/dry-run/[order]` shows one approve step per provider order with its own scenario selector, so `happy` then `declined` gives a partial offline. The model refuses a reused `invoice_id` for one payee with `DUPLICATE_INVOICE_ID`, as the owner's account does (D-033). **Order page:** one line per item: "Ready in your library", "Not charged: PayPal declined this payment" (declined, failed or abandoned only), "On hold while we check it" (frozen, H1), "Confirming payment", in an `aria-live="polite"` region. Library and receipt keep their pages and show the DP-4 line outcome. **Composition:** binds the new engine views; sets `pack_approval_window_ms` explicitly; applies `seedSupplement` (DP-1) on every boot. Offline, every publisher gets a distinct fake payee as today. In sandbox mode under OQ-1 = B, it sets the owner's merchant id and `payee_shared = true` on `harbour-ledger` and `quayside-gazette`, only where none is stored, with one `audit_log` row. The `/ops` page states from that data "Both publishers are paid into the owner's sandbox account (…<last 4>)". Labels come from `environment`.

Inputs: DP-1 to DP-4 engine functions and views, `apps/web/src/**`, `apps/web/e2e/support.ts`, `scripts/route-inventory.mjs`, CO-8 copy rules.

Outputs: the DP-5 files in `mvp-d-overview.md` section 4.

Red-first tests (commit 1):

- `composite.state.test.ts`: `pack of Harbour and Quayside reaches one approval with two blocks and "2 payments"`; `checkout returns step 1 of 2`; `return after the first dry-run approval renders step 2 of 2 with the second stored URL`; `both approved: order page lists two ready items`; `happy then declined: one ready, one "Not charged"`; `PO2 payee mismatch scenario: "On hold while we check it", never "Not charged"`; `Harbour plus Northfield: mixed_currency message, no approval`; `seedSupplement on an existing disk adds Quayside once`; `sandbox seeding sets payee_shared and writes one audit row; a stored id is never overwritten`.
- `composite.adversarial.test.ts`: `return with a forged token or another buyer's ref: 404 or ignored, no capture`; `dry run: a reused invoice id for one payee is DUPLICATE_INVOICE_ID`; `no merchant id, PayPal order id or reason code in any buyer page`.
- `composite.golden.test.ts` with `composite-copy.golden.txt`: every buyer string above.
- e2e `composite.spec.ts`: the happy and the partial journey on the dry run, keyboard only, with screenshots.

Acceptance tests:

- `corepack pnpm vitest run --project state --project adversarial --project golden apps/web`: all pass.
- `corepack pnpm --filter @umsbx/web test:e2e -- composite.spec.ts`: both journeys pass offline.
- `corepack pnpm check:routes && corepack pnpm check:bundle && corepack pnpm check:secrets-names && corepack pnpm check:hosting`: exit 0.
- `corepack pnpm test && corepack pnpm lint && corepack pnpm typecheck && corepack pnpm format:check`: exit 0.

Do not: change domain packages, the transport or safety packages; add a cancel API, case choice buttons, "Bought together" or an ops report (cut); redirect to PayPal without a click after the first approval; show a merchant id beyond the operator's last 4; hard-code "Sandbox" or "Dry run"; add a dependency.

Evidence for the PR: red summary, pass counts, screenshots of approve, step 2 of 2, partial order page, on-hold line, cancel page (dry-run labels visible).

Branch: `feat/web-composite` Commit: `feat(web): composite pack, two approvals with progress, per-item lines (DP-5)`
