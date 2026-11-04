# API-A: buyer, seller and operator endpoints under /api/v1 (items B1-B12, S1-S5, O1-O6)

Task: expose the existing buyer, seller and operator flows as `/api/v1` routes on the W0 wrapper, through the W0 facades.
Package: `domain/catalogue` (one new file `src/search.ts` and its export, A0 only), `apps/web/src/app/api/v1/**` (new routes), `apps/web/src/api-v1/{buyer,seller,ops}.ts`, `packages/contracts/src/v1.ts` (fill lane-A bodies, additive), `docs/api/openapi-v1.json` Owner: Sonnet 5.5 builder, effort medium Reviewer: Opus 5.5 high, merges after rubric pass
Wave: W1, after API-W0 merges; runs beside API-B and API-C. Points: 28 (A0 M, 22 S, O4 L); 24 items. A0 was added after scoring: B1 and G5 need text search and the sandbox has none. Rubric: `docs/specs/api-mvp1-rubric.md`. Decisions: D-087.

Goal: an API client holding a key with the right scopes can do everything a buyer, seller or operator does today through the web pages, with the same results, the same domain calls and the same safety. Every route is a thin call into an existing `Engine` or domain function: no new business logic. If an item has no existing function behind it, stop and report (it is then not S).

Search: **A0 `searchCatalogue` (M).** Copy and adapt the simulation's `packages/core/catalogue/search.ts` (`AIC_Hackathon_UnitMarket@a99204b`) into `domain/catalogue/src/search.ts` with the provenance header (`// Origin: AIC_Hackathon_UnitMarket@a99204b:packages/core/catalogue/search.ts. Adapted; owned by SBX.`): rank authorised offers by word overlap with `q`, then price, then id; deterministic; no import of the simulation. Plain catalogue search, not pools or ledger, so D-087 (2) does not apply. Lane B's `search_catalogue` reuses it.
Buyer (key owner `buyer`): B1 `GET /api/v1/catalogue/search` (catalogue:read; authorised offers, filters q, publisher, max_price, cursor); B2 `GET /api/v1/offers/{id}`; B3 `POST /api/v1/briefs` (need parsing, as `/api/briefs`; `ai_enabled` off returns the existing scripted result); B4 `POST /api/v1/briefs/{id}/discover` (as `/api/discover`); B5 `POST /api/v1/quotes`; B6 `POST /api/v1/approvals` (returns approval_id and token in the body, never a cookie); B7 `POST /api/v1/orders` (orders:write, approval_id + token); B8 `GET /api/v1/orders` (the function behind the buyer orders page); B9 `GET /api/v1/orders/{ref}`; B10 `POST /api/v1/orders/{ref}/cancel`; B11 `GET /api/v1/library`; B12 `POST /api/v1/library/{id}/link`.
Seller (key owner `publisher`; publisher id always from the key, never the body): S1 `GET /api/v1/seller/offers`; S2 `POST /api/v1/seller/offers`; S3 `PATCH /api/v1/seller/offers/{id}` (revise); S4 `DELETE /api/v1/seller/offers/{id}` (withdraw); S5 `GET /api/v1/seller/sales`.
Operator: O1 `GET /api/v1/ops/overview` (ops:read); O2 `GET /api/v1/ops/reconciler` (ops:read, last passes); O3 `GET /api/v1/ops/orders/{ref}` (ops:read, the operator order detail); O4 `GET /api/v1/ops/switches` (ops:read, read-only switch and lock states) plus the key-access guard: an adversarial proof that no key of any scope reaches `/api/ops/stop`, `/api/ops/start`, any switch-setting route or any MFA-gated operator POST (operator keys map to `mfa: false`, W0). Stop, start and switches stay session plus TOTP only; O5 `GET /api/v1/status` (public, same body as `/healthz`); O6 the existing `POST /api/webhooks/paypal` is listed in the OpenAPI file as the inbound webhook, unchanged, no new route.

Routes that differ from effort-estimate section 7 (same ids and sizes; the sandbox has no packs, articles or v1 webhook alias):

| Id    | Estimate route                      | Spec route                                        | Reason                                                      |
| ----- | ----------------------------------- | ------------------------------------------------- | ----------------------------------------------------------- |
| B4    | `POST /v1/briefs/{id}/confirm`      | `POST /api/v1/briefs/{id}/discover`               | Sandbox flow is brief, discover, quote                      |
| B5    | `GET /v1/packs/{id}`                | `POST /api/v1/quotes`                             | No packs in the sandbox; the quote is the pack              |
| B6    | `POST /v1/packs/{id}/revise`        | `POST /api/v1/approvals`                          | Revise is a new quote; approval is the next real step       |
| B10   | `GET /v1/orders/{id}` (second read) | `POST /api/v1/orders/{ref}/cancel`                | Order detail is B9; cancel exists in the sandbox            |
| S1-S2 | `POST/GET /v1/articles`             | `GET/POST /api/v1/seller/offers`                  | Sandbox publishers manage offers; article upload is roadmap |
| O3    | `POST /v1/settlement/reconcile`     | `GET /api/v1/ops/orders/{ref}`                    | Keys never reach MFA-gated operator POSTs (D-087 (4))       |
| O4    | `POST /v1/ops/kill-switch`          | `GET /api/v1/ops/switches` + key-access guard     | Same rule; the guard is the L-sized security work           |
| O6    | inbound webhook under `/v1`         | existing `/api/webhooks/paypal` listed in OpenAPI | PayPal registration stays on the existing path              |

