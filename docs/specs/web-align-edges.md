# Spec: header, page and footer share one content edge; the account cards share one width (WEB-POLISH-3)

Task: at 1200 px and wider the header content is 1120 px wide but `main` and the footer stay at 880 px, so the brand starts about 120 px left of the page content; on /account the three blocks are 640, 560 and 640 px wide.
Package: `apps/web` (styles, tests, evidence only) Owner: builder (Sonnet) Reviewer: Opus
Branch: `feat/web-polish-align` Commit: `feat(web): <what> (WEB-POLISH-3)`

Goal: from 560 px up the header content, `main` and the footer have the same left and right edge at every width, in both skins; the three blocks on /account (heading card, password form, sign out everywhere) have the same left edge and the same width. Nothing else is redesigned.

Inputs: `apps/web/src/app/globals.css`, `apps/web/src/app/auth.css`, `apps/web/src/app/account/*` (read only).
Outputs: `globals.css` (one `--page-max` token, shared by `.site-header .inner`, `main`, `.site-footer`: 880 px, 1120 px from 1200 px up, same horizontal padding); `auth.css` (`.auth-form` loses its own 560 px cap, so it takes the 640 px of `.auth-wrap` like the cards); pins in `src/ui/ux-phase1a-addendum.test.ts` and `src/ui/theme-css.test.ts`; `e2e/edges.spec.ts`; `docs/evidence/align-edges-2026-11-02/*.png`.

Design:

- Below 1200 px the page and the header stay 880 px (the two-row header already fits); from 1200 px both are 1120 px. One token, one place.
- Long text keeps its own narrower caps (`.auth-wrap` 640 px, `.auth-wrap-wide` 820 px, `.lede` 60ch, `.reader` 70ch, `.search-pill` 640 px). Those wrappers have no auto margin, so a narrower card stays on the left edge of the column.
- The footer Appearance box keeps filling the column (it is page chrome, not one of the cards).
- Colours, tokens (skin-tokens golden, contrast test), PayPal locks, safety, transport: untouched.

Acceptance tests:

- Red first: `corepack pnpm --filter @umsbx/web build && cd apps/web && corepack pnpm exec playwright test e2e/edges.spec.ts` fails at 1200 px and wider (brand left of main) and on /account (widths 640/560/640).
- Green after: same command passes at widths 600, 700, 900, 1100, 1199, 1200, 1280, 1440, 1600 in market and harbour: brand left edge equals main content left edge within 1 px; header items do not extend past main's right edge; on /account the three cards have equal left edge and width within 1 px.
- `corepack pnpm test:unit` and `corepack pnpm test:golden` pass; `skin-tokens.golden.txt` and `contrast.test.ts` unedited.
- `corepack pnpm test:e2e` all green (91 existing plus the new ones).

Do not: change colours or tokens; touch other packages, the PayPal locks, safety, transport; add a dependency.
Evidence for the PR: red then green output; PNGs of /account, /signup, /seller, ops at 1280 and 1440 (market, buyer-a), /account at 700 in harbour.
