# 03 Redesign proposals, per screen

Conventions:

- MONEY PATH marks a proposal that touches the approval page, the Step 2 of 2 page, the order page or the receipt. Those need the payments reviewer, and should land before the Mon 2 Nov freeze or wait until after 12 Nov.
- "Copy changes" tables give the file, the current string, the new string and the tests a grep found that pin it. "None found" means a grep of `*.test.ts`, `*.spec.ts` and `*.golden.txt` across `apps/`, `tests/`, `domain/`, `packages/` and `scripts/` found no test for it.
- The visual system (tokens, components) is in 05-style-spec.md. Static mockups are in `mockups/`.
- Every new string goes into a copy helper: `lib/composite-copy.ts` for buyer purchase words, or a new `lib/buyer-copy.ts` for the rest. That way the golden tests can pin them, as the brief asks. Today many page strings are inline in the `.tsx` files; moving them is part of the work.
- Kept as they are, in every proposal: "You pay nothing until you approve at the payment step.", the footer line from `siteFooter(environment)`, the `EnvLabel` from stored data, one button and no redirect on Step 2 of 2, no pre-ticked box, and every D-051 line in `composite-copy.ts`.

---

## 1. Find articles and results (`app/discover/page.tsx`, `DiscoverForm.tsx`)

Mockups: `mockups/results.html`, `mockups/results-1200-light.png`, `mockups/results-400-dark.png`.

```
+--------------------------------------------------------------------------------------+
| UnitMarket  [ Search articles .......................... ][Search]  Library  Help (Sandbox) |  dark header
+--------------------------------------------------------------------------------------+
| 4 articles for "tide table quay walk"                       | YOUR PACK (2)           |
| The cards are advice. You choose.                           | Reading a tide... $0.40 |
| Sort by [Suggested order v]      (Read online) (Download..) | A morning walk... $0.90 |
| +---------------------------------------------------------+ | 2 articles       $1.30  |
| | [ ] I accept the terms of purchase for the article I     | | 2 publishers, so 2      |
| |     choose.   > What the terms say                       | | PayPal payments, one    |
| +---------------------------------------------------------+ | for each publisher.     |
| +------+------------------------------------+-------------+ | [Buy selected together] |
| | HL   | Reading a tide table in ten minutes|  $0.40      | | (lock) You pay nothing  |
| |cover | Harbour Ledger Review (fictional)  | Download and| | until you approve at    |
| |      | [Good fit] Matches 2 of 4 of your  | keep        | | the payment step.       |
| |      |  words · 12 months old             | 5 days to dl| +-------------------------+
| |      | > Why this fit                     |[Choose this ]|   sticky on desktop;
| |      |                                    |[x In your pack]|  sticky bottom bar at 400 px
| +------+------------------------------------+-------------+
```

Layout:

