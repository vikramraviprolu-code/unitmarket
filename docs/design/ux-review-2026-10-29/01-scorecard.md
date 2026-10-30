# 01 Scorecard: UnitMarket sandbox screens against a big-marketplace buying experience

Reviewer: senior product design and UX review, read only. Repository `unitmarket-sandbox`, branch `main`, read on 29 Oct 2026.
Sources: page code under `apps/web/src/app/**`, components under `apps/web/src/ui/**`, copy helpers under `apps/web/src/lib/**`, `apps/web/src/app/globals.css`, the DP-5 and DP-5b specs, `docs/design/nfr.md`, the owners' screenshots in the `images/` folder (cited by file name) and the e2e shots in `apps/web/e2e/shots/`.
I opened only the screenshots of the UnitMarket app. I skipped PayPal pages, terminals, the cloud console and anything that might show credentials. Ids that appear in screenshots are not copied here.

## How to read the scores

Each screen is scored from 0 to 10 on nine criteria:

| Code | Criterion | What a 10 looks like |
| --- | --- | --- |
| N | Clarity of next step | One obvious primary action. The buyer always knows what happens when they press it. |
| T | Trust and reassurance | Price, terms, who gets paid and what happens to the money are clear at the moment of decision. |
| H | Information hierarchy | The eye goes to title, price and action first. Secondary detail is there but quieter. |
| V | Visual design | A coherent, confident visual system: product imagery or a stand-in, rhythm, density and polish. |
| S | Speed to purchase | The fewest steps the safety design allows, and no step that repeats an earlier one. |
| M | Mobile (400 px) | Works at 400 px with no squeezed columns, and the action stays close at hand. |
| A | Accessibility | WCAG 2.2 AA: contrast, keyboard use, visible focus, live regions, names on controls. |
| E | Error and empty states | Every failure says what happened and offers a way forward. No dead ends. |
| C | Consistency | Same words, patterns and components for the same thing on every screen. |

The screen score is the rounded mean of its nine criteria. 5 means "works and is honest, but looks and feels like an internal tool". 8 means "a stranger would trust it with a card and finish without help".

## Headline

**Overall: 5 out of 10 today.** The 17 buyer screens average 5.5. The 8 screens on every purchase average 5.4: results, fit card, both approvals, Step 2 of 2, order, receipt and library. The operator screen scores 4.5. A mature big-marketplace flow is about 8.

The owners' 2 out of 10 is too harsh overall, but it is close to right for one dimension. Visual design and merchandising really are 2 to 4: no header bar, no product imagery, no hierarchy, every card looks the same, and the receipt shows internal ids. The rest of the product is better than it looks:

- Accessibility is genuinely good: skip link, `aria-live` status, 44 px targets, 7:1 text contrast, `prefers-reduced-motion`, and announced countdown warnings.
- The honesty of the money copy is better than most large marketplaces. The fit cards say "not assessed" instead of inventing scores, holds are never shown as success, and nothing is pre-ticked.
- Error and empty states exist on almost every screen.

These strengths are invisible to a judge who looks for 20 seconds. That is why the product reads as a 2 to someone comparing screenshots side by side with a big marketplace.

## Buyer screens

### 1. Home `/` (`app/page.tsx`): 5

| | Score | Evidence |
| --- | --- | --- |
| N | 6 | Two clear doors, "I have an article link" and "Find articles" (`page.tsx:15-37`, 18.png). |
| T | 6 | The promise is clear: "Pay once ... five days of access. No subscription." (`page.tsx:11-13`). |
| H | 5 | Both cards have the same weight. The search door, which is the core idea, does not dominate. |
| V | 3 | Plain text on beige with two outlined boxes and no imagery (18.png). |
| S | 5 | The links go straight to offers, which is good, but only 4 are shown (`page.tsx:19`, `slice(0, 4)`). |
| M | 7 | `grid-2` collapses at 260 px (`globals.css:171-176`). |
| A | 8 | Section landmarks are labelled (`aria-labelledby`, `page.tsx:15,29`). |
| E | 4 | No state for an empty catalogue, and no state when AI is off. |
| C | 5 | The card says "I have an article link" but holds a list of articles, not a link field (`page.tsx:16-27`). |

### 2. Sign in `/signin`: 6

