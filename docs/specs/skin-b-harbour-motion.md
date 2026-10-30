# Spec: Deep Harbour skin and the shippable motion set (SKIN-B)

Task: the Deep Harbour (option E) tokens in the harbour skin, and the motion techniques the research marks SHIP that fit one
lane, designed for reduced motion, never on amounts and never on the approval step.
Package: `apps/web` Owner: builder (Sonnet) Reviewer: Opus, one round
Branch: `feat/web-skin-b-harbour-motion` Commit: `feat(web): <what> (SKIN-B)` Decisions: D-065 items 38, 43, 47;
`docs/design/motion-research-2026-10-30.md`; reference `docs/design/ui-options/styles-d-e-motion.html`. Depends on: SKIN-A.
The in-app reader is a separate lane, READER-A (`reader-a-view.md`). Common rules: plan section 2.

Goal: switching to Deep Harbour gives the option E look; both skins gain motion that explains state; a visitor who prefers
reduced motion sees the same states with gentler or no movement; no price, total, fee or pay control ever moves.

In scope (research verdict SHIP):

- Harbour tokens under `:root[data-skin='harbour']` from option E (`--bg #0b2233`, `--surface #11344a`, `--surface-2
#174259`, `--text #f2f6f8`, `--muted #a9c1cd`, `--line #6b90a3`, `--line-soft #23516b`, `--accent #ffb347`, `--accent-ink
#241400`, `--accent-soft #3a3a2e`, `--good #7fe0b0`, `--good-soft #14423a`, `--warn #ffd089`, `--warn-soft #3b3320`,
  `--focus #ffb347`, serif display stack), passing the SKIN-A contrast test unchanged.
- T4 harbour scene: an inline SVG (no `data:` URI, no text on moving parts) on the home and find hero only, harbour skin
  only; waves move with CSS transforms; paused while offscreen or the tab is hidden (`IntersectionObserver`,
  `visibilitychange`, in one client component `apps/web/src/ui/HarbourScene.tsx`); a still drawing under reduced motion.
- T10 skeleton shimmer in `ui/Loading.tsx`, only while a request is pending; no pulse under reduced motion.
- T3 staggered reveal of the discover results list, total delay capped at 240 ms, opacity and transform only.
- T9 view transitions with fallback, 250 ms at most; no price or pay button named as a shared element.
- T12 success check on ready rows, CSS only on existing status attributes (no markup change on money-path pages), driven by
  the stored status already in the page.
  Out of scope, listed as follow-ups: T2 card to tray, T5 route pulses, T6 confetti, T7 count-up, T8 cover flip; T1 and T11 are
  preview only and never ship.

Rules (from research part 3): every `animation` and `transition` rule sits inside `@media (prefers-reduced-motion:
no-preference)` or has a reduced equivalent that keeps colour, shape and text; animate `transform` and `opacity` only; ease
`cubic-bezier(0.16, 1, 0.3, 1)`; no bounce; `will-change` only while animating; no inline `style` attributes (dynamic values
through `el.style.setProperty` or the Web Animations API from client code); no `Math.random`, `Date.now` or
`performance.now` (lint); the approval page is still: `body:has([data-testid="approve-block"])` turns every animation and
transition off, with no markup change there.

Tests first: `apps/web/src/motion.test.ts` reads `globals.css` and the client components as text and asserts: each
`@keyframes` use and each `transition` is inside a no-preference block or paired with a reduce rule; no animated selector
names a price, amount, total, fee, `approve`, `checkout` or `quote-price` class or test id; durations 250 ms or less except
the hero loop and the T12 check (800 ms or less); no `left`, `top`, `width` or `height` in any transition list; the approve
still rule exists. `apps/web/src/skin-tokens.golden.test.ts` golden updated for harbour (say so: the spec changes it).

Acceptance: `corepack pnpm test:unit apps/web`, `corepack pnpm test:state apps/web`, `corepack pnpm test:golden apps/web`,
plan section 3; `corepack pnpm test:e2e` if it runs offline.
Do not: change markup or copy on money-path pages; add a dependency, font, image or external script; animate any money
figure or the approval step; build the out-of-scope techniques.
Evidence: outputs, red run, a short screen recording or two screenshots per skin with reduced motion on and off if a
browser runs, the follow-up list, cost line.