- The search form stays the page's main form, with the label "What do you need?". The header search box appears on every page except `/discover`. This avoids two "Find articles" buttons on one page, which would break `getByRole('button', { name: 'Find articles' })` in `zcomposite.spec.ts:38` and `journeys.spec.ts:33`. The header button is labelled "Search".
- Results are list rows, not a 3-column grid. Each row has a cover tile, a body (title, publisher, fit summary, `<details>` with the five dimensions) and a buy column (price, option, "Choose this article", and an "Add to pack" toggle).
- The pack tray is a new component, `ui/PackTray.tsx`. It is a sticky right rail at 760 px and wider, and a sticky bottom bar below that width. Its state is the existing `picked` array, so nothing new goes to the server.
- Sort and filter work on the client over `result.items`. The sort options are "Suggested order" (the server order; it is not called "best fit", because the order's meaning belongs to the server), "Price: low to high" and "Price: high to low". The filter chips are "Read online" and "Download and keep" (`quote.option`). Leave out filters the data cannot support honestly: no "Newest" (recency is a level plus free text) and no rating.

Copy changes:

| File | Current | New | Tests to update |
| --- | --- | --- | --- |
| `DiscoverForm.tsx:136` | `Articles that fit` | `{n} articles for "{need}"`, or `1 article for "{need}"`. The phrase has no verb, so it meets D-051 for any count. Move it to `buyer-copy.ts` as `resultsHeading(n, need)`. | None found |
| `DiscoverForm.tsx:140` | `I accept the terms of purchase for the article I choose.` | Unchanged. Add a `<details>` under it with the summary `What the terms say` and the body `Personal use only. No redistribution.` + `OPTION_HELP.keep_retrieve` + `OPTION_HELP.online_read` + `The 5 days start when payment is confirmed.` | `journeys.spec.ts:37` and `zcomposite.spec.ts:45` match `/I accept the terms of purchase/` and keep passing |
| `DiscoverForm.tsx:151` | `Select {title} to buy together` | Visible: `Add to pack`, or `In your pack` when ticked. Accessible name: `Add {title} to pack`, using a visually hidden title. | `zcomposite.spec.ts:46-47` find the checkbox by the title regex and keep passing, because the name still contains the title |
| `DiscoverForm.tsx:175-177` | `Select two or more articles to buy them together.` | Unchanged, moved into the tray's empty state with `id="pack-hint"` kept. | `order-pages.state.test.ts:70-80` reads the source: keep the `id="pack-hint"` element in `DiscoverForm.tsx`, or update that test to read `PackTray.tsx` |
| new, tray | (none) | `Your pack`; `{n} articles` (or `1 article`); `{p} publishers, so {p} PayPal payments, one for each publisher.` (or `1 publisher, so 1 PayPal payment.`); `You pay nothing until you approve at the payment step.` | New golden lines in `composite-copy.golden.txt` |
| `DiscoverForm.tsx:130-131` (no match) | `Nothing in the catalogue fits that need and ceiling. We do not stretch the match. Try different words or a higher ceiling.` | Unchanged, plus a section under it with the heading `Browse all articles instead`, listing every offer as a compact row (title, publisher, "from" price) linking to `/o/...`. The page passes `listOffers()` as a prop, as the AI-off branch already does. | None found |
| `FitCard.tsx:53` | `for {option lowercased}` | Two lines: `{OPTION_LABEL}` and a muted `5 days to read`, or `5 days to download` for keep. | None found (`quote-price` is on the offer page, not here) |

States:

- **Loading.** The button reads "Searching" (as today). Three skeleton rows (grey blocks, no shimmer under `prefers-reduced-motion`) carry the polite announcement "Finding articles".
- **Empty.** The no-match banner plus the catalogue fallback, as above.
- **Error.** `ErrorState` "Could not continue" with the message. When the status is 401, add a "Sign in" link (today it is text only).
- **AI off.** The existing banner, with the catalogue rendered as rows like the no-match fallback.
- **Pack refused** (mixed currency or too many publishers). The server text is shown inside the tray, next to the button, not at the top of the results. The text is unchanged: `MIXED_CURRENCY_TEXT` and `TOO_MANY_PUBLISHERS_TEXT`.

Components: `ResultRow` (replaces the grid cell), `CoverTile`, `FitSummary` (the one line built from the topic and recency evidence, falling back to the band only), `FitDetails` (the five rows inside `<details>`), `PackTray`, `SortFilterBar`, `CatalogueList`.

## 2. Article card (`ui/FitCard.tsx` becomes `ResultRow`)

Honesty is kept: the band chip, the levels as words, "not assessed" as words, and no numbers.

The changes:

1. The summary line uses only stored evidence: `Matches {k} of {n} of your words` comes from the topic evidence string ("2 of 4 terms"), followed by ` · {recency evidence}`. If the evidence cannot be parsed, show the evidence text as it is. Never compute a score.
2. The "not assessed" rows move into "Why this fit", so three empty rows no longer dominate the card.
3. The title links to the offer page. The discover item has no slug today, so the route (`api/discover/route.ts`) adds `publisher_slug` and `offer_code` by looking up `offer_id` in `listOffers()`. That is an apps/web change only.
4. A cover tile (see 05). The tile is decorative, `aria-hidden`, and shows the publisher's initials. It says nothing about the content.

Copy: `Why this fit` (new); `Matches {k} of {n} of your words` (new, in `buyer-copy.ts`). Tests: `domain/fit/src/compute.test.ts` pins the "not assessed" wording in the domain; the UI keeps the word, so nothing changes.

## 3. Offer page, product detail (`app/o/[publisher]/[offer]/*`)

```
Harbour Ledger Review (fictional)
Reading a tide table in ten minutes            +------------------------------+
A short guide to the columns of a coastal...   | (o) Download and keep  $0.40 |
                                               |     5 days to download; keep |
[cover tile 120x160]                           | ( ) Read online        $0.40 |
                                               |     5 days to read online    |
What you get                                   | [ Get my price and terms ]   |
- One article, personal use only.              |  > Set a ceiling (optional)  |
- No subscription. Pay once.                   |  > Offer a different price   |
- 5 days of access from when payment is        |------------------------------|
  confirmed.                                   | Your price  $0.40            |
                                               | [ ] I accept the terms ...   |
                                               | [ ] Share my name ... (opt.) |
                                               | [ Review and approve ]       |
                                               +------------------------------+  buy box
```

Copy changes:

| File | Current | New | Tests to update |
| --- | --- | --- | --- |
| `OfferFlow.tsx:167` | `Show my price` | `Get my price and terms` | `e2e/support.ts:44` |
| `OfferFlow.tsx:133` | `Your ceiling ({cur}), optional` | Unchanged, inside a `<details>` with the summary `Set a ceiling (optional)` | `e2e/support.ts:43` uses `getByLabel(/Your ceiling/)`. It still works, but the test must open the `<details>` first; update `support.ts` to click the summary |
| new | (none) | `What you get`, `One article, personal use only.`, `No subscription. Pay once.`, `5 days of access from when payment is confirmed.` | None |

Later, after 12 Nov, with a behaviour change and a payments reviewer: fetch the quote automatically when the option changes, which removes one click.

States: loading ("Checking", as today); no match (the existing `REASON` map, shown inside the buy box); error (`ErrorState` inside the buy box); not signed in (the buy box shows a "Sign in to see your price" link instead of the button).

## 4. Approve your purchase, single item, MONEY PATH (`app/approve/[id]/*`)

Mockup (pack version): `mockups/pack-approval.html`, `mockups/pack-approval-1200-light.png`, `mockups/pack-approval-400-dark.png`.

```
(v) Choose   (2) Review   (3) Approve at PayPal   (4) Read in your library
Approve your purchase
Check the details. You pay nothing until you approve at the payment step.     <- unchanged
+---------------------------------------------+  +--------------------------+
| [HL] Reading a tide table in ten minutes    |  | Order summary            |
|      Harbour Ledger Review (fictional)      |  | 1 article          $0.40 |
|      Download and keep              $0.40   |  | Total              $0.40 |
+---------------------------------------------+  | (clock) 14:20 to approve |
| Terms                                       |  |   this price             |
| Personal use only; 5 days of access ...     |  | [ ] I confirm the price  |
| Price and terms held until 19:14 UTC today  |  |  and terms above, ...    |
+---------------------------------------------+  | [ Continue to payment ]  |
                                                 | (lock) You approve the   |
                                                 | payment on PayPal's own  |
                                                 | page.                    |
                                                 +--------------------------+
```

Copy changes:

| File | Current | New | Tests to update |
| --- | --- | --- | --- |
| `ApproveClient.tsx:118-121` | `This price and these terms are frozen until {ISO}. Personal use only; 5 days of access starting when payment is confirmed.` | Moved into the Terms panel: `Personal use only. 5 days of access starting when payment is confirmed.` and `This price and these terms are held until {formatTime(expires_at)} ({formatDate})`. "Held" is used because "frozen" elsewhere means a PayPal hold (D-051). | None found for "frozen until" |
| new, under the button | (none) | `You approve the payment on PayPal's own page. Nothing is taken on this page.` | New golden line |
| `lib/format.ts:26-28` | `2026-10-29 19:14 UTC` | `29 Oct 2026, 19:14 UTC`. Keep UTC: the server clock is the only clock (no browser time zone). | None found |

Kept word for word: the H1, the lede, the checkbox label (`e2e/support.ts:56`, `zcomposite.spec.ts:57`, `zz-ops-stop.spec.ts`), "Continue to payment", the `Countdown` text and the renewal button (`journeys.spec.ts:137`).

Not proposed for now: removing the second consent checkbox. It repeats the tick on the previous page, but consent is part of the money-path design; see 04-plan, conflicts.

States: already used (the existing banner, which replaces the summary rail's button); expired (the countdown shows "This approval has expired." and the renewal button; the summary rail's button is disabled with `aria-describedby` pointing at that message); error (`ErrorState` inside the rail, above the button, so it sits next to the action).

## 5. Pack approval, MONEY PATH (same page, `view.settlement !== null`)

Same layout as proposal 4, with these differences:

- One panel per publisher block. The heading is `Payment {n} of {m} to {publisher}` only if the block order equals the PayPal order position used by the Step pages. That order is not visible in the view today, so the payments reviewer must confirm it. Otherwise the heading is `Payment to {publisher}` with no number.
- The line items show a cover tile, the title, the option with its help sentence, and the amount. The subtotal row reads `Subtotal for {publisher}`, the same words as today, now laid out as a row.
- In the summary rail, `packNotice(payments)` is shown word for word in an info box above the countdown. The rail lists `{n} articles` and the Total. An optional `UnitMarket fee $0.00` line comes from `platform_fee_minor`, which is the literal 0 in the snapshot schema; it needs the payments reviewer.

Copy:

| File | New | Tests |
| --- | --- | --- |
| `composite-copy.ts` (new) | `paymentHeading(n, m, publisher)` = `Payment {n} of {m} to {publisher}` | New lines in `composite-copy.golden.txt` and `composite.golden.test.ts` |
| `composite-copy.ts` | `packNotice` unchanged | `zcomposite.spec.ts:53` and the golden are unchanged |

States: as in proposal 4. When the price freeze expires, the renewal recreates the whole pack (the existing `um_renew_` path).

## 6. Step 2 of 2, MONEY PATH (`app/checkout/return/page.tsx`, the `next !== null` branch)

```
(v) Choose  (v) Review  (3) Approve at PayPal: 2 of 2  (4) Read
Step 2 of 2: approve your payment to Quayside Gazette (fictional) at PayPal   <- unchanged
+-----------------------------------------------------+
| This payment covers                                 |   only with data (see below)
|  A morning walk along the old quay        $0.90     |
+-----------------------------------------------------+
If you do not approve within 60 minutes, the whole order may be cancelled and nothing is charged.  <- unchanged
[ Approve payment 2 of 2 at PayPal ]          <- one button, no redirect, unchanged
See where your order stands
```

- **Stepper.** CSS and markup only. It shows the four steps, with the third marked "2 of 2" from `next.step` and `next.of`.
- **"This payment covers".** This needs the titles and amount of the waiting PayPal order on `PackStep`, read from stored provider-order rows in composition. That is data on the money path; land it before 2 Nov or after 12 Nov.
- **Rejected copy.** I considered "You approved payment 1 of 2" and rejected it. Step 2 of 2 is also shown after the first payment was declined: the partial journey in `zcomposite.spec.ts:124-136` declines payment 1 and then expects "Step 2 of 2". That sentence would be false.

Copy: `stepHeading`, `stepButton` and `stepDeadline` are unchanged. New: `STEP_COVERS = 'This payment covers'` in `composite-copy.ts`, with a golden line.

## 7. Your order, the order confirmation, MONEY PATH (`app/orders/[ref]/*`)

```
Your order                                         Order placed 29 Oct 2026, 18:52 UTC
+--------------------------------------------------------------------------------+
| (v) A morning walk ... and Reading a tide table ... are ready in your library. |  banner, unchanged text
+--------------------------------------------------------------------------------+
| [QG] A morning walk along the old quay   Quayside Gazette    [Ready in your library]  $0.90 |
| [HL] Reading a tide table in ten minutes Harbour Ledger      [Ready in your library]  $0.40 |
|                                                          Total paid   $1.30   |   only with data
+--------------------------------------------------------------------------------+
What happens next
- Your 5 days start now. Find the articles in your library.
- Your receipt is kept here: View receipt.
[ Open my library ]  [ View receipt ]
```

Changes:

- Lines become rows with a status pill. The text comes from `i.line` (`LINE_TEXT`), unchanged, so `zcomposite.spec.ts:117-150` keeps passing on `data-testid="order-item"` and `hasText`.
- The amount per line and "Total paid" need data. `OrderView` has no amounts today; add `amount_minor` per item from the stored snapshot. For a not-charged line, the amount column shows `Not charged`, using the existing `LINE_TEXT.declined` and `LINE_TEXT.abandoned`, so the D-051 rule still holds. For a held line it shows `On hold` (`LINE_TEXT.hold`). Never show a "paid" total that includes a held or not-charged item: the total is the sum of `ready`, `paid_locked` and `partly_refunded` lines minus refunds, computed on the server.
- "Order placed {date}" needs the order's `created_at` on the view.
- Case line. The current `We opened case {id}. {buyer_message}` becomes: `We opened a case to check this. Case reference: {id}` (reference in mono, small), and `{buyer_message}` is shown only when it differs from the banner. That removes the triple repeat in dp5b-order-held.png.
- "What happens next" is new copy in `buyer-copy.ts`: `Your 5 days start when payment is confirmed and the content is ready.` (the same words as `WindowMeter` "not_started"), and `Your receipt is kept on this page: View receipt.`
- Optional, a behaviour change: "one ready, one not charged" would use the info tone instead of success. This is pinned by `order-status.test.ts:22` and the golden line "pack, one ready, one declined, tone: success". It needs the payments reviewer, so I mark it optional. Success is defensible, because the buyer did get something.

Kept: `buyer_message`, `packBanner` and `orderMessage` text (`payments.state.test.ts`, `journeys.spec.ts`, `refund.spec.ts`), and "Open my library" and "View receipt".

States: waiting (an info banner with polite live updates every 3 s, as today; add a quiet spinner next to the banner title while `keepPolling` is true); frozen (warning tone, the "What does this mean?" link to `/help/frozen`, as today); failed (error tone, plus a new link "Find articles again" to `/discover`).

## 8. Receipt, MONEY PATH display (`app/receipts/[order]/page.tsx`)

```
Receipt  (Sandbox)                                            [ Print or save as PDF ]
Version 1, issued 24 Oct 2026, 15:17 UTC
Sold by UnitMarket on behalf of: Harbour Ledger Review (fictional)
+----------------------------------------------------------------------------+
| Item                                   | Access                  | Amount  |
| What a small harbour charges and why   | Read online, until      |  $2.50  |
| Harbour Ledger Review (fictional)      | 29 Oct 2026, 15:17 UTC  |         |
+----------------------------------------------------------------------------+
                                                          Total    $2.50
Refunds (if any)                                         Refunded  $x.xx
> Fingerprint (SHA-256): keep it to prove the receipt was not changed     <- <details>
[ Open my library ]  [ Problem with this order? ]
```

Changes:

- **Titles.** The page calls `engine.library({ actor })` once and maps `article_id` to `{ title, publisher }`. If an article is not found, it falls back to the id in mono. There is no contract or receipt-hash change: the title is for display, outside the hashed body.
- **Publisher.** For a pack, use `publisher_display_name` from the line when it is present; otherwise use the library lookup.
- **Print.** Add `@media print` CSS (hide header, nav and buttons; black on white) and a small client `PrintButton` that calls `window.print()`. It is CSP-safe: no inline script, and the component is bundled.
- **Fingerprint.** Move it into `<details>`, keeping `data-testid="receipt-sha256"` on the value.
- **"Sold by ... on behalf of".** Only use this if it is legally right for D-041. Every publisher is paid into the owner's account in the sandbox, so I recommend the neutral `Publisher: {name}` per line and no "sold by" line. Flagged for the owner.

Copy: `Print or save as PDF` (new, `buyer-copy.ts`), `Fingerprint (SHA-256)` (the summary of the `<details>`). Tests: no test pins "Fingerprint". The `receipt-version`, `receipt-refunds`, `receipt-refund`, `receipt-refunded-total` and `receipt-sha256` testids are kept (refund e2e and golden).

States: not found (the existing 404); a refunded version (a new version line, `Version 2, issued ...`, plus the Refunds section as today).

## 9. Library, styled like "Your orders" (`app/library/*`)

Mockup: `mockups/library.html`, `mockups/library-1200-dark.png`, `mockups/library-400-light.png`.

```
My library
Everything you bought, with the time you have left.
(All 4) (Ready 2) (Ended or refunded 2)                <- links: ?show=ready etc., aria-current
+------+-------------------------------------------+--------------------+
| QG   | Why the quayside market moved indoors      | [ Read online ]    |
|cover | Quayside Gazette (fictional) · Read online | View receipt       |
|      | [Ready, 4 days 23 hours left]              | Problem with this  |
|      | Access until 3 Nov 2026, 16:50 UTC         | item?              |
|      | [=====------------------]                  |                    |
+------+-------------------------------------------+--------------------+
```

Changes:

- **Rows, not a grid.** The `data-testid="library-item"` and `library-status` testids are kept (`refund.spec.ts:83-87,161-163,277-279`, `journeys.spec.ts:155-156`).
- **Status pill.** The pill text is `i.status_text`, unchanged (pinned in refund e2e: "Refunded: access has ended"). Its tone comes from the window state: running gives good; not started or paused gives info; ended, revoked or refunded gives neutral.
- **WindowMeter.** Drop the bold `{n} days left` line, which is the contradiction in problem 1. Show `Access until {date}` for read online and `Download until {date}. The copy you download is yours to keep.` for keep. The bar stays, with its `aria-label` "x of 5 days used".
- **Order.** Ready items first (least time left first), then not started or paused, then ended or refunded. Sort on the server from the stored window state; no browser clock.
- **Filter tabs.** Server-rendered links (`?show=ready` and `?show=ended`). They need no JavaScript and the `Refresher` keeps working.
- **Per-row links.** `View receipt` uses `i.order_id`, which is already in the entry. `Problem with this item?` goes to `/help/delivery?item=...`.
- **No main focus ring.** CSS: `main:focus { outline: none; }`.

Copy:

| File | Current | New | Tests |
| --- | --- | --- | --- |
| `ui/WindowMeter.tsx:20-21` | `{n} days left until {date}` | `Access until {date}` (read online) or `Download until {date}. The copy you download is yours to keep.` (keep) | None found (`recovery.state.test.ts:142` and `library.state.test.ts:28` pin `status_text`, which does not change) |
| `library/page.tsx` (new lede) | (none) | `Everything you bought, with the time you have left.` | None |
| filter tabs | (none) | `All ({n})`, `Ready ({n})`, `Ended or refunded ({n})` | None |
| `library/page.tsx:24` | `Nothing here yet` | Unchanged. Action `Find an article`, unchanged. | None found |
| `library/[entitlement]/page.tsx:41` | `Evidence` | `Details` | None found |
| `library/[entitlement]/page.tsx:47-48` | `Payment state` with the raw `item.money` | `Payment` with words: `paid`, `refunded`, `pending` and so on, mapped in `buyer-copy.ts`. Unknown values are shown as they are. | Check `refund.spec.ts` for `money`; the grep found none |

The nav keeps the name "My library": "Your library" would need updates in `journeys.spec.ts:101`, `setup.spec.ts:14` and `zcomposite.spec.ts:167,188`, and the gain is small.

States: empty (the existing `EmptyState` with a cover-tile illustration made of three grey tiles, plus the existing action); filtered empty (`Nothing in this view.` with the link `Show all`); open error (the existing `ErrorState` "Could not open", shown under the row button).

## 10. Sign in (`app/signin/*`)

- **Layout.** A centred card, 420 px wide. Above the form, a notice box reads `This is a test build. Pick a test persona and enter the demo passcode.` (the same words as today, moved).
- **Persona field.** The `<select>` stays, because `setup.spec.ts:11` uses `selectOption`.
- **Password field.** Add a "Show" toggle button next to it, named `Show passcode` or `Hide passcode`. It helps paste checks and A11Y-6, with no cognitive test.
- **Disabled button.** It uses the neutral disabled style from 05 instead of opacity.
- **Errors.** Unchanged (`SignInForm.tsx:39-45`).

Copy: `Show passcode` and `Hide passcode` (new). Tests: none pin them. `Demo passcode` is kept (`operator-mfa.spec.ts`, `refund.spec.ts` and others).

## 11. Help (`app/help/*`)

- **Index page.** A new `app/help/page.tsx` titled `Help`, with four rows linking to the topics: `Help with a payment`, `Your order is on hold`, `The content did not open`, `Not charged`. The nav "Help" then points to `/help`. That is a new page and not a route handler, so `check:routes` is not affected.
- **Topic pages.** Each keeps its body. "Ask us to look at this" gains an optional `<textarea>` labelled `What happened? (optional)`, but only if `/api/cases` accepts a note field from the buyer. The route has `note` today but is sent `help:<slug>`, so check the max length with the reviewer.
- **Case confirmation copy.** `We opened a case and will update this page.` becomes `We opened a case. You can see it on your order page.` Use this only where the case is tied to an order (`open_case` on `OrderView`). For a delivery case tied to a library item, use `We opened a case. We will look at it and write to you.` (from `help/frozen`). No test pins the current sentence (grep found it only in source).

## 12. Ops summary (`app/ops/*`)

```
Operations (Sandbox)
+--------------------------------------------------------------------------------+
| (!) PayPal calls: BLOCKED (connect flag off)   Checkout: on   Refunds: on      |  status strip, warn tone
|     Invariants: all hold    Alerts: none    Job loop: last pass 17:07 UTC      |
|                                               [ Go to Stop PayPal calls ]      |  link to the form below
+--------------------------------------------------------------------------------+
Switches            (table: human name | raw name in mono | On/Off pill)
Outbound approval gate   (gateLines unchanged)
Stop PayPal calls        (form unchanged, button styled danger)
Refunds ... Orders ... Operations by state ... Alerts ... Invariants
```

- **Strip tone.** Good when `outbound.open` and all invariants hold. Warn when blocked by a lock that is expected in this mode. Bad when any invariant fails or the Wire self-check reports changed builtins. The state is derived on the server from `snap`, with no new data.
- **Strip text.** Built by a pure function, `opsSummaryLines(snap)` in `lib/ops-summary.ts`, so a golden test can pin it like `gateLines`. `gateLines` itself is unchanged (`tests/mvp-b/unseal-ops.golden.test.ts`).
- **Human switch names.** `paypal_outbound` reads `Outbound PayPal calls`, `checkout_enabled` reads `Checkout`, `refunds_enabled` reads `Refunds`, `unlock_enabled` reads `Unlocking content`, `ai_enabled` reads `Finding articles for a need`, and `webhook_enabled` reads `PayPal webhooks`. The raw name stays in mono for the command line.
- **Stop button.** The strip carries a link `Go to Stop PayPal calls` to `#stop-heading`, where the reason field gets focus. Do not give the link the same name as the button: one name must stay unique to one control. The form's button gets the danger style and keeps its name (`zz-ops-stop.spec.ts`).

States: no MFA (the existing refund note); maintenance (unchanged); every section's empty text unchanged.