| | Score | Evidence |
| --- | --- | --- |
| N | 7 | One form and one button (`SignInForm.tsx:52-115`). |
| T | 6 | It says honestly that this is a test build (`signin/page.tsx:20-23`). The persona picker looks like a demo tool, which it is. |
| H | 6 | Fields are in a sensible order. The operator fields appear only when needed (`SignInForm.tsx:78`). |
| V | 4 | A bare form on beige (16.png). |
| S | 6 | Pasting is allowed and the hint says so (`SignInForm.tsx:66-68`). |
| M | 7 | Full-width fields (`globals.css:295-308`). |
| A | 8 | `autocomplete` values are correct (`current-password`, `one-time-code`). The disabled button at 55 % opacity is hard to read (16.png); this is exempt from WCAG 1.4.3 but weak. |
| E | 7 | Errors are specific to the persona and the rate limit (`SignInForm.tsx:39-45`, 17.png). |
| C | 6 | 16.png shows "Operator (read only)" while the code says "Operator" (`SignInForm.tsx:10`), so the screenshots are already out of date. |

### 3. Find articles: form, results and no match (`app/discover/*`): 4

| | Score | Evidence |
| --- | --- | --- |
| N | 5 | "Choose this article" is clear, but the terms tick must come first, and it sits above the cards with no terms text (`DiscoverForm.tsx:138-141`). |
| T | 5 | "The cards are advice. You choose." is good (`DiscoverForm.tsx:137`). But the buyer accepts "the terms of purchase" without seeing them anywhere on this page. |
| H | 3 | The pack checkbox floats above each card and repeats the title ("Select <title> to buy together", `DiscoverForm.tsx:145-152`). "Buy selected together" sits below the last card (`DiscoverForm.tsx:164-179`, 106.webp). |
| V | 3 | Uniform outlined boxes with dot rows (95.webp, 105.webp). |
| S | 4 | No sort, no filter, no running total for a pack. To buy two items the buyer must scroll from the checkboxes to the bottom button. |
| M | 3 | At mid widths the three-column grid crushes the fit rows into one-word lines (106.webp). The cause is `.fit-row` at `22px 84px 54px 1fr` (`globals.css:200`), which only reflows below 520 px (`globals.css:437-444`). |
| A | 7 | There is a live region (`DiscoverForm.tsx:126`) and the disabled pack button is described by its hint (DP-5b L3). The terms checkbox has no description of its terms. |
| E | 4 | "No match" is a dead end with no catalogue fallback and no suggestion (`DiscoverForm.tsx:128-133`, 63.png). The AI-off state is better (`discover/page.tsx:15-35`). |
| C | 5 | The page is called "Find articles for my need", the nav says "Find articles" and the home page says "Find articles for my need": three names for one place. |

### 4. Fit card (`ui/FitCard.tsx`): 5

| | Score | Evidence |
| --- | --- | --- |
| N | 6 | One primary button per card (`FitCard.tsx:71-73`). |
| T | 8 | Honest: an unknown dimension reads "not assessed" and shows hollow dots, never a number (`FitCard.tsx:26-27,65`). |
| H | 4 | Three of the five rows are "not assessed" and they dominate the card (95.webp). The useful signal, the topic match, is one row of five. |
| V | 4 | The dots and icons are tidy, but there is no visual anchor (cover or thumbnail). |
| S | 5 | The title is not a link to the offer page, so the buyer cannot read the abstract before choosing (`FitCard.tsx:46`). |
| M | 3 | See screen 3 (106.webp). |
| A | 7 | Icons are `aria-hidden` and the level is given in words (`FitCard.tsx:59-66`). |
| E | 6 | A missing band means no chip (`FitCard.tsx:48`). |
| C | 4 | "$1.20 for read online" is broken grammar (`FitCard.tsx:53`, lower-casing `OPTION_LABEL`). Every card in 106.webp says "Good fit" even when its topic row is "weak", so the band does not tell the cards apart. |

### 5. Offer page `/o/[publisher]/[offer]` (product detail): 5

