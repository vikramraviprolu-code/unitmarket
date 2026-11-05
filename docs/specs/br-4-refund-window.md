# Spec: refund deadline from the frozen terms (BR-4, UNI-80)

Task: a buyer can ask for a refund until the deadline in their sale's terms; an operator can refund later only with a stated override.
Package: `domain/rules` (deadline function), `domain/recovery` (`src/cases.ts`), `domain/payments` (`src/refunds.ts`), `apps/web`
Owner: builder (Sonnet) Reviewer: Opus (L, money) Branch: `feat/rules-refund-window`
Commit: `feat(payments): refund deadline from sale terms (BR-4)` Depends on: BR-3. Decision: D-096 (1), (3), (5).

Goal: the rule "refunds within 7 days" (or whatever the sale's terms say) is real. Version 1 snapshots (approved before BR-3) have no
`terms` block and keep today's behaviour (no deadline), stated in the PR. A version 2 snapshot always has terms (BR-3); one without
them is refused, never treated as "no deadline". A buyer who asked in time is honoured even if the operator acts later.

Design:

- `refundDeadline({ terms, access_started_at, captured_verified_at })` in `domain/rules/src/deadline.ts`, pure, exported from the root:
  start = `access_windows.started_at` (`packages/db/migrations/common/0005_access.sql:31`) if set, else
  `order_units.captured_verified_at` (`refunds.ts:105`); deadline = start + `terms.values['refund.request_window']` days. Returns
  `null` for version 1. The window is open while `at < deadline`; at exactly the deadline it is closed.
- Buyer: opening a `refund_requested` case (`openCase`, `domain/recovery/src/cases.ts:364`) is refused with `refund_window_closed`
  when `d.clock.now() >= deadline`. Before it, unchanged.
- Operator: `requestRefund` checks the deadline against the open `refund_requested` case's `created_at` when one exists for the unit,
  else against `d.clock.now()`. So a case opened in time needs no override later. `requestRefund` gains optional `override_reason`
  (3..200). Closed without it: `err({ code: 'refund_window_closed' })`. Closed with it: proceeds and writes one audit event
  `refund_outside_window` with the reason (sha256 in the journal). An idempotent replay of the same refund writes no second audit row.
  All existing guards (MFA, switch, frozen, in-flight, amount) keep their order before this check.
- Screens: `apps/web/src/app/library/[entitlement]/page.tsx` and `apps/web/src/app/receipts/[order]/page.tsx` show "Refunds can be
  requested until <date>" or "Refund period ended" (copy in `apps/web/src/lib/buyer-copy.ts`, D-051, no hard-coded day count);
  `apps/web/src/app/ops/RefundPanel.tsx` shows the deadline and an override reason field only after it; `apps/web/src/app/api/refunds/route.ts`
  accepts `override_reason` and maps `refund_window_closed` to 409 with reader-safe text.

Tests first: `domain/rules/src/deadline.test.ts` (access start, capture fallback, version 1 null, exact boundary closed);
`domain/payments/src/refund-window.state.test.ts` (inside, at the boundary, after; override path with one audit row; case opened in
time then operator after the deadline proceeds without override; version 1 sale has no deadline);
`domain/recovery/src/refund-case-window.state.test.ts` (buyer case before, at and after the deadline);
`domain/payments/src/refund-window.adversarial.test.ts` (version 2 snapshot stripped of terms refused; buyer clock skew ignored;
override reason too short refused; override without MFA refused; override replay writes one audit row);
`apps/web/src/refund-deadline-copy.golden.test.ts` (three copy states).

Acceptance: those tests plus the six suites pass, red run first; existing refund tests unchanged and green;
`corepack pnpm mutation --targets domain/payments/src/refunds.ts,domain/rules/src/deadline.ts --require-targets` kills at least
80 percent; `check:routes`, `check:no-live-host`, `check:secrets-names`, lint, typecheck, format pass.
Do not: change refund amounts, ledger rows or PayPal calls; touch `packages/transport` or `packages/paypal`; add a dependency.
Evidence: red and green runs, mutation score, screenshots of the three copy states (dry run).
