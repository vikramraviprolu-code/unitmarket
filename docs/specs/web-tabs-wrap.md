# Spec: the section tabs wrap instead of scrolling sideways (WEB-POLISH-4)

Task: the tab bar on long pages (Operations: Switches, Kill switch, Approval gate, ...) scrolls sideways, so tabs are hidden until the owner scrolls right.
Package: `apps/web` (styles, tests, evidence only) Owner: builder (Sonnet) Reviewer: Opus
Branch: `feat/web-polish-tabs` Commit: `feat(web): section tabs wrap, no sideways scroll (WEB-POLISH-4)`

Goal: every tab is visible at once, at every width from 320 to 1600 px, in both skins. The pills wrap onto as many rows as they need; the bar has no `overflow-x` and no scrollbar. Targets stay 44 px, focus outline, plain anchors (no script) and the `#id` jump are unchanged. SectionNav has no active-tab or scroll-spy state, so there is none to keep.

Measured (Chromium, real 848 px content column, current CSS): Operations needs 1003 px on one row; publishers 485, payee requests 350, evals 496; legal pages 1155 (refunds), 1532 (terms), 1701 (privacy), 2801 (publisher terms); library, publisher offers and statement have one tab per item, so they have no upper bound. The column is capped at 880 px, so there is NO width at which every page fits on one row. Rule from the owner ("sticky only where every page's set fits one row") therefore gives: the bar is static (not sticky) at every width. No breakpoint is invented.

Because the bar no longer sticks, `html { scroll-padding-top }` only has to clear the sticky site header: `calc(var(--header-h) + var(--space))` (0 + gutter on a phone, where the header scrolls away). No new fixed number.

Inputs: `src/ui/section-nav.css`, `--header-h` (globals.css, read only; lane WEB-POLISH-3 owns that file and `auth.css`).
Outputs: `src/ui/section-nav.css`; `src/ui/theme-css.test.ts` (pin that said "sticks" and "clears both bars"); `e2e/zb-section-tabs.spec.ts`; `docs/evidence/tabs-wrap-2026-11-02/*.png`.

Acceptance tests (in `apps/web`, after `corepack pnpm --filter @umsbx/web build`):

- `corepack pnpm exec vitest run src/ui/theme-css.test.ts`: `.section-nav` has `flex-wrap: wrap`, no `overflow-x`, not sticky; `scroll-padding-top` uses `var(--header-h)`.
- `corepack pnpm exec playwright test --workers=1 e2e/zb-section-tabs.spec.ts`: widths 320, 360, 560, 700, 900, 1100, 1280, 1440, 1600, skins market and harbour, on Operations (signed in as operator), Terms and Publisher terms: bar `scrollWidth <= clientWidth`; every pill inside the bar and the viewport; no two pills overlap; every pill at least 44 px tall; computed position `static`.
- Same file: clicking a tab lands with the target below the sticky header and inside the viewport, at 360 and 1280.
- `src/ui/contrast.test.ts` and `corepack pnpm test:golden` pass unedited.

Do not: touch `globals.css` or `auth.css`, any colour token, the PayPal locks, safety, transport, approval; add a dependency.
Evidence for the PR: red then green output; PNGs of the Operations tab bar at 360, 700, 1280 in both skins.