| | Score | Evidence |
| --- | --- | --- |
| N | 5 | Each option already shows its price (`OfferFlow.tsx:124-125`), yet the buyer must press "Show my price" to see the same number again (22.webp). |
| T | 7 | "Personal use only. No redistribution." and the access help are shown (`OfferFlow.tsx:187-189`). The optional identity share is not pre-ticked (`OfferFlow.tsx:194-200`). |
| H | 5 | The publisher name sits above the title, which is good, but there is no "buy box": price, option and action are spread down the page. |
| V | 4 | No imagery, a long form and a beige background (22.webp). |
| S | 4 | Four actions before approval: choose an option, press "Show my price", tick the terms, press "Review and approve". |
| M | 7 | A single column that works. |
| A | 8 | The fieldset and legend are present, the hints are bound with `aria-describedby`, and the result region is live. |
| E | 7 | Every no-match reason has plain words (`OfferFlow.tsx:19-28`, 72.png "already in your library"). |
| C | 5 | A ceiling field on a product page is unusual; the ceiling belongs to the need search (`OfferFlow.tsx:132-145`). |

### 6. Approve your purchase, single item `/approve/[id]`, MONEY PATH: 6

| | Score | Evidence |
| --- | --- | --- |
| N | 7 | One button, "Continue to payment" (`ApproveClient.tsx:142-151`). |
| T | 8 | "You pay nothing until you approve at the payment step." (`approve/page.tsx:19-21`). The price freeze has a real countdown and renewal (`Countdown.tsx`). |
| H | 6 | The total is large. The frozen-until line repeats the countdown in raw ISO, "2026-10-29 19:14 UTC" (`format.ts:26-28`, 107.png). |
| V | 4 | One outlined box and loose lines below it (107.png). |
| S | 5 | It asks for a second consent: "I confirm ... and that I accepted them on the previous step." (`ApproveClient.tsx:136-141`). This repeats the tick on the previous page. |
| M | 7 | A single column. |
| A | 8 | The countdown is announced at 2 minutes (`Countdown.tsx:41-47`) and the screen-reader time is spelled out. |
| E | 7 | The error carries a support code (50.webp). "Already used" has its own banner (`ApproveClient.tsx:130-133`). |
| C | 6 | "Approve your purchase" sits beside a "Continue to payment" button, while the next screen title is "Step 2 of 2: approve your payment". The word "approve" means two different things. |

### 7. Approve your purchase, pack, MONEY PATH: 6

| | Score | Evidence |
| --- | --- | --- |
| N | 7 | Same single button. |
| T | 8 | The pack notice is exact and honest: "You will approve 2 payments ... charged only after you have approved both." (`composite-copy.ts:9-10`, 108.png). |
| H | 4 | The publisher blocks are bullet lists, the subtotals are sentences, and the blocks are not labelled "Payment 1 of 2" or "Payment 2 of 2", so they do not link to the PayPal steps that follow (`ApproveClient.tsx:82-99`). |
| V | 4 | A wall of text inside one box (108.png). |
| S | 5 | Same double consent as the single-item approval. |
| M | 7 | Works. |
| A | 8 | Headings are present per publisher (`ApproveClient.tsx:84`). |
| E | 6 | Mixed-currency and too-many-publishers errors are handled before this page (`approvals/route.ts:44-45`). |
| C | 6 | Consistent with the single-item approval, for better and worse. |

### 8. Dry-run checkout `/checkout/dry-run/[order]` (offline stand-in for PayPal): 6

The labels are honest and loud: "Dry run: no PayPal" appears both as the heading and in a banner (`dry-run/[order]/page.tsx:23-27`). There is one form per PayPal order. It is a testing page, so a big-marketplace comparison does not apply; it is only seen in dry-run demos. Scores: N7 T8 H6 V4 S6 M7 A8 E6 C7.

### 9. Step 2 of 2 `/checkout/return`, MONEY PATH: 6

| | Score | Evidence |
| --- | --- | --- |
| N | 8 | One button. No automatic redirect, as the rule requires (`checkout/return/page.tsx:83-93`, dp5-step-2-of-2.png). |
| T | 6 | The deadline sentence is honest (`composite-copy.ts:22-23`). But the page does not say that payment 1 was approved, how much payment 2 is, or which article it pays for. |
| H | 6 | The heading carries everything. There is no summary. |
| V | 3 | A heading, a sentence, a button and a link on an empty page. |
| S | 7 | As fast as the safety design allows. |
| M | 8 | Trivial layout. |
| A | 8 | The button is a real link with a full name. |
| E | 6 | "See where your order stands" is the escape. |
| C | 6 | It does not look like part of the same checkout as the approval page: no stepper and no summary. |

### 10. Payment not approved `/checkout/cancel`: 7

