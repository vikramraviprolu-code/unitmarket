Task: redesign the publisher offers list as filter tabs and a grid of offer cards (PUB-UI-OFFERS)
Package: apps/web Owner: coordinator Reviewer: Opus review
Goal: `/publisher/offers` shows a page header (title, environment label, primary Create an offer button), filter
tabs as links (`?status=all|on_sale|draft|withdrawn`, counts in each label, `aria-current` on the active one),
and a responsive grid of cards: cover with initials, title, abstract clamped to 3 lines, status chip, one price
chip per option, one muted facts line, one Edit button whose accessible name is still "Change <title>".
Filtering is server side on the rows the engine already returns; order is unchanged (by title). No data, money,
approval or API change.
Inputs: `engine.offers.list(actor)`; copy in `lib/offer-copy.ts`; kit `ui/publisher/kit.tsx`.
Outputs: `app/publisher/offers/page.tsx`, `app/publisher/offers/OfferCover.tsx`, `app/publisher/pk-offers.css`,
`lib/offers-view.ts` (+ test), new strings in `lib/offer-copy.ts` and its golden.
Acceptance tests:
- `corepack pnpm exec vitest run apps/web/src/lib/offers-view.test.ts` passes (filter parse, counts, tone, initials).
- `corepack pnpm exec vitest run apps/web/src/offer-copy.golden.test.ts` passes with the new lines.
- `corepack pnpm lint`, `typecheck`, `format:check` pass.
- Kept: testids offer-row, offer-row-abstract, offer-row-facts; link name `Change <title>`; row text
  `Read online: $1.00`, `On sale`; link to `/publisher/offers/new`; "Not recorded" fallback.
Do not: touch publisher.css or globals.css; add dependencies; use inline styles or colour literals.
Evidence for the PR: command output.
Branch: feat/pubui-offers Commit: feat(web): publisher offers cards and filters (PUB-UI-OFFERS)
