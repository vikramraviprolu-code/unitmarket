# POB-Q1: bulk photo onboarding, one address and one price for all

Task: a photographer with hundreds of pictures gets from "here is my gallery" to "everything priced and published"
without copying codes between screens or pricing rows one by one.
Package: `domain/catalogue` (import-quick), `apps/web` (two routes, Quick start panel, One price for all panel).
Owner: Vikram. Reviewer: Opus gate. Branch: `claude/project-thread-cjl8m2`. Lane id: POB-Q1.

## Goal

Today the publisher presses Add, copies a code shown once, edits the site, comes back, presses Check, pastes the
address again and presses Start; then every picture without a price is typed one row at a time. After this lane:

1. **One address.** `quickImport` takes the gallery address. For a new site it answers `prove` with the code, a
   ready-made proof file (`/.well-known/unitmarket-verify.txt`, body `<code>\n`) and the meta tag, and fetches
   nothing. The page downloads the file from memory and then asks again every 5 seconds (12 a minute, the route's
   rate limit; it stops after 10 minutes). While the proof is not up the answer is `waiting` and the code is not
   replaced. When the proof is up, the same call verifies the domain and begins the import (`started`, with the
   batch id), and the page opens the review list. A site already proved starts at once. `new_code` replaces the
   code of a pending site.
2. **One price for all.** `setPriceForAll` sets one price on every staged item of a finished batch that has no
   price (or every staged item with `replace_existing`), in one transaction with one audit row
   (`import.price_all`). Hidden, refused and published items are never touched. Publishing stays its own step.

It only composes `requestDomain`, `checkDomain` and `startVerifiedImport`, so every guard holds: one verified
owner per host, only the two fixed proof paths on an unproved host, the proof fetched again at begin, one active
import per publisher, the `web_import_enabled` switch. No migration. No new dependency. No PayPal call.

## Inputs and outputs

- New: `domain/catalogue/src/import-quick.ts`, its state test, `apps/web/src/app/api/publisher/import/quick/route.ts`,
  `.../price-all/route.ts`, `apps/web/src/app/publisher/import/QuickStart.tsx`.
- Changed: `domain/catalogue/src/index.ts` (exports), `apps/web/composition.server.ts` (`webImport.quick`,
  `webImport.priceAll`), `apps/web/src/lib/web-import-copy.ts` (words), the import page (Quick start first; the two
  manual steps under "Do it step by step instead"), `ReviewList.tsx` (One price for all panel).

## Acceptance tests

- `corepack pnpm vitest run domain/catalogue/src/import-quick.state.test.ts`: 24 passed.
- `corepack pnpm vitest run domain/catalogue apps/web/src/web-import.state.test.ts apps/web/src/pob-journey.state.test.ts`: all pass.
- `corepack pnpm typecheck`, `corepack pnpm lint`, `corepack pnpm check:routes`, `corepack pnpm check:openapi`: exit 0.

## Not in this lane (named so nobody thinks it is done)

- More than 100 items per address. A source listing more than 100 items still stages nothing (`too_many_items`);
  the owner's choice between chunked auto-continue and a higher cap is pending.
- Pictures over 2 MB, or on a CDN host. Unchanged.
- Account steps before the import (invite code, claim, terms, PayPal link). Unchanged.
