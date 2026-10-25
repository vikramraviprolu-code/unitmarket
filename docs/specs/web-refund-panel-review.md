# CO-8c: refund panel follow-ups from the CO-8 re-review

Task: three small fixes to the operator refund panel that the Opus re-review of CO-8 (merged 5a0b8e8) left open.
Package: `apps/web` Owner: Sonnet 5.5 builder Reviewer: Opus 5.5; Sakthi merges
Lane: CO-8c. Requirements: nfr.md P9, A11Y-4, A11Y-7.

Goal: (1) The result line names the order as well as the unit titles, because two cards can share a title (a notebook of six working knots): `<titles> (order <order_ref>)`, plain words, no dashes. (2) After the answer `refunds_paused_midway` the panel calls `router.refresh()` once, so the open request and the paused banner show without a manual reload, as the message promises. It never refreshes after an unknown failure (network, 500, 409 in_progress): a reload brings a new Idempotency-Key and removes the replay protection. No other refusal refreshes. (3) A 202 answer, and any answer whose state is not `completed` (queued, unknown, pending), is shown in the warning style with the text label "Not finished yet"; the green success style is for `completed` only. Colour is never the only signal.

Inputs: `apps/web/src/app/ops/RefundPanel.tsx`, `apps/web/src/lib/refund-answer.ts`, the existing answers of `POST /api/refunds` (`state`, `message`).

Outputs: `apps/web/src/lib/refund-answer.ts` (three pure helpers: `unitLine`, `refreshAfterFailure`, `answerTone`), `apps/web/src/lib/refund-answer.test.ts`, `apps/web/src/app/ops/RefundPanel.tsx`, `apps/web/e2e/refund.spec.ts`. No new file other than this spec.

Order: commit 1 is tests only, run red; commit 2 implements to green.

Acceptance tests:

- `corepack pnpm vitest run --project unit apps/web/src/lib/refund-answer.test.ts`: `unitLine` adds the order reference; `refreshAfterFailure` is true only for `refunds_paused_midway`; `answerTone` is success only for `completed`.
- `corepack pnpm test:e2e -- refund.spec.ts` (offline, chromium from `/opt/pw-browsers`): a mocked 503 `refunds_paused_midway` makes the page re-read itself once; a mocked 500 does not; a mocked 202 queued answer shows `banner-warn` with "Not finished yet"; a real refund shows `Refunded ... (order ...)` in the green banner.
- `corepack pnpm lint && corepack pnpm typecheck && corepack pnpm test && corepack pnpm check:routes && corepack pnpm run ci`: exit 0.

Do not: touch other packages or the route; add a dependency; refresh after an unknown failure; change a golden copy file or any reviewed message text.
Evidence for the PR: red output of commit 1, green output of commit 2, e2e pass list, diff stat.

Branch: `fix/refund-panel-review` Commit: `type(web): <what> (CO-8c)`
