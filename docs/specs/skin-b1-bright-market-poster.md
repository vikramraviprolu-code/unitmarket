# Spec: Bright Market poster look (SKIN-B1)

Task: finish option D on top of SKIN-A: pattern covers on article cards, a hero with a search pill, a yellow tag, monospace tabular prices.
Package: `apps/web` Owner: builder (Sonnet) Reviewer: Opus
Branch: `feat/skin-b1-bright-market` Commit: `feat(web): <what> (SKIN-B1)`
Source: `docs/design/ui-options/styles-d-e.html` (option D), `docs/design/ux-review-2026-10-29/05-style-spec.md`, assumption 25 (review items M2, M3).
Depends on: SKIN-A merged. Not in scope: motion, the Deep Harbour look (SKIN-B2), the approval page, any money-path component.

Goal: the home, find, results and library screens read as a wall of small posters. Every article card carries a cover whose hue and pattern come from the article's own data (publisher name and title, through `coverHue`), never one generic stripe. The home and find pages open with a hero (pill search). The yellow `--hot` accent appears on tags only. Prices are monospace with tabular figures. Headings use the rounded stack with system fallbacks. Both skins keep their contrast.

Inputs: `apps/web/src/lib/cover.ts` (`coverHue`), `.cover-h0` to `.cover-h5` in `globals.css`, tokens `--header-*`, `--h0b..h5i`.
Outputs:

- `lib/cover.ts`: add `coverSeed(publisher, title)` and `coverInitials(publisher)` (pure).
- `ui/CoverTile.tsx` (decorative, `aria-hidden`, optional tag), `ui/Hero.tsx`, `ui/OfferTile.tsx` (home shelf card).
- `ui/FitCard.tsx`: cover on top, tag from the access option label. `app/discover/DiscoverForm.tsx` and `app/discover/page.tsx`: hero with pill input (`id="need"`, label "What do you need?" kept; `?need=` prefills). `app/page.tsx`: hero and a shelf of tiles. `app/library/page.tsx`: cover on each item.
- `globals.css`: `--hot`, `--hot-ink` in both skins; `--mono`; `.hero`, `.search-pill`, `.cover` extras, `.tag`, `.tile`; `.price` mono; disabled button without opacity.
- Test data: `skin-tokens.golden.txt` gains the two tokens.

Acceptance tests:

- `corepack pnpm test:unit apps/web/src/lib/cover` passes: initials rules, seed stable and hue within 0 to 5.
- `corepack pnpm test:state apps/web/src/skin-b1` passes: `--hot` used only by `.tag`; `.price` uses `var(--mono)` and tabular figures; no `transition`, no `animation` beyond the SKIN-A spinner; no `url(`, `@import`, `@font-face`; no `style=`, no `<em`, `<i>` and no dash characters in the new copy; FitCard, library and home wire CoverTile; hero on home and find.
- `corepack pnpm test:unit apps/web/src/ui/contrast` passes for both skins, now including hot-ink on hot at 4.5:1.
- `corepack pnpm test:golden apps/web/src/skin-tokens` passes with the two new tokens.
- `corepack pnpm lint`, `typecheck`, `format`, `check:isolation`, `check:no-live-host`, `check:secrets-names` pass.
- Screenshots at 1280 and 400 px of find, results, library and sign-in in both skins (no horizontal scroll).

Do not: touch approval, checkout, orders, receipts, cancel markup or components; add motion; add fonts, images, data: URIs or dependencies; use inline styles; animate amounts; use dashes or italics in copy.
Deviation note: `.price` is restyled globally (CSS only), so the offer and approval totals also show monospace; no markup there changes.
Evidence for the PR: red run of commit 1, outputs above, screenshots.
