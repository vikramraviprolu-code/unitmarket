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

## POB-Q2: chunks of 100 from one address (owner decision, 10 Nov 2026: auto-continue in chunks of 100)

- One address may list up to `MAX_SOURCE_ITEMS` = 1000 items (the extractor and feed caps move from 100 to 1000).
  Over 1000 the batch still stages nothing (`too_many_items`).
- A source of 100 items or fewer runs exactly as before (known items counted as existing).
- A larger source runs in chunk mode: items this publisher already has are skipped and never fetched again; at most
  `MAX_BATCH_ITEMS` = 100 new items are staged; when more remain, the batch ends `done` with the note `continues` and,
  in the same transaction, queues the next batch for the same address (audit `import.continued`). A batch stopped
  by the 120 second deadline queues the next batch too. The chain only goes on when the batch wrote at least one
  item, so it cannot loop. In chunk mode the "changed" count is not computed for items already known.
- The review returns `source_batches` (every batch of the same address) and `source_busy`. One price for all takes
  `all_from_source` (refused with `batch_not_ready` while a part is still at work); Publish publishes every part, one
  part per call.
- Tests changed because they contradict the owner's decision: the "more than 100 is refused" tests of the extractor,
  the feed parser and the batch now use 1001 items.
- Acceptance: `corepack pnpm vitest run domain/catalogue/src/import-chunks.state.test.ts`: 7 passed.

## Not in this lane (named so nobody thinks it is done)

- Pictures over 2 MB, or on a CDN host. Unchanged.
- Storage: 1000 pictures of up to 2 MB each is up to 2 GB in the content table. A bucket is the later design.
- Account steps before the import (invite code, claim, terms, PayPal link). Unchanged.
