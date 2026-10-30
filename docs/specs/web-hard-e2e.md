# HARD-E2E: browser coverage for the publisher area, legal pages, passcodes, Appearance, reader and sign out

Task: add Playwright specs for what the 27 existing journeys did not reach.
Package: `apps/web` (e2e only) Owner: Sonnet 5.5 builder Reviewer: Opus 5.5
Goal: `pnpm test:e2e` also covers publisher sign-in with the publisher passcode (and refusal of the demo and judge passcodes), the publisher home links, offers revise then withdraw as a buyer sees them, a payee change request decided by an operator, sales and statement figures after a dry-run purchase checked against the receipt, operator publishers page with suspend and reactivate, the judge passcode (a buyer, never the operator or a publisher), the four legal pages and footer links, the Appearance control persisted across a reload, the reader view, sign out, and an unpaid order showing "Not paid yet". Each file starts from fresh state, is deterministic (no sleeps, no random) and the whole addition runs in about 3 minutes.

Inputs: the existing e2e files, `apps/web/playwright.config.ts`, the public RFC 6238 test key already in that config.
Outputs: `apps/web/e2e/{site-shell,passcodes,publisher-pages,purchase-reader-statement,zd-ops-publishers,ze-publisher-offers}.spec.ts`; `support.ts` (an optional `publisher` on `askPrice` and `payWithScenario`); `playwright.config.ts` (synthetic `UMS_PUBLISHER_PASSCODE_HASH` and `UMS_JUDGE_PASSCODE_HASH`, test fixtures, not secrets).

The unpaid-order check runs inside the purchase spec (the order before the pretend payment is approved), because each buyer may make only 10 approvals an hour and the existing journeys leave buyer A one short for a separate order.

Order notes: file names keep the specs that change shared records (`zd-`, `ze-`) after `zcomposite.spec.ts` and before `zz-ops-stop.spec.ts`, whose stop stays in force. Sign-in refusals spend a persona token each and a good sign-in gives them back, so no persona has more than two refusals before a success. The operator code is made for the step after the server's, retried once if that step was used.

Acceptance tests:

- `corepack pnpm --filter @umsbx/web build` then `corepack pnpm test:e2e`: all specs pass, offline; the count rises from 27.
- Run the new specs twice in a row: same result both times.
- `corepack pnpm check:secrets-names && corepack pnpm lint && corepack pnpm typecheck && corepack pnpm format:check`: exit 0.
- `git status` after a run shows no tracked file modified.

Do not: touch product code; add a dependency; use a real secret, hash or code; sleep or read a clock.

Evidence for the PR: the e2e list output with the new total.

Branch: `feat/hard-e2e` Commit: `test(web): e2e for publisher area, legal, passcodes, appearance, reader, sign out (HARD-E2E)`
