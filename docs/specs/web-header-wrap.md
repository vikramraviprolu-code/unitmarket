# Spec: the signed-in header lays out cleanly from 320 to 1280 px (WEB-POLISH-1)

Task: the header links wrap unevenly inside a fixed-height row and spill out of the band between 550 and 900 px.
Package: `apps/web` (styles, tests, evidence only) Owner: builder (Sonnet) Reviewer: Opus
Branch: `feat/web-polish-r3` Commit: `feat(web): header layout at every width (WEB-POLISH-1)`

Goal: with the longest link set (signed-in buyer: Find articles, My library, Account, Help, Sign out, plus the Appearance switch and the environment label) the header never wraps a link, never overlaps, never overflows its own band, and never scrolls the page sideways, at every width from 320 to 1280 px, in both skins. Measured cause: `.site-header .inner` is capped at 880 px and the one-row content needs about 1030 px, so one row never fits; the two-row layout started only below 600 px and the fixed `height` clipped it.

Inputs: `apps/web/src/app/globals.css`, `apps/web/src/ui/section-nav.css` (reads `--header-h`), `apps/web/src/lib/nav.ts` (read only; buyer is the widest set, operator and publisher have two links plus Sign out).
Outputs: `globals.css` header rules; `src/ui/theme-css.test.ts` (pins); `e2e/header-layout.spec.ts`; `docs/evidence/header-wrap-2026-11-02/*.png`.

Design:

- 1200 px and wider: one row, header inner max width 1120 px, height 64 px.
- 560 to 1199 px: two rows (brand, environment, switch; then the links), exactly 104 px, links never wrap.
- Under 560 px: the header scrolls away with the page (not sticky), `--header-h` is 0, links wrap onto as many lines as they need. No link is ever hidden or scrolled.
- `.inner` uses `min-height: var(--header-h)`, so content can only grow the band. `--header-h` is declared per breakpoint so the sticky SectionNav stays directly under the header.
- Colours and tokens unchanged; links keep 44 px targets and focus outlines.

Acceptance tests:

- `corepack pnpm exec vitest run apps/web/src/ui/theme-css.test.ts` : pins the three `--header-h` declarations, `min-height`, and the 1199 and 559 breakpoints.
- `corepack pnpm --filter @umsbx/web build && corepack pnpm exec playwright test e2e/header-layout.spec.ts` (in `apps/web`): signed in as buyer-a, both skins, widths 320 to 1280: link boxes single-line (under 60 px), no overlaps, all items inside the header box, no page scroll, Sign out centred with its row, header height equals `--header-h` while sticky.
- `corepack pnpm test:golden` and `src/ui/contrast.test.ts` pass unedited.

Do not: change colours or tokens; touch other packages, the PayPal locks, safety, transport; add a dependency.
Evidence for the PR: red then green test output; PNGs for widths 360, 700, 1280 in both skins (saved by the spec under `test-results/`, copied here).