B6 check done at design time: the existing `/api/approvals` handler already returns `token` in the body (`apps/web/src/app/api/approvals/route.ts:74`), so no domain change is needed.

Inputs: API-W0 merged; the existing `/api/*` route handlers as the reference for each call; `apps/web/composition.server.ts` `Engine`.
Outputs: the routes above, `domain/catalogue/src/search.ts`, their tests, the regenerated OpenAPI file. Not other `domain/*` files, `packages/{paypal,transport,safety,security}`, existing `/api/*` routes.

Order: commit 1 is tests only, run red; then implement.

Acceptance tests:

- `corepack pnpm vitest run --project unit domain/catalogue/src/search.test.ts`: word-overlap ranking, ties by price then id, empty `q` returns all authorised offers in price order, only authorised offers ever returned; file starts with the provenance header.
- `corepack pnpm vitest run --project contract apps/web/src/app/api/v1/buyer.contract.test.ts apps/web/src/app/api/v1/seller.contract.test.ts apps/web/src/app/api/v1/ops.contract.test.ts`: one table-driven case per item id, titled with the id; each response parses with its v1 schema; each v1 result equals the result of the matching old route on the same seeded data.
- `corepack pnpm vitest run --project integration apps/web/src/app/api/v1/flow-a.integration.test.ts`: a buyer key goes search, quote, approval, order, dry-run checkout, library link, and the order is paid; a seller key creates, revises and withdraws an offer and sees the sale.
- `corepack pnpm vitest run --project adversarial apps/web/src/app/api/v1/scope-a.adversarial.test.ts`: seller key on a buyer route 403; buyer A reading buyer B's order 404; publisher id in a body is ignored; no key of any scope reaches stop, start, switch routes or an MFA-gated operator POST (each case named); an operator key with `ops:write` still gets 403 on every MFA-gated POST; repeated POST with one Idempotency-Key places one order.
- More adversarial cases in `scope-a.adversarial.test.ts`: a bearer key on the existing session route `POST /api/ops/start` gets 401 or 403; a route-inventory scan with a key holding every scope gets no 2xx from any path containing `start`, `stop` or `switch` except `GET /api/v1/ops/switches`; a seller key's `PATCH /api/v1/seller/offers/{id}` on another publisher's offer gets 404; `GET /api/v1/orders?cursor=` with a forged or other-buyer cursor returns 400 or an empty page and leaks nothing.
- Offline: `flow-a.integration.test.ts` runs with `fetch`, `net.connect` and `dns.lookup` stubbed to throw; zero calls.
- `corepack pnpm mutation --targets apps/web/src/api-v1/ops.ts,apps/web/src/app/api/v1/ops/switches/route.ts --require-targets`: each at least 80 percent.
- `corepack pnpm check:openapi`, `corepack pnpm check:routes`, `corepack pnpm check:no-live-host`, `corepack pnpm run ci`: exit 0; `git diff --stat origin/main -- packages/transport packages/paypal packages/safety domain ':!domain/catalogue/src/search.ts' ':!domain/catalogue/src/search.test.ts' ':!domain/catalogue/src/index.ts'` is empty (A0's own search files are the only allowed domain change; in `index.ts` only the added export line).

Do not: add business logic; change old routes; expose stop, start or switches to keys; add a dependency; connect to anything.

Evidence for the PR: red summary, pass counts per item id, OpenAPI path count.

Branch: `feat/api-a-endpoints` Commit: `feat(web): v1 buyer, seller and operator endpoints (API-A)`

## Build notes (what the code does where the spec left a choice)

- B8 (order list), O2 (reconciler) and O3 (ops order detail) had no Engine function. They are read-only projections in `apps/web/src/api-v1/` over `orders`, `order_units`, `provider_orders`, `operations` and the ops snapshot. They name no buyer, publisher, PayPal order id or merchant id.
- Buyer, seller and operator routes require the matching owner kind and a non-agent key. An agent key is 403 on every lane A route (agents arrive with lane B).
- B5, B7, B9 and B4 return the old route bodies without the web-only `display` and `ceiling_line` lines.
- B12 issues a content link that is not bound to a browser session (a key has none). Serving `/c/...` still needs a session; that is outside this lane.
- O6 is the existing `POST /api/webhooks/paypal`, listed in the OpenAPI 3.1 `webhooks` map as `payment-provider-events`. No new route.
- The key-access guard holds because no `/api/v1` route can start, stop or change a switch, and the old control routes refuse a bearer key. `GET /api/v1/ops/switches` is read-only.
- In dry-run the seed turns `paypal_outbound` on (that transport opens no socket). Lane A never changes it; the guard tests compare before and after.
- `POST /api/v1/orders` allows 20 calls a minute per key (the old session route allows 5) so a client may retry with the same Idempotency-Key. One open order per approval still holds.
