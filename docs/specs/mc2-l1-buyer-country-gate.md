# Spec: the buyer's country is no longer a gate (MC2-L1)

Task: let a buyer from any country be quoted, approve and order any offer whose corridor is enabled.
Package: `domain/discovery`, `domain/offer-entry`, `domain/approval` (source and their tests only) Owner: Sonnet builder Reviewer: Opus, then the coordinator merges
Branch: `feat/mc2-l1-buyer-country-gate` Commit: `feat(approval): buyer country is data, not a gate (MC2-L1)` Decision: D-084 (3)

Goal: three checks use `corridors.buyer_countries` today and stop applying: `candidatesFor` in `domain/discovery/src/discover.ts`
(corridors `WHERE enabled AND $1 = ANY (buyer_countries)`), step 4 of `domain/offer-entry/src/start.ts` (`corridorFor` is passed the
buyer country), and the `buyer_countries.includes(buyerCountry)` test in `domain/approval/src/approval.ts`. After the change a corridor is
chosen by offer currency and the publisher's country only. The `enabled` flag, `domestic_supported`, one-currency-per-order and
the ceiling-currency match in discovery stay exactly as they are. `buyer_countries` stays in the table and the contract, unused.
`corridorFor` may keep its `buyer_country` parameter but callers pass null.

Inputs: the three files above, `domain/catalogue/src/corridors.ts`. Outputs: those files, tests. Do not: touch migrations, seed data, the transport,
apps/web, contracts, or add a dependency.

Acceptance tests (tests first: commit 1 holds only tests and is run red, then implement to green):
- New state test: a buyer with country DE gets a quote, an approval and an order for a USD offer in an enabled `us-usd` corridor whose `buyer_countries` is `['US']`; same for a GBP offer with `gb-gbp` enabled.
- A disabled corridor still returns `corridor_unsupported`; an offer whose currency has no corridor still returns it.
- Discovery for a DE buyer returns offers from every enabled corridor (ceiling currency rule unchanged).
- Existing tests that asserted a buyer-country refusal are changed to the new rule and each change is named in the PR.
- `pnpm lint && pnpm typecheck && pnpm test` (all six suites) pass; show the output.