The page is static, honest and scoped: "Nothing was charged for this payment." (`composite-copy.ts:32-36`). After DP-5b it offers a way back (`cancel/page.tsx:24-35`). It is plain, but it does its job. Scores: N7 T8 H7 V4 S7 M8 A8 E8 C7.

### 11. Checkout paused (the `payments_paused` branch of the return page): 6

"Nothing was charged" is the error title, with "Payments are switched off for now. Your order is kept; try again later." (`checkout/return/page.tsx:99-112`, 33.png). It is clear, but "try again later" gives no time and no link to the help page. Scores: N6 T7 H6 V4 S5 M8 A8 E6 C6.

### 12. Your order `/orders/[ref]` (order confirmation), MONEY PATH: 6

| | Score | Evidence |
| --- | --- | --- |
| N | 7 | "Open my library" is primary and "View receipt" is secondary (`OrderStatus.tsx:54-64`, 109.png). |
| T | 7 | The banner verb follows the number of titles (D-051, 109.png). A hold wears the warning tone (dp5b-order-held.png). |
| H | 4 | No amounts, no order date, no order reference, no payment method and no "what happens next". A big-marketplace confirmation leads with these. |
| V | 4 | A banner and a bullet list (109.png). |
| S | 7 | Nothing in the way. |
| M | 8 | Simple. |
| A | 8 | `aria-live="polite"` with `aria-atomic` (`OrderStatus.tsx:28`). |
| E | 6 | A partial result ("one ready, one not charged") wears the green success tone (golden line "pack, one ready, one declined, tone: success"; dp5-order-partial.png). The held order shows a raw case id and repeats its message three times (dp5b-order-held.png, `OrderStatus.tsx:48-52`). |
| C | 5 | A single-item order says "Paid. Your item is in your library." (`composition.server.ts` `orderMessage`), while a pack says "X and Y are ready in your library." Two voices for the same moment. |

### 13. Receipt `/receipts/[order]`, MONEY PATH (display): 4

| | Score | Evidence |
| --- | --- | --- |
| N | 4 | No print or download action, and no link back to the library or the order. |
| T | 5 | The environment label sits beside the title, which is good (`receipts/[order]/page.tsx:19-21`). The fingerprint is honest, but it is the most prominent block. |
| H | 3 | The item column shows the internal article id, not the title (`receipts/[order]/page.tsx:37`, 38.png). There is no publisher, no order reference and no payment date. |
| V | 3 | A bare table (38.png). |
| S | 5 | Not applicable; it is reached in one click. |
| M | 5 | A three-column table with a long monospace id wraps badly at 400 px. |
| A | 7 | The table has a caption and `scope` attributes. |
| E | 5 | A 404 page exists. Refunds are listed (73.png, 88.png). |
| C | 4 | "Access" holds "Read online, until <ISO>" in a format different from the library's. |

### 14. My library `/library` ("Your orders" equivalent): 6

| | Score | Evidence |
| --- | --- | --- |
| N | 7 | Each ready card has one primary button, "Read online" or "Download" (`library/page.tsx:53-60`, 97.png). |
| T | 6 | The refund wording is honest ("The copy you downloaded cannot be recalled.", 97.png). But the time left contradicts itself on the same card: "Ready, 4 days 23 hours left" next to "5 days left until ..." (97.png). The cause is `days_left` rounding up (`Math.ceil`, `composition.server.ts:1065`) while `status_text` rounds down (`domain/library/src/library.ts:42-53`). |
| H | 5 | The title link, the bold status and the bold meter line all compete. Refunded items are mixed with active ones. |
| V | 5 | A card grid; the best-looking buyer page today. |
| S | 7 | Opening an item takes one click. |
| M | 7 | `grid-2` collapses. |
| A | 8 | The status is live (`library/page.tsx:43`) and the meter has a text alternative (`WindowMeter.tsx:23`). After navigation, focus draws an orange outline around the whole `main` (97.png, `layout.tsx:63` with `tabIndex={-1}` and `globals.css:61`). |
| E | 7 | The empty state has an action (`library/page.tsx:22-32`). |
| C | 5 | No receipt link on the card, though `order_id` is in the entry (`composition.server.ts:1090`). Sort and grouping are not defined. |

### 15. Library item `/library/[entitlement]`: 5

Shown under the heading "Evidence" with "Payment state: refunded", a raw state word (`library/[entitlement]/page.tsx:41-49`, 91.png). The actions are good: "View receipt" and "Problem with this item?". Scores: N6 T6 H5 V4 S6 M7 A8 E6 C5.

