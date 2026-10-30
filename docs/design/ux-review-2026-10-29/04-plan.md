# 04 Phased plan, demo video and conflicts

Dates: today is Thu 29 Oct 2026. The money path freezes on Mon 2 Nov. The team target is Mon 9 Nov, and the official deadline is Thu 12 Nov, 12:00 PT.

Working limits that apply (D-048): at most 90 minutes of builder work per lane, one Opus review round (two at most), one spec, one branch and one PR per lane, and tests first. Every item below is sized to fit one lane or less. "h" means builder hours.

**First decision the owners must make (today).** Does a global CSS theme change count as "touching the money path"? It changes how the approval, step, order and receipt pages look, but not what they say or do. My recommendation: treat token and CSS-only changes as non-money, provided the money-path e2e screenshots (`apps/web/e2e/shots/dp5-*.png`) are re-taken and reviewed in the same PR. Any copy, markup or data change on those pages is money path.

## Phase 1: quick wins, copy and CSS only (Fri 30 Oct, about 1 day, 3 lanes)

| # | Item | Files | Tests touched | h |
| --- | --- | --- | --- | --- |
| Q1 | Remove the contradicting "N days left" line; show "Access until {date}" or "Download until {date}..." | `ui/WindowMeter.tsx` | None found | 0.5 |
| Q2 | Stop the focus ring on `main` | `app/globals.css` (`main:focus { outline: none }`) | None | 0.1 |
| Q3 | "What the terms say" disclosure under the discover terms tick | `DiscoverForm.tsx`, `lib/buyer-copy.ts` (new) | None (`/I accept the terms of purchase/` regex unchanged) | 0.5 |
| Q4 | Fit-row reflow below 760 px; "not assessed" rows into `<details>`; price line "$x · Read online / 5 days to read" | `globals.css`, `ui/FitCard.tsx` | None found | 1 |
| Q5 | Neutral disabled button style; dark header bar; page tokens from 05 | `globals.css` | Re-take the e2e shots | 1 |
| Q6 | Human date format "29 Oct 2026, 19:14 UTC" | `lib/format.ts` | None found. It shows on the approval page, so get the payments reviewer's look (copy only) | 0.3 |
| Q7 | "Get my price and terms"; home "Browse articles"; library item "Details" and payment words | `OfferFlow.tsx`, `page.tsx`, `library/[entitlement]/page.tsx` | `e2e/support.ts:44` | 0.5 |
| Q8 | Ops: danger style for "Stop PayPal now"; human switch names beside the raw names | `ops/page.tsx`, `ops/StopButton.tsx`, `globals.css` | None (the button name is unchanged) | 0.5 |

Expected effect: overall 5 to 6. Problems 1, 2, 3 and 4 are fixed, and the worst screenshot artefacts go away.

## Phase 2a: money-path set, payments reviewer, must merge by Sun 1 Nov (2 lanes)

| # | Item | Files | Tests touched | h | Risk |
| --- | --- | --- | --- | --- | --- |
| P1 | Approval page: summary rail (total, pack notice, countdown, consent, button), terms panel, stepper, per-block panels with `Payment to {publisher}`. "Payment N of M" only if the reviewer confirms the block order matches the PayPal order position. | `approve/[id]/*`, `composite-copy.ts`, `globals.css` | `composite-copy.golden.txt` (new lines); e2e testids `approve-block`, `approve-total`, `pack-notice` kept; re-take dp5-approve.png | 1.5 | Low: no behaviour change |
| P2 | Receipt: titles from the library lookup, publisher per line, print CSS and `PrintButton`, fingerprint in `<details>` | `receipts/[order]/page.tsx`, new `ui/PrintButton.tsx`, `globals.css` | Testids kept; refund e2e unchanged | 1.5 | Low: display only, the hash is unchanged |
| P3 | Order page: rows with status pills; "Case reference" with the deduped case sentence; "What happens next"; stepper on the Step 2 of 2 page | `orders/[ref]/OrderStatus.tsx`, `checkout/return/page.tsx`, `buyer-copy.ts` | `order-item` testid and line text kept; golden gains `STEP_COVERS` only if P4 lands | 1.5 | Low |
| P4 (stretch) | Data: `amount_minor` and the order date on `OrderView`, a covered-items list and amount on `PackStep` | `composition.server.ts` | New state tests (tests first) | 1.5 | Medium: composition is shared, so it needs an Opus review. If it is not merged by Sun 1 Nov, move it to after 12 Nov and keep P3 without amounts. |

