# DP-1: composite snapshot gates, settlement route and supply data

Task: make a two-publisher approval carry its settlement route in the frozen snapshot, cap it at two publishers, prove the P18 and mixed-currency gates for a composite, and add the supply data a USD two-publisher pack needs.
Package: `domain/approval`, `packages/contracts` (approval), `domain/catalogue` (seed), `packages/db` (migration 0010 only if OQ-1 = B) Owner: Sonnet 5.5 builder, effort medium Reviewer: Opus 5.5 medium; Sakthi merges
Wave: MVP-D W1, first lane. Prerequisites: OQ-1, OQ-9, OQ-12, OQ-15, OQ-18 answered in `docs/decision-log.md`. Requirements: D-04, D-07, P18, P5 (snapshot side), A-08, A-09.

Goal: `requestApproval` keeps every existing check and adds: (1) a selection whose items come from more than `MAX_PUBLISHERS = 2` publishers is refused `too_many_publishers` (422) before any row is written (OQ-12); (2) the snapshot gains `settlement: { route: 'single' | 'per_publisher'; payments: number }`, `single` with `payments: 1` for one publisher, `per_publisher` with `payments` equal to the publisher count otherwise; it is part of the canonical hash, so the buyer's consent covers "N separate PayPal payments" and `placeOrder` (DP-2) reads the route from the snapshot, never from config. `ApprovalSnapshotSchema` accepts `settlement` as optional (stored approvals without it stay valid and hash the same) and refuses `payments` that differs from the publisher count or a `single` route with two publishers. P18 and D-07 already hold in code; this lane proves them for a composite: a pack where either publisher lacks `payee_verified_at` or `paypal_merchant_id` is `publisher_unverified` and writes no approval row; USD plus GBP is `mixed_currency` before approval. Seed (OQ-15): add a third fictional publisher `quayside-gazette` ("Quayside Gazette (fictional)", country US) with two short team-written articles and two authorised USD offers (`BOTH(150, 120)` and `BOTH(90, 90)`), mirrored in `fixtures/catalogue/seed.json`; existing publishers, articles and prices are unchanged. If OQ-1 = B: migration `0010_publisher_payee_shared.sql` drops the `UNIQUE` constraint on `publishers.paypal_merchant_id` and adds a plain index, so two publishers may name the owner's one sandbox account; the publisher row stays the unit of attribution (units, ledger and receipts key on `publisher_id`). If OQ-1 = A, no migration and the uniqueness test stays.

Inputs: `domain/approval/src/approval.ts` (`requestApproval`, `MAX_ITEMS`), `packages/contracts/src/approval.ts` (`ApprovalSnapshotSchema`), `domain/approval/src/snapshot.ts` (`contentHash`), `domain/catalogue/src/{seed-data.ts,seed.ts}`, `packages/db/migrations/common/0001_core.sql`, `packages/db/src/schema.state.test.ts`.

Outputs: `domain/approval/src/{approval.ts, errors.ts}`, `domain/approval/src/composite.state.test.ts`, `domain/approval/src/composite.adversarial.test.ts`, `packages/contracts/src/approval.ts` and `approval.test.ts`, `domain/catalogue/src/seed-data.ts`, `fixtures/catalogue/seed.json`, the seed-count assertions in `domain/catalogue/src/catalogue.state.test.ts` (2 to 3 publishers, 8 to 10 articles and offers: these contradict the spec and are changed, say so in the PR), `packages/db/migrations/common/0010_publisher_payee_shared.sql` and `packages/db/src/schema.state.test.ts` (B only).

Red-first tests (commit 1, run red):

- `composite.state.test.ts`: `two publishers, USD: snapshot has settlement per_publisher, payments 2, two publisher blocks with their own payee and amount, total = sum`; `one publisher: settlement single, payments 1`; `three publishers: too_many_publishers, no approval row`; `D-04 second publisher has no payee_verified_at: publisher_unverified, no row`; `D-04 second publisher has no merchant id: publisher_unverified`; `D-07 harbour (USD) plus northfield (GBP): mixed_currency, no row`; `settlement is inside the hash: changing payments in the stored snapshot gives snapshot_tampered at verify`; `an approval stored without settlement still verifies` (back-compat).
- `composite.adversarial.test.ts`: `the caller cannot pass a route, payee or amount (strict input)`; `same article twice through two offers: unknown_selection`; `payee changed after approval: placeOrder answers payee_unavailable for a composite` (uses today's `placeOrder`, which still writes one provider order; DP-2 changes the shape, not this answer).
- `packages/contracts/src/approval.test.ts`: `settlement optional; payments must equal publishers.length; single with 2 publishers refused`.
- B only, `schema.state.test.ts`: `two publishers may share one merchant id`; `0010 recorded by name`.

Acceptance tests:

- `corepack pnpm vitest run --project state domain/approval domain/catalogue packages/db`: all pass, including the titles above.
- `corepack pnpm vitest run --project adversarial domain/approval` and `--project unit packages/contracts`: pass.
- `corepack pnpm check:fixtures && corepack pnpm check:provenance`: exit 0 (seed mirror and labels).
- `corepack pnpm test && corepack pnpm lint && corepack pnpm typecheck && corepack pnpm format:check`: exit 0.

Do not: touch `domain/payments` (the route is consumed by DP-2), the web app, composition, the transport or the safety packages; change any existing price; add a dependency; write a real merchant id anywhere.

Evidence for the PR: red run summary, pass counts, the migration text (B), a sample composite snapshot (fake payee ids only).

Branch: `feat/approval-composite-gates` Commit: `feat(approval): composite settlement route and gates (DP-1)`
