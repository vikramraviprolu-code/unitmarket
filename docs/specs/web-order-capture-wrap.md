# Spec: long capture labels wrap inside their own column on the order page (OPS-WRAP-1)

Task: on the operator order page (Operations, Money, an order), the Summary row label "Capture of unt_..." holds a 30-character unit id with no break point. It spills out of the 220 px label column and runs over the capture id beside it.
Package: `apps/web` (styles, tests, spec only) Owner: builder Reviewer: Opus
Branch: `claude/project-thread-u5kw2x` Commit: `fix(web): long fact labels wrap in their column (OPS-WRAP-1)`

Who uses this and when: the operator (Vikram) reading the 2 Nov $3.50 sandbox order, and the demo video shot of that page, recorded on 11 Nov.

Goal: every `.pk-facts` label (`dt`) stays inside its own grid column at every width, the same way the values (`dd`) already do (`min-width: 0; overflow-wrap: anywhere`). The full unit id stays visible (no ellipsis, nothing hidden); it breaks onto a second line where needed. Values, the grid, the narrow-screen layout and the view model are unchanged.

Measured (Chromium, real stylesheets, labels from the 2 Nov order): at 1280 and 900 px both capture labels have `scrollWidth > clientWidth` (they overflow); at 390 px (one column) they fit.

Inputs: `apps/web/src/app/publisher/publisher.css` (`.pk-facts dt`).
Outputs: `apps/web/src/app/publisher/publisher.css`; `apps/web/src/ui/theme-css.test.ts`; this spec.

Acceptance tests (in `apps/web`):

- `corepack pnpm exec vitest run src/ui/theme-css.test.ts`: `.pk-facts dt` has `min-width: 0` and `overflow-wrap: anywhere`; all other pins pass unedited.
- Static render (PR evidence): the Summary list with the 2 Nov labels at 1280, 900 and 390 px; every `dt` has `scrollWidth <= clientWidth` and ends left of its `dd`.
- `corepack pnpm lint`, `corepack pnpm typecheck` pass.

Do not: touch the view model, the page, any colour token, globals.css, the PayPal locks, safety, transport, approval; add a dependency.
Evidence for the PR: red then green test output; before and after screenshots.
