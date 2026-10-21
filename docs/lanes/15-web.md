# Lane 15: web shell, composition and the buyer journey pages with visual fit cards

Task: the Next.js app: production-style design system, the composition root, route handlers through `withRoute`, and the buyer, library, receipt, discovery and minimal operator pages, all in dry-run mode.
Package: `apps/web` Owner: Sonnet worker W-15 (may split into 15-ui and 15-routes, see below) Reviewer: Opus 5.5 (composition and routes); screenshot review by the coordinator for UI
Wave: 3 (needs lanes 02, 05a, 05b, 06, 09, 10, 11, 14a, 14b; can start the design system and static pages from wave 2 using fixtures). Size: 12 h (15-ui 6 h, 15-routes 6 h). Owner of `apps/web/src/server/composition.ts` and the UI tokens.

## Goal
A buyer completes the publisher-offer journey and the discovery journey end to end on localhost with a clear, calm, production-style interface; every money screen carries the `Dry run` or `Sandbox` label from data; nothing in the browser holds a secret or calls PayPal directly.

## Inputs
- Architecture 3, 9.8, 9.11; nfr.md P8, P13, P14, P16, SOP 10, A11Y-1 to A11Y-7, PERF-7.
- Exported functions of lanes 02, 05a, 05b, 06, 07, 09, 10, 11, 14a, 14b (signatures in their specs). `RouteMeta`, `withRoute` from lane 11.
- Ideas only (no code) from the simulation's `apps/web/app/*` screens at `a36ddc03fd0b962000f686291c145b50ee337f90`.
- Dependencies: `next`, `react`, `tailwindcss`, `server-only` (D-4); `@playwright/test` for e2e (D-4).

## Outputs
- `apps/web/src/server/composition.ts` (the only file that builds ports: `bootOrExit(process.env)` from lane 02 is called here through config, PGlite driver, runtime clock and ids, logger, dry-run transport with the outbound gate, adapter, content store, scripted model; `UMS_MODE=sandbox` builds the sandbox transport, which is the sealed stub in MVP-A), `apps/web/src/server/engine.ts` (thin facade over domain functions), `instrumentation.ts` (migrate, recover on startup, start the job loop in-process).
- Pages (`apps/web/src/app/`): `/` (two entries: "I have an article link" and "Find articles for my need"), `/o/[publisher]/[offer]` (offer, options, price, ceiling input, renegotiation input only when allowed), `/discover` (need and ceiling; fit cards), `/approve/[id]` (frozen snapshot, consent checkboxes, 15-minute countdown with a 2-minute warning and one-step renewal), `/checkout/dry-run/[order]` (labelled "Dry run: no PayPal", approve or cancel buttons that drive the dry-run scenario), `/checkout/return`, `/orders/[ref]` (live status with `aria-live`), `/library`, `/library/[entitlement]` (download or read; window; evidence), `/receipts/[order]` (HTML receipt with sha256), `/help/[case]`, `/ops` (read-only: orders, operations, alerts, switches, approval gate state, invariants), `/signin` (persona passcode).
- Route handlers (`apps/web/src/app/api/**/route.ts`), each exporting `RouteMeta`: `POST /api/session`, `POST /api/quotes`, `POST /api/briefs`, `POST /api/discover`, `POST /api/approvals`, `POST /api/orders` (idempotent), `POST /api/orders/[ref]/checkout`, `GET /api/orders/[ref]`, `GET /api/library`, `POST /api/library/[id]/link`, `GET /c/[token]` (content route through `planServe`), `GET /api/receipts/[order]`, `POST /api/cases`, `GET /healthz`.
- UI components (`apps/web/src/ui/`): `FitCard` (five dot rows with icons, band chip, price and option prominent, text alternative), `StatusBanner`, `EnvLabel`, `Countdown`, `WindowMeter`, `EmptyState`, `ErrorState`, `Loading`.
- Playwright tests `apps/web/e2e/*.spec.ts` (offline mode).

## Interfaces
`FitCard` props: `{ card: FitCard; title: string; publisher: string; price: Money; option: AccessOption; onChoose(): void }`; renders level `null` as an empty outline with "not assessed", never a number or a percentage. `EnvLabel` props: `{ environment: EnvironmentLabel }` (never from a build flag). Every route: `export const meta: RouteMeta` and `export const POST = withRoute(meta, Schema, handler)(deps)`.

## Acceptance tests
- `corepack pnpm test:e2e` (Playwright, offline): `offer journey: offer, approve, dry-run approve, return, library shows Ready with 5 days, receipt hash matches` (A-12, PAY-09); `ceiling below price shows no match without alternatives` (A-05); `discovery journey reaches the same approval screen` (B-11 offline twin); `claim-only scenario shows Confirming payment` (A-11); `pending scenario shows Payment pending at PayPal` (A-16); `mismatch scenario shows a calm frozen message and a case` (A-13); `every money page shows Dry run` (A-22); `full flow by keyboard` (A11Y-1); `status changes announced via aria-live` (A11Y-4); `approval countdown warns at 2 minutes` (A11Y-5).
- `--project adversarial apps/web`: `no 'use client' file imports a server module`; `every route file exports RouteMeta` (`pnpm check:routes`); `buyer B gets 404 on buyer A's order, library item, receipt, link` (A-20); `no card-like input in any rendered page` (P8); `CSP and security headers on every page` (SOP 10); `content route sends no-store and no-referrer` (P14).
- `corepack pnpm --filter @umsbx/web build` then `corepack pnpm check:bundle` passes (A-25); `productionBrowserSourceMaps` is false.

## Security and NFR gates
P8, P13, P14, P16, SOP 5, SOP 10, A11Y-1 to A11Y-7 (manual parts recorded), PERF-7 (Lighthouse recorded, not gating in MVP-A), A-20, A-22, A-25.

## Do not
Import domain internals (only package entry points through `engine.ts`); read `process.env` outside composition via config; load any PayPal script or SDK; add dependencies beyond D-4; put logic that decides money state in the web layer; touch other packages.

Branch `feat/web-buyer-journey` Commit `feat(web): composition, routes and buyer journey pages (SBX-A-15)`.
