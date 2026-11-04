# MC2-L7: operations totals in USD, EUR and GBP

Task: the operations screen shows totals in all three currencies at the latest stored rate with its date; seller statements stay in the original currency; the ledger is never converted.
Package: domain/publisher-console (or the read model behind `apps/web/src/app/ops/page.tsx`), apps/web ops view. Depends on: MC2-L4. Decisions: D-084 item 5, D-085. Branch: feat/mc2-l7-reporting-totals. Commit: `feat(web): <what> (MC2-L7)`.

Goal: an operator sees, for sales, refunds and exposure, the real per-currency figures first (USD, EUR, GBP as booked), then a "reporting view" row converted into USD, EUR and GBP using `engine.fx.convert` at the latest stored rate, labelled with the rate date and the word "about". Where no usable rate exists, show per-currency figures only and a one-line note.

Rules:

- Read-only. Reads ledger/order data per currency exactly as today (`domain/publisher-console/src/exposure.ts` groups per currency). No conversion is written anywhere. Seller statements and CSV exports keep original currency (add a test that pins this).
- Sum of converted parts: convert each currency subtotal separately, then add; rounding half away from zero per subtotal; show how it was computed in a short note.
- Copy: plain words, no italics, no em dashes; one shared helper for the reporting block; golden copy test.

Acceptance tests (red then green): totals for orders in USD+GBP+EUR convert to the three reporting views with a fixed fake rate table; missing rate → per-currency only plus the note; stale rate (> 7 days) same; statement and CSV outputs unchanged (golden); ops page renders for an empty database; all six suites, lint, typecheck green.

Do not: change ledger, receipts, payments, corridors, transport; add a table; use any rate except via the fx engine. Missing L4 interface is a stop-and-report. Evidence: red/green runs, rendered ops block text.
