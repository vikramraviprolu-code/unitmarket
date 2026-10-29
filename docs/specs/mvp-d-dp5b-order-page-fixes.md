# DP-5b: order page tone and cancel page, from the DP-5 review

Task: fix the two MEDIUM findings and two cheap LOW findings of the DP-5 Opus review so a buyer is never shown a hold as a success and never lands on a dead end.
Package: `apps/web` Owner: Sonnet 5.5 builder Reviewer: Opus 5.5 high, one round; Sakthi merges
Branch: `feat/web-composite-fixes` Commit: `fix(web): <what> (DP-5b)` Decisions: D-041, D-051, D-054.

Goal. Four small changes, each with a test that fails first. Touch only `apps/web` files. No domain, migration or contract change.

1. **M1: a hold must not wear the green success banner** (`apps/web/src/app/orders/[ref]/OrderStatus.tsx`, tone logic near lines 26-33). When any item line has kind `hold`, use the warning tone, even if the order status is `paid_partial`. Also keep polling until the case line appears whenever any item has kind `hold` (today only status `frozen` has that exception, so a `paid_partial` order shows no case line until reload). The golden and state tests must stop setting `state='frozen'` by a direct UPDATE only: add a test that gets a real pack with one PayPal order captured and the other frozen (through the engine, as `composite.due.state.test.ts` does) and asserts warning tone and that polling continues until the case line shows.
2. **M2: the cancel page is a dead end** (`apps/web/src/app/checkout/cancel/page.tsx`). Add a link to the orders list and one sentence that, if the order window is still open, the buyer can still approve the other payment from the order page. Keep the page static: no API call, no state change, no id from the URL. The window length, if named, must come from `pack_approval_window_ms` (never typed in). Do not claim more than the page can know; keep "Nothing was charged for this payment" scoped to the payment the buyer cancelled. Update `composite-copy.golden.txt` for the new strings.
3. **L3:** link the disabled "Buy selected together" button to its hint with `aria-describedby`.
4. **L4:** make the D-051 test in `composite.golden.test.ts` check that "was not charged" appears only on rows whose item kind is `not_charged` (declined, failed, abandoned), never on a `hold` or `ready` row.

Acceptance (run, paste output): commit 1 holds only the new tests and is run red; then `corepack pnpm exec vitest run --maxWorkers=2 --project state --project adversarial --project golden apps/web`, `corepack pnpm --filter @umsbx/web test:e2e -- composite.spec.ts` (one worker; the spec file is `zcomposite.spec.ts`), `corepack pnpm check:routes`, `corepack pnpm lint`, `corepack pnpm typecheck`, `corepack pnpm format:check`, `corepack pnpm exec vitest run --maxWorkers=2 --project integration tests/mvp-a tests/mvp-b tests/mvp-c`.
Do not: touch `domain/*`, `packages/*`, migrations; add a dependency; contact any network or PayPal; read or write a secret; edit an existing test except to follow a stated item (list each); hard-code "Sandbox" or "Dry run".
Disk: `df -h /` before heavy steps; stop under 800 MB free.
Evidence: red summary, pass counts, a screenshot of the held pack order page (warning tone) and the new cancel page, a cost line.
