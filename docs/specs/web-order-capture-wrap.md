# Spec: clean capture rows on the order page Summary (OPS-WRAP-1)

Task: on the operator order page (Operations, Money, an order), the Summary row label "Capture of unt_..." holds a 30-character unit id with no break point. It spills out of the 220 px label column and runs over the capture id beside it.
Package: `apps/web` (styles, tests, spec only) Owner: builder Reviewer: Opus
Branch: `claude/project-thread-u5kw2x` Commit: `fix(web): clean capture rows on the order page (OPS-WRAP-1)`

Who uses this and when: the operator (Vikram) reading the 2 Nov $3.50 sandbox order, and the demo video shot of that page, recorded on 11 Nov.

Goal: each capture row reads "Capture 1", "Capture 2" (short label), and its value shows the capture id with the unit id and amount beside it in muted text, in the wide value column. No label wraps or spills; the right-hand space is used. Without the second factor the capture id stays masked as before. As a safety net, every `.pk-facts` label (`dt`) also gets `min-width: 0; overflow-wrap: anywhere`, as `dd` already has. (Owner review 11 Nov: wrapping the id inside the narrow label column alone was rejected.)

Measured (Chromium, real stylesheets, labels from the 2 Nov order): at 1280 and 900 px both capture labels have `scrollWidth > clientWidth` (they overflow); at 390 px (one column) they fit.

Inputs: `apps/web/src/lib/ops-order-view.ts` (`provider_ids`), the order page, `.pk-facts dt`.
Outputs: `apps/web/src/lib/ops-order-view.ts`; `apps/web/src/lib/ops-order-view.test.ts`; `apps/web/src/app/ops/money/orders/[ref]/page.tsx`; `apps/web/src/app/ops/pk-opshome.css` (`.oh-id-note`); `apps/web/src/app/publisher/publisher.css`; `apps/web/src/ui/theme-css.test.ts`; this spec.

Acceptance tests (in `apps/web`):

- `corepack pnpm exec vitest run --project unit apps/web/src/lib/ops-order-view.test.ts`: labels are `PayPal order n` and `Capture n`; a capture's note is `unit <id>, <amount>`; without the second factor the capture id is `…` and its last four.
- `corepack pnpm exec vitest run --project unit apps/web/src/ui/theme-css.test.ts`: `.pk-facts dt` has `min-width: 0` and `overflow-wrap: anywhere`; all other pins pass unedited.
- Static render (PR evidence): the Summary list with the 2 Nov labels at 1280, 900 and 390 px; every `dt` has `scrollWidth <= clientWidth` and ends left of its `dd`.
- `corepack pnpm lint`, `corepack pnpm typecheck` pass.

Do not: touch any colour token, globals.css, the PayPal locks, safety, transport, approval; add a dependency.
Evidence for the PR: red then green test output; before and after screenshots.
