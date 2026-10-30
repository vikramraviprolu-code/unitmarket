# Spec: screens Phase 1A, the safe quick wins (UX review, owner go on 30 Oct 2026)

Task: four fixes from the UX review that change copy and CSS only on non-money pages: the library time
contradiction, the stray focus ring, the terms shown where they are accepted, and the fit card at mid widths.
Package: `apps/web` Owner: builder (Sonnet) Reviewer: Opus, one round (D-048); the coordinator merges.
Branch: `feat/web-ux-phase1a` Commit: `feat(web): <what> (UX-1A)` Decisions: D-051 (wording rules stay).
Detail source (read only, may help): `/tmp/claude-0/-home-user/e5712637-4fe0-5e9e-992f-655f773ad1bf/scratchpad/ux-review/`
files `02-problems.md`, `03-proposals.md`, `04-plan.md`, `05-style-spec.md`.

Goal: the four problems below are gone, with tests, and no money-path page changes its markup or its words.

Requirements (tests first, commit 1 holds only tests and is run red; then implement to green):

1. U1, library card (`ui/WindowMeter.tsx`): the card shows one statement of the time left. Remove the bold
   "N days left" line that contradicts "Ready, 4 days 23 hours left" (one rounds up, one rounds down). Keep
   "Access until <date>" or "Download until <date>" and the meter. Keep every `data-testid` (`library-item`,
   `library-status`, `window-meter`).
2. U2, focus (`app/globals.css`): add `main:focus { outline: none; }`. Keep the 3 px `:focus-visible` outline on controls.
3. U3, terms (`DiscoverForm.tsx`, new `lib/buyer-copy.ts`): under the terms tick add a `<details>` whose summary is
   "What the terms say" and whose text states: personal use only, no redistribution, five days of access starting when
   payment is confirmed, and that the price and terms are held for 15 minutes once the buyer starts to buy. Reuse existing
   wording where it exists. The tick stays unticked by default and its label text is unchanged.
4. U4, fit card (`ui/FitCard.tsx`, `globals.css`): (a) below 760 px the fit rows reflow so no row breaks into one word per
   line; (b) the "not assessed" rows move into a `<details>` named "Why this fit", open state off; the rows that carry a
   real assessment stay visible; (c) the price line reads "$1.20 · Read online" with "5 days to read" (or "5 days to
   download your copy") under it, never "for read online". Do not change the fit band; it comes from `domain/fit`.

Acceptance (run, paste output): `corepack pnpm exec vitest run --maxWorkers=2 apps/web`; `corepack pnpm test:state`;
`corepack pnpm test:golden`; `corepack pnpm lint`; `corepack pnpm format:check`; `corepack pnpm typecheck`;
`corepack pnpm check:isolation`; `corepack pnpm check:secrets-names`; `corepack pnpm check:no-live-host`. If the Playwright
end-to-end suite can run in your sandbox without a network, run `corepack pnpm test:e2e` too; otherwise say so.

Do not: change the markup or wording of `approve`, `checkout`, `orders`, `receipts` or `cancel` pages; touch domain, contracts
or packages; add a dependency; use inline `style` attributes (the CSP forbids them); contact any network or PayPal; read a real
secret or any `.env.local`; run `pkill`; run a suite without `--maxWorkers=2`; edit an existing test except where it pins a
string this spec changes (name each in your hand-back).
Disk: about 2.5 GB free; run `df -h /home` before heavy steps and stop under 400 MB; remove only your own temp folders.
Evidence: commands with output, the list of tests you changed and why, screenshots of the library card and the fit card at
1280 and 400 px if you can take them with the pre-installed Chromium, and a cost line.

## Addendum (30 Oct 2026): buyer fixes, owner decisions 42, 45, 46, 50, 53, 54 (lane L1)

Lane L1 finishes the four fixes above and adds five more. The Do-not list above is lifted only for the
`receipts` page and the receipt JSON (item 45 and 54); `approve`, `checkout`, `orders`, `cancel` stay as they are.
Detail: the domain receipt (hashed, stored) is not changed. A web-layer view `lib/receipt-view.ts` builds the buyer
receipt from it, and `Engine.buyerReceipt` fills titles and publisher names from `articles` and `publishers`.

5. Item 45: the receipt page and `GET /api/receipts/[order]` show, per line, the article title and the publisher
   name (no article id column). `engine.receipt` (domain shape) stays for other callers.
6. Item 46: when search finds no match, the page lists every current authorised offer ("Browse all articles", each a
   link to its offer page) and the banner links to that list. An empty catalogue says so in words.
7. Item 50: the full terms (personal use, no redistribution, the AI-use line from the offer's stored rights, five days
   from confirmed payment, the 15 minute hold) show in a `<details open>` BEFORE the consent tick, on the search page and
   the offer page. One component (`ui/TermsConsent.tsx`) renders terms then tick, so a tick never exists without its terms;
   the tick is `aria-describedby` the terms. This replaces U3's "closed details under the tick".
8. Item 53: `/ops` order references are shown whole (no slicing, no clipped cell: a scroll wrapper, no wrap
   inside a reference). The library says the time left once (U1); the item page too.
9. Item 54: the buyer receipt JSON has no `payee_merchant_id` and no key or value holding a merchant id, at any depth
   (items and publishers of the snapshot included). Operator views keep the last 4 characters only (unchanged).
   `sha256` and `content_hash` stay as stored; the buyer cannot recompute the hash from the trimmed JSON (noted, not hidden).

Acceptance (add): `corepack pnpm exec vitest run --maxWorkers=2 --project unit apps/web/src/lib apps/web/src/ui` (new
unit tests: receipt-view, terms, browse-all, ops reference); `corepack pnpm test:state` (engine.buyerReceipt titles,
ops reference whole); `corepack pnpm test:adversarial` (buyer receipt payload has no merchant id key or value, another
buyer gets 404); `corepack pnpm test:golden` (buyer receipt key set pinned). Changed existing tests: the U3 test
that wanted a closed `<details>` under the tick (item 50 contradicts it).
