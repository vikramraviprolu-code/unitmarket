Task: make the live site's access-window wording, legal wording, prices and two operator layouts consistent before judging
Package: apps/web Owner: Vikram Reviewer: Opus gate
Who uses this, and when: hackathon judges and Vikram's reviewers on https://unitmarket.live, from 11 Nov until judging ends.

Goal: every buyer-facing sentence about how long access lasts agrees with what the engine sells. New sales resolve
`access.window` to max(access 5, refund 7) = 7 days (D-096 (1), `domain/rules/src/resolve.ts`), and the web layer
already has that value as `DEFAULT_ACCESS_DAYS` in `apps/web/src/lib/format.ts`. Hard-coded "five days" text goes.
The buyer home countdown uses the same words as the library ("4 days 3 hours left"), not a rounded-up day count.
The library meter scales to the window's own length, not a fixed 5. The four legal pages read as final terms for a
sandbox demo, not drafts. Signed-out visitors see prices led in USD ("about $X", stored rate only, no fetch) with the
seller's own amount kept as binding. The operator order page's summary list keeps a two-column grid with long
"Capture of <unit>" labels, and the phone tab bar wraps labels instead of cutting them.

Inputs: `packages/contracts` RULES_REGISTRY (read only), `apps/web/src/lib/*`, `apps/web/src/app/page.tsx`,
`apps/web/src/server/buyer-display.ts`, `apps/web/src/composition/buyer.ts`, the order page, the CSS files below.

Outputs (only these files, plus their tests and golden files):
- `apps/web/src/app/page.tsx` (hero line from DEFAULT_ACCESS_DAYS; anonymous USD lead)
- `apps/web/src/lib/legal-copy.ts` (days from DEFAULT_ACCESS_DAYS; final, sandbox-only intro on all four docs)
- `apps/web/src/lib/buyer-copy.ts`, `apps/web/src/lib/account-copy.ts` (days from DEFAULT_ACCESS_DAYS)
- `apps/web/src/lib/buyer-home-view.ts`, `apps/web/src/composition/buyer.ts` (countdown from ends_at, library words)
- `apps/web/src/ui/WindowMeter.tsx` (total from started_at and ends_at when given, else DEFAULT_ACCESS_DAYS)
- `apps/web/src/server/buyer-display.ts` (non-buyer: target USD, stored rates, `refresh` forced false)
- `apps/web/src/app/ops/money/orders/[ref]/page.tsx` (Fragment instead of `<div>` inside `dl.pk-facts`)
- `apps/web/src/ui/shell/shell.css` (phone bar labels wrap to two lines, no ellipsis)

Acceptance tests:
1. `grep -rniE "five days|5 days of access" apps/web/src --include=*.ts --include=*.tsx | grep -v test` prints nothing.
2. `grep -rn "may change before the demo" apps/web/src | grep -v test` prints nothing.
3. `corepack pnpm vitest run apps/web/src/legal-copy.golden.test.ts apps/web/src/buyer-home-view` and the new tests pass;
   one asserts a home reading row with 4 days 3 hours left says "4 days 3 hours left.", another that the hero and
   terms text contain `${DEFAULT_ACCESS_DAYS} days`, another that a null actor gets target USD and no rate refresh.
4. A render test of the order page summary shows no `<div>` child inside `dl.pk-facts`.
5. `corepack pnpm lint && corepack pnpm typecheck && corepack pnpm test` green (known flakes noted, not edited).

Do not: touch other packages; change contracts, rules, migrations or stored data; add dependencies; call any network;
claim the search is AI.
Evidence for the PR: red run, green run, full suite summary, grep outputs 1 and 2.
Branch: claude/project-thread-7zaf37 Commit: fix(web): judge-ready copy and layout (JR-1)
