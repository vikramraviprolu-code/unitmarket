# Spec: Bright Market and Deep Harbour on every screen, and section tabs on long pages (WEB-THEME)

Task: every screen follows one of the two skins in full, the Appearance switch is easy to reach, and the long publisher, buyer and legal pages get SectionNav tabs.
Package: `apps/web` (styles, shared UI, publisher pages, buyer pages, legal pages, layout) Owner: builder (Sonnet) Reviewer: Opus
Branch: `feat/web-theme-sections` Commit: `feat(web): <what> (WEB-THEME)` Decisions: SKIN-A and SKIN-B (D-038 to D-041); owner feedback 31 Oct: "Bright Market or Deep Harbour for everything", "tabs for long scrolls".

Goal: a person who opens any page in either skin sees the same visual language: the skin's display font, page atmosphere, radius, shadow, chip, tile and button styles. Today the publisher and operator pages use a plainer kit (`pk-*` classes) that reads as one flat blue and white scheme. After this task they carry the skin's character (Bright Market: bright, rounded, warm accents; Deep Harbour: dark teal, serif display, amber light). Colours come from tokens only.

Behaviour:

- Audit with Playwright (pre-installed, `require('playwright')`): screenshot every route listed below in BOTH skins at 1280 and 400 px wide, as a signed-in actor where needed (test personas, demo passcode). List what is off (hard-coded colours, text that fails contrast in Deep Harbour, white boxes on a dark page, plain headings). Put the before and after contact sheets in `docs/evidence/theme-2026-10-31/` (PNG, small).
- Routes: `/discover`, `/o/<publisher>/<offer>`, `/library`, `/library/<id>`, `/orders/<ref>`, `/checkout/*`, `/help/*`, `/legal/*`, `/publisher`, `/publisher/offers`, `/publisher/offers/new`, `/publisher/offers/<id>`, `/publisher/sales`, `/publisher/statement`, `/publisher/payout-account`, `/ops`, `/ops/publishers`, `/ops/payee-requests`, `/ops/evals`, `/apply`, `/apply/status`, error and not-found pages. (The landing page, `/signin*`, `/signup`, `/buyer`, `/seller`, `/account` are built by another lane: do not edit them; their CSS file is `auth.css`.)
- Fix by editing `globals.css`, `skin-harbour.css`, `motion.css`, `publisher/publisher.css`, `publisher/pk-*.css`, `ops/pk-*.css`, `ui/publisher/kit.tsx` and the page markup under `publisher/`, `library/`, `o/`, `discover/`, `legal/`, `help/`. Replace any literal colour with a token. Give the kit components (Chip, StatTile, ActionCard, PageHeader, Section) the skin's display font, radius and shadow. Keep every contrast pin in `ui/contrast.test.ts` green and update `golden/skin-tokens.golden.txt` only if a token changes (say so).
- Appearance: the switch between the two skins is also in the site header on every page (compact, 44px target, a labelled control, keyboard reachable), not only in the footer. It keeps working with scripts off (form post). Both skins must be one click away.
- Tabs: add `SectionNav` (`apps/web/src/ui/SectionNav.tsx`, in main; the owner of its look is this lane, you may edit `section-nav.css`) to `/publisher` (Home), `/publisher/offers` , `/publisher/sales`, `/publisher/statement`, `/publisher/payout-account`, `/publisher/offers/<id>`, `/library`, each `/legal/*` page (a section per heading) and `/help/*` where the page is longer than two screens at 1280 px. Give each target section an `id`. Do NOT touch `/ops/*` (another lane adds tabs there).
- Header is sticky on scroll if it is not already, with the SectionNav stuck directly below it (no overlap: check `scroll-padding-top`).

Acceptance tests (each prints green; red first where a test fits):

- `corepack pnpm test:unit apps/web/src/ui` (contrast pins for both skins, no literal colours outside the two token blocks: add a test that scans `app/**/*.css` and `ui/**/*.css` for `#hex` or `rgb(` outside the token blocks, with a small allow list that you justify in the test)
- `corepack pnpm test:state apps/web` (every page above renders in both skins with the header switch; SectionNav present with matching ids on the listed pages)
- `corepack pnpm test:golden apps/web`
- `corepack pnpm --filter @umsbx/web build` then `corepack pnpm exec playwright test` for the existing e2e files you touch (57 tests must still pass; if a test pins copy you changed, change only that test and say so)
- lint, typecheck, `format:check`, `check:isolation`, `check:no-live-host`, `check:secrets-names`

Do not: change copy of legal or money text, the landing or sign-in pages, anything under `api/`, `/ops/*` markup (styles are yours, markup is not), payments, PayPal, config; add a dependency, font file, image or `url()` (CSP is `default-src 'self'`); add a migration.
Evidence: contact sheets before and after in both skins, test output, list of fixed violations.