### 16. Help `/help/[case]`: 5

There is no help index: the nav goes straight to `/help/payment` (`layout.tsx:50`). Four topics are hard-coded (`help/[case]/page.tsx:7-33`). "Ask us to look at this" opens a case with no field to describe the problem, then says "We opened a case and will update this page." (`OpenCase.tsx:31-33`), but the help page never shows the case afterwards. Scores: N5 T6 H5 V4 S6 M8 A8 E5 C5.

### 17. Not found and error pages: 6

Both are honest and give one action (`not-found.tsx`, `error.tsx`). The error page says "Nothing was charged because of this page." Check that phrase against D-051 (see 04-plan, conflicts). Scores: N7 T7 H6 V4 S6 M8 A8 E7 C6.

## Operator screens

### 18. Operations `/ops`: 4.5 (from the operator's point of view)

| | Score | Evidence |
| --- | --- | --- |
| N | 4 | No summary at the top that says "is it safe, and is anything stuck". The operator must read six sections (100.webp). |
| T | 7 | Every lock is spelled out, the label comes from data and the shared payee shows only the last 4 characters (`ops/page.tsx:79-87`). |
| H | 3 | Switches are raw snake_case names in a table, and "NO" in capitals is the only alarm signal (`gate-lines.ts:45`). Invariants are at the very bottom. |
| V | 3 | A long, flat document (100.webp). |
| S | 5 | "Stop PayPal now" is an outlined secondary button in the middle of the page and needs a typed reason first (`StopButton.tsx:24-43`). The typed reason is right; the placement and weight are not. |
| M | 5 | Long tables at 400 px. |
| A | 7 | Captions are present on the tables and the stop result is live. |
| E | 6 | "No orders yet.", "No alerts." and a no-MFA explanation for refunds (`ops/page.tsx:98-106`). |
| C | 5 | "On" or "Off", "yes" or "NO", "ok" or "FAILED": three vocabularies for one idea. |

### 19. Refund panel (on `/ops`): 5.5

Strong behaviour: one key per form, focus moves to the answer, and the wording is pinned by a golden test (`RefundPanel.tsx:16-41`). The layout is a stack of forms (69.png, 70.png). Not judged by buyers. Scores: N6 T7 H5 V4 S5 M5 A8 E7 C5.

## Summary table, with targets

"QW" means after the quick wins (copy and CSS only, about 1 day). "Med" means after the medium set (2 to 3 days). "Best" is my honest best by Mon 9 Nov. The phases are in 04-plan.md.

| Screen | Now | QW | Med | Best by 9 Nov | What the next step depends on |
| --- | --- | --- | --- | --- | --- |
| Home | 5 | 6 | 7.5 | 8 | QW: header bar and theme tokens. Med: results-style list of all offers, covers. |
| Sign in | 6 | 6.5 | 7 | 7 | Persona sign-in stays (D-040), so 7 is the ceiling. |
| Find articles and results | 4 | 5.5 | 8 | 8.5 | QW: CSS reflow and fit details folded away. Med: list rows, pack tray, sort and filter (client side), no-match fallback. |
| Fit card | 5 | 6 | 8 | 8 | Med: summary line from the topic evidence, title link to the offer (needs slug and code in the discover payload, apps/web only). |
| Offer page | 5 | 6 | 7.5 | 8 | Med: buy box layout. 8 needs auto-quote on option change (behaviour change; may slip to after 12 Nov). |
| Approve single, MONEY | 6 | 7 | 8 | 8 | Payments reviewer sign-off before the Mon 2 Nov freeze. 9 would need the double consent removed (contract change; after 12 Nov). |
| Approve pack, MONEY | 6 | 7 | 8.5 | 8.5 | Same reviewer. "Payment 1 of 2" labels and a summary rail. |
| Dry-run checkout | 6 | 6.5 | 7 | 7 | Not worth more; it is a test page. |
| Step 2 of 2, MONEY | 6 | 6.5 | 8 | 8 | Med: stepper and "payment 1 approved" line (copy in `composite-copy.ts`, golden update). The amount needs a `PackStep` amount from stored data (composition). |
| Cancel | 7 | 7.5 | 8 | 8 | Theme only. |
| Checkout paused | 6 | 6.5 | 7 | 7 | Copy only. |
| Your order, MONEY | 6 | 6.5 | 8 | 8 | Med: amounts, date and reference from stored data (`OrderView` extension in composition), "what happens next". |
| Receipt, MONEY display | 4 | 5 | 7.5 | 8 | Med: titles by joining library entries on `article_id` (page-level, no contract change), print stylesheet. |
| Library | 6 | 7 | 8 | 8.5 | QW: remove the contradicting "N days left" and the focus ring on `main`. Med: rows, filter chips, receipt link. |
| Library item | 5 | 6 | 7 | 7.5 | Copy: "Evidence" becomes "Details", with the state in words. |
| Help | 5 | 5.5 | 6.5 | 7 | Med: help index page. Case tracking is after 12 Nov. |
| Ops | 4.5 | 5.5 | 7 | 7.5 | Med: status strip, danger-styled stop, human switch names. |
| **Overall (buyer path weighted)** | **5** | **6** | **7.5** | **8** | |

