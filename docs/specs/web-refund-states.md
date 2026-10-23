# CO-8: refund and pending states in the web app, operator refund route, offline journey

Task: let an operator with MFA refund a unit from `/ops`, show refund and pending states to the buyer from stored data, and prove the journey end to end offline.
Package: `apps/web` Owner: Sonnet 5.5 builder, effort high (operator money route) Reviewer: Opus 5.5 high (route and composition), screenshots for copy; Sakthi merges
Wave: W5, after CO-3, CO-4, CO-5 and CO-6 merge. Assumptions: ASM-59, ASM-51, ASM-56. Requirements: nfr.md P9, P13, P16, A11Y-4, A11Y-7, COMP-4; C-06, C-07; architecture 9.5.

Goal: `POST /api/refunds` is `withRoute({ auth: 'operator', csrf: true, idempotent: true, maxBody: 4096 })` with input `{ unit_id, amount_minor: number | null, reason: string (3 to 200 chars) }`; it refuses an actor without `mfa: true` (403), then calls `requestRefund` and `executeRefund` (CO-4); a replay of the same `Idempotency-Key` returns the stored answer and makes no second request. `/ops` gets a refund form per captured unit (amount optional, "Refund the rest" when empty; reason required), shown only to MFA sessions. Buyer views come from stored state only: library item `Refunded: access has ended` (online), `Refunded: links have stopped. The copy you downloaded cannot be recalled.` (keep), `Partially refunded: your access continues`; receipt shows each refund line and the version; order page shows `Payment pending at PayPal` and `Confirming payment` in an `aria-live="polite"` region (A11Y-4); every money screen keeps the label from `environment`. The dry-run order model (`apps/web/src/server/dryrun-model.ts`) learns `refund_capture` and `get_refund` and lists refunds on GET order, so the journey runs offline (today it answers `dry_run_miss`).

Inputs: CO-4 (`requestRefund` codes `mfa_required`, `refund_in_flight`), CO-5 (window rules), CO-6 (MFA sessions), `apps/web/composition.server.ts`, `apps/web/src/server/dryrun-model.ts`, `apps/web/src/app/{ops,library,receipts,orders}/**`, `domain/library` (status text source).

Outputs: `apps/web/src/app/api/refunds/route.ts`, `apps/web/composition.server.ts` (`engine.refund`, wiring only; logic in `apps/web/src/server/refund.ts`), the page files above, `apps/web/src/server/dryrun-model.ts`, `apps/web/e2e/refund.spec.ts`, tests below, the route list entry.

Order: commit 1 is tests, e2e spec and golden copy only, run red; then implement.

Acceptance tests:

- `corepack pnpm vitest run --project state apps/web/src/refund.state.test.ts`: operator without MFA 403; buyer 404 (no existence oracle); replayed key gives one request; over-refund 409 with a plain message.
- `corepack pnpm vitest run --project integration apps/web/src/refund.integration.test.ts`: dry run, through the routes: buy, partial refund, remainder, library and receipt states after each step, INV1 to INV4 green.
- `corepack pnpm vitest run --project adversarial apps/web/src/refund.adversarial.test.ts`: CSRF missing 403; amount as a string, negative, fractional or over the cap refused; another operator's session cookie on a stopped session refused; `refunds_enabled` off answers 503 `Refunds paused`.
- `corepack pnpm vitest run --project golden apps/web/src/refund-copy.golden.test.ts`: buyer copy for each state matches the golden text.
- `corepack pnpm test:e2e -- refund.spec.ts` (offline, Playwright): buyer buys; operator signs in with a TOTP code, refunds part; buyer sees "Partially refunded"; operator refunds the rest; buyer sees "Refunded" and the item cannot be opened; keyboard only; the status change is announced.
- `corepack pnpm ci && corepack pnpm check:routes && corepack pnpm check:bundle`: exit 0.

Do not: give buyers a refund button (refunds are operator decisions, P9); compute any state in the page; change payments or access rules; touch the webhook route; add a dependency (no axe until O-2).

Evidence for the PR: red summary; pass counts; screenshots of the five buyer states and the ops form; the route inventory diff.

Branch: `feat/web-refund-states` Commit: `feat(web): operator refunds with MFA, refund and pending states, offline journey (CO-8)`
