# Spec: skin system and the Bright Market skin (SKIN-A)

Task: a token-based skin system (`data-skin="market" | "harbour"` on `<html>`, chosen by the `um_skin` cookie, rendered on
the server so the first paint is right), an Appearance control in the footer, and Bright Market (option D) applied to every
existing buyer, publisher and ops screen through tokens and CSS only.
Package: `apps/web` Owner: builder (Sonnet) Reviewer: Opus, one round
Branch: `feat/web-skin-a-system` Commit: `feat(web): <what> (SKIN-A)` Decisions: D-065 items 38 to 41, 47; style spec
`docs/design/ux-review-2026-10-29/05-style-spec.md`; tokens of option D in `docs/design/ui-options/styles-d-e.html`.
Depends on: UX-1A (`feat/web-ux-phase1a`) and LEGAL-A merged (both edit `globals.css` or `layout.tsx`). Common rules: plan
section 2.

Goal: the app looks like Bright Market on load, with no flash, no inline style and no new dependency; a visitor can switch
to Deep Harbour (built in SKIN-B; until then the harbour block holds the current dark tokens) and the choice survives a
reload; both skins meet WCAG 2.2 AA contrast for the listed pairs.

Behaviour:

- `globals.css`: the tokens move under `:root[data-skin='market']` (option D values: `--bg #eef3ff`, `--surface #ffffff`,
  `--surface-2 #e2e9fc`, `--text #0e1633`, `--muted #47527a`, `--line #8793b6`, `--line-soft #d4dcf3`, `--accent #1846e5`,
  `--accent-ink #ffffff`, `--accent-soft #e0e8ff`, `--good #0b7a55`, `--good-soft #d8f4ea`, `--warn #7a4b00`, `--warn-soft
#fcefd2`, `--focus #b35c00`, plus `--bad` and `--bad-soft` from the style spec) and `:root[data-skin='harbour']` (the
  current dark values for now). Each skin is one fixed palette; the `prefers-color-scheme: dark` block is removed (a visitor
  who prefers dark chooses Deep Harbour: flagged in the plan). Display font stack from option D (system fonts only). The old
  class names keep working (`.card`, `.btn`, `.chip-*`, `.banner-*`, `.fit-card`).
- No `data:` URIs and no external images (the CSP falls back to `default-src 'self'`); option D's patterned covers come from
  CSS gradients seeded by the publisher slug hash (style spec "Cover tile hues").
- `layout.tsx` reads `um_skin` with `cookies()` from `next/headers`; any value other than `harbour` renders `market`
  (default, decision 39). The attribute is on `<html>` in the server HTML.
- Appearance control `apps/web/src/ui/AppearanceControl.tsx` (client) in the footer: a labelled radio group "Appearance:
  Bright Market, Deep Harbour", which posts to `POST /api/appearance` (`withRoute`, auth public, CSRF Origin check, rate 30
  per minute per ip, body `{ skin: 'market' | 'harbour' }` strict, max 64 bytes). The route sets `um_skin` (Path=/, SameSite=Lax,
  Secure, HttpOnly, Max-Age 180 days, no other data) and the client reloads. It works signed out. Copy in
  `apps/web/src/lib/appearance-copy.ts`.
- Money-path pages (`approve`, `checkout`, `orders`, `receipts`, `cancel`) get tokens only: no markup change.

Tests first: `apps/web/src/ui/contrast.test.ts` reads `globals.css`, extracts both skins' tokens and asserts with the WCAG
formula: text on bg and surface 7:1; muted on bg, surface and surface-2 4.5:1; accent-ink on accent 4.5:1; accent on surface
4.5:1 (links); good, warn, bad on their soft tokens and on surface 4.5:1; line on surface and bg 3:1; focus on bg and surface
3:1. A failing token is changed minimally and listed in the hand-back. `apps/web/src/skin.state.test.ts` (layout source
reads the cookie and defaults to market; the route sets the cookie, refuses a third value, refuses a cross-origin POST;
no `style=` in any `.tsx` under `src/app` and `src/ui`); `apps/web/src/skin-tokens.golden.test.ts` (golden of the token
table per skin, `apps/web/src/golden/skin-tokens.golden.txt`).

Acceptance: `corepack pnpm test:unit apps/web`, `corepack pnpm test:state apps/web`, `corepack pnpm test:golden apps/web`,
`corepack pnpm check:routes`, plan section 3; if the e2e suite runs offline, `corepack pnpm test:e2e` too (every
`data-testid` listed in the style spec section 4 kept).
Do not: add motion (SKIN-B); change copy, markup of money-path pages or any domain code; add fonts, images or scripts; use
`localStorage`; animate anything.
Evidence: outputs, red run, the contrast table (pair, ratio) for both skins, screenshots of find, approve, library and ops at
400 and 1280 px in market if a browser runs, cost line.
