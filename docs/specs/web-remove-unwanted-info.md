# Spec: remove three unwanted blocks from the order, library and operator screens (SCR-1)

Task: remove three pieces of content the owner circled on real screens. Removal only: no redesign, no new UI.
Package: `apps/web` Owner: builder (Sonnet) Reviewer: Opus
Branch: `feat/web-remove-unwanted-info` Commit: `feat(web): <what> (SCR-1)`

Goal: after this task (1) the buyer order page (`/orders/<ref>`) has no "What happened" section: no five-line Done / Not yet milestone list and no event timeline (so no bare "verified"); (2) My library (`/library`) has no "Jump to an item" chip row; (3) Operator Home (`/ops`) has no "Moved to other tabs" section and no stubs. Everything else on those pages is unchanged: on the order page the heading, return notice and Open now, OrderStatus, the help case card, and Report a problem; in the library the cards and their `library-<id>` anchors; on `/ops` the alerts block, Needs you, the kill switch and the cards.

Inputs: `apps/web/src/app/orders/[ref]/page.tsx`, `app/library/page.tsx`, `app/ops/page.tsx`, `lib/buyer-order-view.ts`, `lib/shell-moves.ts`, `lib/ops-copy.ts`.
Outputs (product): the three pages above; `lib/buyer-order-view.ts` loses `buyerOrderTimeline`, `orderMilestones`, `Milestone`, `WordsMap` (used only by the removed block); `lib/shell-moves.ts` loses `stubFor` and `Stub` (used only by the removed stubs; the move table and `KEPT_URLS` stay); `lib/ops-copy.ts` `OPS_HOME_SECTIONS` loses its `ops-moved` tab (it would link to nothing).
Outputs (tests): `buyer-order-view.state.test.ts`, `shell-moves.state.test.ts`, `shell.adversarial.test.ts`, `ops-start.integration.test.ts`, `theme-sections.state.test.ts`, `e2e/buyer-journeys.spec.ts`. Tests of the removed helpers are deleted; tests that pinned the removed UI now assert it is absent.

Acceptance tests (run from the repo root; commit 1 is red against unchanged code, commit 2 is green):

- `corepack pnpm exec vitest run --project state apps/web/src/buyer-order-view.state.test.ts apps/web/src/shell-moves.state.test.ts apps/web/src/theme-sections.state.test.ts`: expected after: all pass. Before: the new absent-assertions fail.
- `corepack pnpm exec vitest run --project integration apps/web/src/ops-start.integration.test.ts` and `--project adversarial apps/web/src/shell.adversarial.test.ts`: all pass (Home tabs are `ops-kill`, `ops-alerts`).
- `grep -rnE "order-steps|What happened|Milestones of your order|Steps of your order|Jump to an item|Moved to other tabs|MovedStub|oh-stub" apps/web/src/app` prints nothing.
- `corepack pnpm lint`, `corepack pnpm typecheck`, `corepack pnpm format:check`, `corepack pnpm check:isolation`, `corepack pnpm check:secrets-names`: exit 0.
- e2e (not part of CI here): `buyer-journeys.spec.ts` B1 asserts `order-steps` count 0, no "What happened", and `report-problem` visible.

Do not: touch the `Timeline` component or its use on publisher pages, the case card, `SectionNav`, or any other screen; add dependencies; change contracts or the composition read (`readBuyerOrder` still returns the timeline; trimming it is a separate task).
Evidence for the PR: red then green output, the acceptance command output, the list of changed tests.