**Can we reach 8 or 9?**

- **8 overall by 9 Nov is realistic**, and 8.5 on the screens that appear in the demo video, if the quick wins and the medium set both land and the money-path items clear review before the 2 Nov freeze.
- **9 is not realistic by 9 Nov.** It needs things no theme can supply:
  - real cover art or content previews from publishers;
  - a catalogue large enough for search, filter and sort to matter (the seed has about 6 articles);
  - a real "Your orders" history with order grouping and dates;
  - a single consent step (a contract change on the money path);
  - live search as you type;
  - a performance pass;
  - at least one round of testing with five real users.

  I would not claim 9 for a hackathon build, and I would tell the owners so.

## Which big-marketplace patterns apply, and which do not

Apply (and are proposed in 03 and 05):

1. **Search results as list rows**: thumbnail stand-in, title, byline, one-line fit summary, price block and one primary button on the right. Rows suit text products better than a 3-column grid, and they survive 400 px.
2. **Sort and filter chips** (best fit, price, newest; read online, download and keep, under a price). This is client-side over the returned items, with no server change.
3. **Product card price and option clarity**: one price per option, the option name in words, and "5 days to read" or "5 days to download" under the price.
4. **A buy box on the detail page**: price, option selector and the action grouped in one bordered box.
5. **A persistent tray for "Buy selected together"**: count, running total, number of publishers and therefore payments, the remove action, and one button. It is like a cart but scoped to this search, and it never implies a charge.
6. **A checkout summary rail**: line items grouped by who gets paid ("Payment 1 of 2 to <publisher>"), the total, and the action under the total. This maps well onto one PayPal payment per publisher.
7. **An order confirmation** that leads with status, items, amounts, date and "what happens next".
8. **"Your library" styled like "Your orders"**: rows with a status pill, time left, the primary action, and receipt and help links per row, plus filter tabs (Ready, Ended or refunded).
9. **Trust signals that are true here**: "You pay nothing until you approve at the payment step", "You approve each payment on PayPal's own page", the Sandbox or Dry run label, the terms summary in place, and a refund and delivery-problem path.

Do not apply, and why:

1. **Star ratings and review counts.** There are no reviews. Inventing them would be fabrication, and the fit card is the honest substitute.
2. **"Only N left", "Deal ends in" and strike-through "was" prices.** Digital items have no scarcity and there is no list price. These would be fake urgency, which D-051 and the brief forbid. The only countdown stays the real price freeze on the approval page.
3. **One-click "Buy now".** It breaks the approval safety design (approve in UnitMarket, then approve at PayPal) and the rule "You pay nothing until you approve at the payment step". "Choose this article" stays.
4. **"Frequently bought together" or "Customers also bought" upsells.** There is no honest data behind them, and they cut against "the cards are advice, the buyer chooses".
5. **A cart that persists across days.** Quotes and approvals expire (a 15-minute price freeze, a 60-minute pack window). A persistent cart would show stale prices. The tray lives for the session only.
6. **Delivery dates, a shipping-speed upsell or a membership.** Access is instant. A membership is the opposite of "no subscription".
7. **A carousel or "recommended for you" home page.** The catalogue is tiny, so a carousel would look empty and would imply a model that does not exist.
8. **Auto-advancing to the second PayPal payment.** It is forbidden (OQ-5): one button, never an automatic redirect.
9. **Copying any brand's colours, logo, yellow or orange buy buttons, or exact trade dress.** The proposal uses UnitMarket's own blue accent and a neutral dark header (see 05).
