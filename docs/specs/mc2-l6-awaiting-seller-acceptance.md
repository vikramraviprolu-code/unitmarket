# MC2-L6: "awaiting seller acceptance" state for a pending capture

Task: when PayPal holds a capture pending for the seller to accept (`RECEIVING_PREFERENCE_MANDATES_MANUAL_ACTION` or any PENDING capture with a seller-side reason), tell the buyer and the seller plainly, and give the seller the D-083 choice: wait, or list an offer in another currency. Never convert for the seller.
Package: domain/payments (reason mapping only), apps/web views (buyer order page, receipts note, seller console). Decisions: D-083. Branch: feat/mc2-l6-awaiting-seller-acceptance. Commit: `feat(web): <what> (MC2-L6)`.

Facts to read first: `domain/payments/src/apply.ts` ~236 already sets `order_units.status='pending'` and `status_reason` from `capture.status_reason`; `match.ts` ~126 returns `pending`; `domain/payments/src/refunds.ts` treats PENDING refunds separately. Do not change money states or recovery logic.

Rules:

- Map `status_reason` values to a closed set of view labels: `RECEIVING_PREFERENCE_MANDATES_MANUAL_ACTION` → "Awaiting seller acceptance"; other PENDING reasons → existing generic "Payment pending" text. Unknown reason strings never rendered raw.
- Buyer order page and library: show "Awaiting seller acceptance. You have not lost money; access unlocks when the seller accepts or PayPal returns the payment." (final copy by builder, plain words, no em dashes). Access state stays locked until the existing capture-complete path unlocks it.
- Seller console (sales and exposure views): list pending units with the reason label, count and amount per currency, and one panel with the two D-083 choices in plain words: wait, or list an offer in another currency (links to the existing new-offer page; no automatic action, no conversion). Do not penalise buyers or other sellers.
- No new states in the money state machine. No new PayPal call. No change to refund or recovery behaviour.

Acceptance tests (red then green): reason mapping table (known, unknown, null); buyer page shows the label and not the raw reason; seller console shows the units with currency and the two choices; a fixture-driven order with the manual-action reason ends `pending` and unlocks after the later COMPLETED capture; golden copy test; adversarial test that an unknown or hostile `status_reason` (HTML, 10k chars) is never rendered raw. All six suites, lint, typecheck green.

Do not: change `place`, `capture`, `refunds`, ledger, receipts amounts, transport or any lock. Evidence: red/green runs and the rendered text.
