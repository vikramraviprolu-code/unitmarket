# DP-4: per-publisher ledger sums, reconciliation invariant and receipt sections

Task: prove per publisher that ledger money equals verified captured minus refunded (P11, D-06), report it to operators, and show each publisher's outcome on the buyer's receipt.
Package: `domain/ledger`, `domain/payments` (`invariants.ts` only), `domain/receipts`, `packages/contracts` (ledger, receipts) Owner: Sonnet 5.5 builder, effort medium ($) Reviewer: Opus 5.5 medium, mutation check on the sums; Sakthi merges
Wave: MVP-D W3, after DP-2; parallel with DP-3 (disjoint files). The pure `sums.ts` part may start during DP-2. Prerequisites: OQ-16. Requirements: D-06, P11 per publisher, INV1, architecture 5 and 9.5, nfr P16 and COMP-4.

Goal. `publisherBalances(rows: { publisher_id, entry }[])` in `domain/ledger/src/sums.ts` (pure) returns per publisher and currency `{ sold_minor, refunded_minor, reversed_minor, net_minor }`, reusing `unitBalance`; fee rows never change the net. New invariant INV7 in `checkInvariants` (`domain/payments/src/invariants.ts`): for each publisher, the ledger net equals the sum over that publisher's units of verified captured amount minus `refunded_minor`; every capture id belongs to one unit of one publisher; a unit's ledger rows carry the unit's order currency. A failing INV7 names the publisher id and the difference, and the existing invariant report shows it, so drift on one publisher is caught in one pass. `publisherReport(db, { currency })` (read-only, operator) lists per publisher: orders, captured, refunded, net, units frozen or declined. Receipts (OQ-16: one receipt per UnitMarket order): the body gains `publishers: [{ publisher_id, display_name, amount, currency, capture_id_sanitised | null, outcome: 'paid' | 'not_charged' | 'waiting' | 'refunded' | 'partially_refunded' | 'on_hold' }]`; item lines keep their own capture id; v1 is written at the first verified capture (today's rule), a new version when another publisher settles, is refunded or held; the HTML shows one section per publisher with "You were not charged for this item" for a declined or failed unit, and the `environment` label as today. The payee shown is the publisher's display name, never a merchant id.

Inputs: DP-2 (units per provider order, `paid_partial`), `domain/ledger/src/{ledger.ts,sums.ts}`, `domain/payments/src/invariants.ts`, `domain/receipts/src/{body.ts,html.ts,receipts.ts}`, `packages/contracts/src/{ledger,receipts}.ts`.

Outputs: the DP-4 files in the overview; tests `domain/ledger/src/sums.test.ts` (extended), `domain/ledger/src/publisher.state.test.ts`, `domain/payments/src/invariants.composite.state.test.ts`, `domain/receipts/src/composite.golden.test.ts` with `golden/composite-receipt.golden.txt`, contract tests.

Red-first tests (commit 1): `sums.test.ts`: `two publishers grouped; fee rows ignored; refund and reversal reduce net`; property: `sum of publisher nets equals sum of unit nets`. `publisher.state.test.ts`: `D-06 PO1 captured, PO2 declined: Harbour net = its amount, Quayside 0`; `partial refund on Harbour reduces only Harbour`; `publisherReport lists both publishers in one currency`. `invariants.composite.state.test.ts`: `INV7 holds after a happy composite and after a partial`; `an extra sale row injected on one unit (test-only direct insert under the reset session) fails INV7 naming that publisher in one pass`; `a capture id on two units fails INV7`. `composite.golden.test.ts`: `receipt v1 after PO1 verified: Harbour paid with sanitised capture id, Quayside waiting`; `v2 after PO2 declined: Quayside not charged`; `v3 after a Harbour refund`; `label from environment, Dry run and Sandbox`; `no merchant id in the body or HTML`.

Acceptance tests:

- `corepack pnpm vitest run --project unit --project state --project golden domain/ledger domain/receipts domain/payments/src/invariants.composite.state.test.ts`: all pass.
- `corepack pnpm mutation --targets domain/ledger/src/sums.ts,domain/payments/src/invariants.ts --require-targets`: each at least 80 percent.
- `corepack pnpm test && corepack pnpm lint && corepack pnpm typecheck`: exit 0.

Do not: add an UPDATE or DELETE path to the ledger; compute a fee or commission; add `platform_share_due`; touch `refunds.ts`, recovery, the web app or composition; add a dependency.

Evidence for the PR: red summary, pass counts, mutation scores, the golden receipt text.

Branch: `feat/ledger-per-publisher` Commit: `feat(ledger): per-publisher sums, INV7 and receipt sections (DP-4)`