## Phase 2b: medium set, non-money (Mon 2 to Wed 4 Nov, 5 lanes)

| # | Item | Files | h |
| --- | --- | --- | --- |
| M1 | Results as list rows, `CoverTile`, `FitSummary`, title link (the discover route adds slug and code from `offer_id`) | `DiscoverForm.tsx`, `ui/ResultRow.tsx`, `ui/CoverTile.tsx`, `api/discover/route.ts` | 1.5 |
| M2 | `PackTray` (sticky rail or bottom bar) plus client sort and filter | `ui/PackTray.tsx`, `ui/SortFilterBar.tsx`, `DiscoverForm.tsx`. Update `order-pages.state.test.ts:70-80` only if the hint element moves (list it in the spec as an allowed test edit) | 1.5 |
| M3 | No-match and AI-off catalogue fallback list | `discover/page.tsx`, `DiscoverForm.tsx`, `ui/CatalogueList.tsx` | 0.75 |
| M4 | Library rows, server-side sort, filter tabs (`?show=`), per-row receipt link | `library/page.tsx`, `globals.css` | 1 |
| M5 | Offer page buy box (layout only, ceiling in `<details>`) | `o/[publisher]/[offer]/*` plus `e2e/support.ts` (open the details) | 1 |
| M6 | Ops status strip (`lib/ops-summary.ts` plus a golden test) | `ops/page.tsx`, `lib/ops-summary.ts` | 1 |
| M7 | Help index page; header search box on pages other than `/discover` | `app/help/page.tsx`, `layout.tsx` | 0.75 |

Expected effect: overall 7.5, and 8 on the demo-path screens.

## Phase 3: hardening and demo (Thu 5 to Sun 8 Nov)

- An axe scan and the A11Y-1 keyboard run over: ask, pack, approve, return, read, at 400 px in both themes.
- Re-take every e2e shot.
- Freeze the UI on Sat 7 Nov. Record the video on Sun 8 Nov, with Mon 9 Nov as the fallback.
- No new features in this phase.

## Beyond the theme: what else 8 or 9 needs, ranked by effort

| Need | Effort | By 9 Nov? | Where |
| --- | --- | --- | --- |
| Correct, non-contradicting numbers and dates | Hours | Yes | Q1, Q6 |
| Terms visible at the moment of consent | Hours | Yes | Q3 |
| Sort and filter over results | Under 1 day | Yes (client side) | M2 |
| A pack tray with a running total and payment count | Under 1 day | Yes | M2 |
| Mobile-first result rows and a sticky action | Under 1 day | Yes | M1, M2 |
| Loading skeletons and empty and error states with a way forward | Under 1 day | Yes | M1, M3 |
| A readable receipt with print | Under 1 day | Yes, if it merges by Sun 1 Nov | P2 |
| A checkout summary rail and stepper | Under 1 day | Yes, if it merges by Sun 1 Nov | P1, P3 |
| Order confirmation with amounts and date | 1 day plus review | Stretch | P4 |
| Detail-page buy box | Under 1 day | Yes | M5 |
| Fewer clicks: auto-quote on option change | 1 day plus money review | No, after 12 Nov | |
| One consent instead of two | Contract change on approvals | No, after 12 Nov | |
| A "Your orders" history grouped by order, with dates | 1 to 2 days with new views | No, after 12 Nov | |
| Real cover art and content previews from publishers | Needs publisher assets and rights | No | |
| A larger catalogue (so search, filter and sort matter) | Content work | No | |
| Live search as you type, and a performance pass | 1 to 2 days | No | |
| Five-user usability test and a round of fixes | 2 days | No | |

The last six rows are why 9 is not realistic by 9 Nov. Say so plainly to the judges' video audience as well: show the honest product, not a promise.

## Cut or leave for after 12 Nov

