# MC2-L5: buyer-currency display and agent ceiling on the converted price

Task: show buyers prices in their own currency (about, with rate date) beside the binding seller-currency amount; compare the agent brief ceiling on the converted price.
Package: apps/web (views, composition), domain/discovery (ceiling compare), domain/approval/offer-entry only where a read model needs the converted figure. Depends on: MC2-L4 merged. Decisions: D-084 items 4, 5, 6, 9 (display, ceiling, no-rate fallback), D-085.
Branch: feat/mc2-l5-buyer-currency-display. Commit: `feat(web): <what> (MC2-L5)`.

Goal: a buyer sees list, offer, quote and approve prices in the buyer currency at the current stored rate, labelled "about" with the rate date, with the seller-currency amount shown beside it as the binding amount. What the buyer approves, pays, and what lands in order, ledger and receipt is the seller-currency amount only. If no usable rate exists the buyer sees the seller currency alone and the purchase is never blocked.

Rules:

- Buyer currency = buyer's `country` → US→USD, GB→GBP, DE→EUR. Other countries: no conversion (seller currency shown). An account setting may override it to USD, EUR or GBP (store on the buyer account row; migration if needed; account page gets a small select; default derived, not stored, until chosen).
- Display copy: `about £1.28` then `Binding: €1.50 (rate of 3 Nov 2026)`. No italics, no em dashes, plain words. One shared formatter in `apps/web/src/lib` so lists, quote and approve use the same text. A golden copy test pins it.
- Never mix: the snapshot, the approval hash, the PayPal body and every stored amount keep the seller currency. Add an adversarial test that the order created from a converted display still carries seller-currency minor units and currency, and that tampering the displayed figure in the request changes nothing.
- Agent ceiling (domain/discovery): when the brief ceiling is in the buyer's currency, compare it with the offer price converted to the buyer currency at the stored rate (rounded half away from zero); if no usable rate, compare only offers whose currency equals the ceiling currency (current behaviour). The proposal shows both amounts.
- Calling the fx engine: use `engine.fx.refreshIfStale` at most once per request that renders a price, never blocking longer than the 3 s transport deadline, never throwing into the page.
- Offer pages, discover, approve, buyer home, library lists use the same display helper; order status and receipts show the settled seller-currency amount only.

Seed rate wording (autonomy ledger A1): `ConvertResult.source` is `'ecb'`, `'seed'` or `null`. For `'seed'` the line reads "sample rate of <date>" instead of "rate of <date>"; the ECB is never named. Add a golden line for it. L4 is merged: use `engine.fx` as it is (`getRates`, `refreshIfStale`, `convert`; `getRates` returns null on a database error).

Acceptance tests: tests first, red then green.

- DE buyer sees a USD offer as about € with the rate date and the USD amount beside it; GB buyer sees EUR offer as about £; US buyer sees a USD offer with no conversion line.
- Buyer in country FR sees the seller currency only.
- Rate older than 7 days or missing: seller currency only, approve and order still work.
- Ceiling: DE buyer brief ceiling 1.50 EUR, USD offer 1.60 USD at a rate where it converts to about 1.47 EUR is proposed; at a rate where it converts to 1.55 it is not; no rate and currency differs → not proposed.
- Tamper test as above; golden copy test; a11y/flow tests that already exist stay green.
- `pnpm lint`, `typecheck`, all six `pnpm test:*`, Playwright e2e untouched green if runnable (state in report).

Do not: change corridors, transport, payments, ledger or receipts; convert any stored amount; hard-code a rate; touch L4's tables except through the fx engine. Missing L4 interface is a stop-and-report.
Evidence: red/green runs, copy golden diff, screenshot of discover and approve pages for a DE buyer if a browser can be run.
