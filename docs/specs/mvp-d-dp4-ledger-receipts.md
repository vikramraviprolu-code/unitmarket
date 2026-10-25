# DP-4: per-publisher ledger sums, INV7 and a per-publisher outcome on receipt lines

Task: prove per publisher that ledger money equals verified captured minus refunded (P11, D-06), and make each receipt line say which publisher it belongs to and what happened to its payment.
Package: `domain/ledger`, `domain/payments` (`invariants.ts` only), `domain/receipts`, `packages/contracts` (receipts) Owner: Sonnet 5.5 builder, effort medium ($) Reviewer: Opus 5.5 medium, mutation check on the sums; Sakthi merges
Wave: MVP-D W3, after DP-2b; parallel with DP-3 (disjoint files). The pure `sums.ts` part may start during DP-2a. Coordinator decision used: OQ-16 (table A). Requirements: D-06, P11 per publisher, INV1, architecture 5 and 9.5, nfr P16 and COMP-4.

Goal. `publisherBalances(rows: { publisher_id, entry }[])` in `domain/ledger/src/sums.ts` (pure) returns `{ sold_minor, refunded_minor, reversed_minor, net_minor }` per publisher and currency, reusing `unitBalance`; fee rows never change the net. New invariant INV7 in `checkInvariants` (`domain/payments/src/invariants.ts`): for each publisher, the ledger net equals the sum, over that publisher's units, of the verified captured amount minus `refunded_minor`. Every capture id belongs to exactly one unit of one publisher. A failing INV7 names the publisher id and the difference in the existing invariant report, so drift on one publisher is caught in one pass. Receipts (OQ-16: one receipt per UnitMarket order): each item line gains `publisher_display_name` and `outcome: 'paid' | 'not_charged' | 'waiting' | 'on_hold' | 'refunded' | 'partially_refunded'`. `not_charged` is used only for a `declined`, `failed` or `abandoned` provider order; `on_hold` for a `frozen` one (H1). The HTML prints "You were not charged for this item" or "On hold while we check it" on such a line, and the `environment` label as today. No merchant id appears in the body or the HTML. Version issuing stays where it is: DP-2a issues the version on a hold (M6); this lane only shapes the body.

Inputs: DP-2a (units per provider order, provider order states), `domain/ledger/src/{ledger.ts,sums.ts}`, `domain/payments/src/invariants.ts`, `domain/receipts/src/{body.ts,html.ts}`, `packages/contracts/src/receipts.ts`.

Outputs: the DP-4 files in `mvp-d-overview.md` section 4.

Red-first tests (commit 1):

- `sums.test.ts`: `two publishers grouped; fee rows ignored; refund and reversal reduce net`; property: `sum of publisher nets equals sum of unit nets`.
- `publisher.state.test.ts`: `D-06 PO1 captured, PO2 declined: Harbour net = its amount, Quayside 0`; `partial refund on Harbour reduces only Harbour`.
- `invariants.composite.state.test.ts`: `INV7 holds after a happy and after a partial composite`; `an extra sale row injected on one unit (test-only direct insert under the reset session) fails INV7 naming that publisher in one pass`; `a capture id on two units fails INV7`.
- `composite.golden.test.ts`: `receipt after PO1 verified: Harbour paid, Quayside waiting`; `after PO2 declined: Quayside not charged`; `after a PO2 hold: on hold, never not charged`; `labels Dry run and Sandbox from environment`; `no merchant id in body or HTML`.

Acceptance tests:

- `corepack pnpm vitest run --project unit --project state --project golden domain/ledger domain/receipts domain/payments/src/invariants.composite.state.test.ts`: all pass.
- `corepack pnpm mutation --targets domain/ledger/src/sums.ts,domain/payments/src/invariants.ts --require-targets`: each at least 80 percent.
- `corepack pnpm test && corepack pnpm lint && corepack pnpm typecheck`: exit 0.

Do not: add an UPDATE or DELETE path to the ledger; compute a fee or commission; add `platform_share_due`; build `publisherReport` or an ops page section (cut, overview section 5); touch `refunds.ts`, `apply.ts`, recovery, the web app or composition; add a dependency.

Evidence for the PR: red summary, pass counts, mutation scores, the golden receipt text.

Branch: `feat/ledger-per-publisher` Commit: `feat(ledger): per-publisher sums, INV7 and receipt line outcomes (DP-4)`