- Auto-quote on option change.
- Removing the second consent tick.
- An order history page.
- Case tracking for buyers.
- Content previews.
- "Your library" renamed in the nav (it is test churn for little gain).
- Changing the tone of the partial order (pinned; optional).
- Persistent packs across sessions: never.
- Ratings, "also bought" and urgency banners: never.

## Demo video, under 3 minutes

Show these screens, in this order. The Sandbox label and footer line stay in frame throughout.

| Time | Screen | What it must show |
| --- | --- | --- |
| 0:00 to 0:15 | Home, with the dark header and search | The problem: "Buy just the article you need. No subscription." |
| 0:15 to 0:50 | Find articles results | Type a need. Show the fit rows ("The cards are advice. You choose."), open "Why this fit" once, and add two articles from two publishers to the pack tray. The tray shows "2 publishers, so 2 PayPal payments". |
| 0:50 to 1:15 | Pack approval | The two payment panels, the order summary and the exact pack notice. Keep the real countdown visible. Tick and press "Continue to payment". |
| 1:15 to 1:45 | PayPal sandbox approval, then Step 2 of 2, then PayPal again | The one button, with no automatic redirect: say it out loud. |
| 1:45 to 2:05 | Your order | Both "Ready in your library", in one sentence with plural verb agreement. |
| 2:05 to 2:25 | Library | Rows, time left, "Read online" opening the article. |
| 2:25 to 2:40 | Receipt | Titles, the Sandbox label, print. |
| 2:40 to 2:55 | Ops | The status strip and "Stop PayPal now" (show the button; do not press it in the sandbox take unless planned with the owner). |

If time is short, cut Ops first, then the receipt. Never cut the pack tray, the approval or the Step 2 of 2 screen: those are the PayPal story.

## Conflicts with the rules, and what I chose instead

1. **One-click "Buy now"** (a big-marketplace pattern) conflicts with rule 1. I kept "Choose this article", then the approval, then PayPal.
2. **Removing the second consent checkbox** on the approval page would remove a repeated step (WCAG 3.3.7, redundant entry, is arguable). Consent is part of the money-path design, so I kept it and moved it to after 12 Nov with the payments reviewer.
3. **"You approved payment 1 of 2"** on the Step 2 of 2 page would be false after a declined first payment: `zcomposite.spec.ts` shows Step 2 of 2 after a decline. I chose a stepper plus "This payment covers", the latter from data only.
4. **"Payment 1 of 2 to <publisher>"** on the approval page is honest only if the block order equals the PayPal order position. It is conditional on reviewer confirmation; the fallback is "Payment to <publisher>".
5. **Ratings or a numeric match score** would be fabrication. I used the band chip, the words for each level, and an evidence summary.
6. **Urgency.** The only countdown is the real price freeze on the approval page (and the real 60-minute pack window sentence). There is no timer on the results, the tray or the home page.
7. **A persistent cart** would show stale prices after the price freeze. The tray is session-only.
8. **A familiar yellow or orange buy button** would be trade-dress imitation. I kept UnitMarket's own accent blue and a neutral dark header.
9. **The "Nothing was charged because of this page." error line** (`app/error.tsx`) and **"Nothing was charged"** on the checkout-paused page: D-051 reserves "not charged" for declined, failed or abandoned PayPal orders. These lines use a different phrase about a page, not an order. Neither is wrong today, but ask the D-051 owner whether "Nothing was charged" counts. My proposals do not add any new "not charged" or "nothing was charged" wording.
10. **Tone of a partial order** (one ready, one declined, shown as success). Changing it is a behaviour change, pinned by `order-status.test.ts:22` and the golden. It stays optional.
11. **"Sold by ... on behalf of" on the receipt** may be legally wrong under D-041 (one payee for both publishers in the sandbox). I chose "Publisher: <name>" per line instead.
12. **Inline styles.** The CSP has `default-src 'self'` and no `style-src 'unsafe-inline'` (`lib/page-headers.ts`). New components must use classes in `globals.css`, not `style={{...}}`. The existing `style` attributes (`library/page.tsx:34`, `WindowMeter.tsx:24`) need a check that they actually render under the CSP. The mockups use classes only, for this reason.
