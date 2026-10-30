# 05 Style spec: a familiar big-marketplace look and feel, UnitMarket's own

Goal: buyers should recognise the patterns at once (search bar on top, result rows with a price block, a tray, a checkout summary, an order page, a "your orders" style library) without the product copying any brand's logo, colours, names or trade dress. Everything below is CSS custom properties plus a small set of React components in `apps/web/src/ui/`.

Constraints:

- No new dependencies.
- System fonts only. No web fonts: the CSP allows `default-src 'self'` only, and a web font would need a download.
- No inline `style` attributes, because the CSP has no `style-src 'unsafe-inline'`.
- No randomness: the lint rule S6 applies, so cover colours come from a hash.
- Both themes. AA contrast, measured with the WCAG formula (the ratios below are computed, not guessed).

A working reference is `mockups/` (built with these tokens; `mock.css` is inlined in each HTML file).

## 1. Tokens

### Colour, light (`:root`)

| Token | Value | Use | Measured contrast |
| --- | --- | --- | --- |
| `--bg` | `#f6f5f1` | page | text 15.06:1 |
| `--surface` | `#ffffff` | cards, rows, panels | text 16.4:1 |
| `--surface-2` | `#f2f0ea` | disabled controls, meter track, neutral pill | muted on it 6.46:1 |
| `--text` | `#17202b` | body | |
| `--muted` | `#4b5766` | secondary text | 6.74:1 on bg, 7.36:1 on surface |
| `--line` | `#7a8491` (changed from `#8a93a0`) | control and card borders | 3.48:1 on bg, 3.79:1 on surface (today's value is 2.98:1 on bg) |
| `--line-soft` | `#d9dde3` | dividers only (decorative, not a control boundary) | |
| `--accent` | `#14587f` | primary buttons, links, selected state | 7.69:1 with white text; 7.05:1 on bg |
| `--accent-hover` | `#0f4a6b` | hover and active | 9.49:1 with white |
| `--accent-ink` | `#ffffff` | text on accent | |
| `--accent-soft` | `#e3eff6` | info box, selected chip | accent text 6.57:1 |
| `--header-bg` | `#17202b` | top bar (neutral ink, not a brand navy) | white 16.4:1 |
| `--header-ink` | `#ffffff` | top bar text | |
| `--header-muted` | `#c9d2dc` | search border, Sandbox pill on the bar | 10.75:1 |
| `--good`, `--good-soft` | `#1b6b3a`, `#e4f3ea` | ready, success | 5.70:1 |
| `--warn`, `--warn-soft` | `#7a4b00`, `#fcf0d9` | hold, Dry run pill | 6.57:1 |
| `--bad`, `--bad-soft` | `#9b1c1c`, `#fbe6e6` | errors, danger button | 6.82:1; white on bad 8.15:1 |
| `--focus` | `#b35c00` | focus ring, 3 px | 4.33:1 on bg, 4.72:1 on surface (3:1 needed) |

### Colour, dark (`@media (prefers-color-scheme: dark)`, as today)

| Token | Value | Measured |
| --- | --- | --- |
| `--bg` | `#11161d` | |
| `--surface` | `#1a212b` | text `#eef2f6` 14.40:1 |
| `--surface-2` | `#222b37` | muted 7.52:1 |
| `--muted` | `#b3bdc9` | 8.52:1 on surface |
| `--line` | `#8795a6` | 5.31:1 on surface, 5.95:1 on bg |
| `--accent` | `#8ec6ea` with `--accent-ink` `#0b1a24` | 9.61:1 (button); 8.81:1 as a link on surface |
| `--accent-hover` | `#b5daf2` | |
| `--header-bg` | `#0b0f14` | text `#eef2f6` 17.08:1 |
| `--good`, `--warn`, `--bad` | `#7fd6a0`, `#f1c46b`, `#ff9c9c` | 9.28, 9.91, 8.09 on surface |
| `--focus` | `#ffb14d` | 8.99:1 on surface |

Add a user override later (`:root[data-theme='dark']`) only if a theme toggle is built. It is not needed for the deadline.

### Cover tile hues (white text, both themes)

| Value | Contrast with white |
| --- | --- |
| `#14587f` | 7.69:1 |
| `#0f5f63` | 7.40:1 |
| `#6b3f8f` | 7.68:1 |
| `#33415c` | 10.24:1 |
| `#7a4b00` | 7.41:1 |
| `#1b6b3a` | 6.54:1 |

Pick the hue by `hash(publisher_slug) % 6`, where `hash` is a fixed function (sum of char codes), so the colour is stable and lint-safe. The tile shows the publisher's initials (two letters) and, at 72 px or wider, the publisher name in 11 px. It is decorative: mark it `aria-hidden="true"`. It must not imply a real cover or any content.

### Typography (system stack, as today)

| Token | Size / line height | Use |
| --- | --- | --- |
| `--fs-xs` | 13 / 18 | chips, pills, fine print |
| `--fs-sm` | 14 / 20 | bylines, meta, tray lines |
| base | 16 / 24 | body |
| `--fs-md` | 18 / 24 | result titles, panel headings |
| `--fs-lg` | 22 / 28 | h2, total row |
| `--fs-xl` | 28 / 34 | h1 and the price in the result buy column |

Prices use `font-weight: 800` and `font-variant-numeric: tabular-nums`. Do not use superscript cents: the price stays one text node, which reads simply in a screen reader. Weights are 400, 600 (labels) and 700 to 800 (titles, prices).

### Spacing, radius, elevation

- Spacing scale: `--s1` 4, `--s2` 8, `--s3` 12, `--s4` 16, `--s5` 24, `--s6` 32, `--s7` 48 (px).
- Radius: `--r-sm` 6 (tiles, pills with long text), `--r` 10 (cards, buttons, inputs), 999 (short chips).
- Elevation in light mode: `--shadow-1: 0 1px 2px rgba(23,32,43,.08), 0 1px 1px rgba(23,32,43,.04)` on cards. On the mobile bottom bar use `--shadow-tray: 0 -6px 18px rgba(23,32,43,.14)`. In dark mode, shadows are `none` and borders carry the shape.

### Layout and breakpoints

- Content width 1120 px for results and checkout (main plus a 300 to 340 px rail). Reading pages (help, sign in) cap text at 70ch.
- One breakpoint at 760 px. Below it, everything is one column, the rail becomes a sticky bottom bar, buttons go full width, and the header nav goes icons-only with visually hidden labels (never `display: none` on the label).
- Test widths: 400, 768, 1280. No horizontal scroll at 400 px. The mockups were checked: `scrollWidth - innerWidth = 0` at 400 and 1200.

## 2. Components

| Component | File (new or changed) | Spec |
| --- | --- | --- |
| `TopBar` | `app/layout.tsx` | `--header-bg` bar, 64 px. Left to right: brand, search form (hidden on `/discover`, label "Search articles", button "Search"), nav (My library, Operations for operators, Help, Sign in), and `EnvLabel` last, always visible. |
| `EnvLabel` | `ui/EnvLabel.tsx` (style only) | Unchanged text from stored data. On the dark bar: Sandbox uses `--header-muted` and Dry run uses `--warn` (dark-mode value) for strong distinction. |
| `CoverTile` | `ui/CoverTile.tsx` | Sizes 56x76 (mobile, line items), 72x96 (library), 88x116 (results). Hue rule above. |
| `ResultRow` | `ui/ResultRow.tsx` (replaces the grid use of `FitCard`) | Grid `88px 1fr 200px`. Body: title link (18/600), byline (14 muted), `FitSummary`, `FitDetails`. Buy column, left-bordered: price (28/800), option name plus "5 days to read" or "5 days to download", primary "Choose this article", `PackToggle`. Keep `data-testid="fit-card"`. |
| `FitSummary` | inside `ResultRow` | Band chip plus "Matches k of n of your words · {recency evidence}", from evidence text only. |
| `FitDetails` | inside `ResultRow` | `<details>` with the summary "Why this fit" and five rows: label, dots (aria-hidden), words plus evidence. "not assessed" rows in muted text. |
| `PackToggle` | inside `ResultRow` | A real `<input type="checkbox">` inside a label styled as a dashed button. Ticked state is solid accent, reads "In your pack", and the card gets a 2 px accent border. Its accessible name contains the title. |
| `PackTray` | `ui/PackTray.tsx` | Heading "Your pack" with a count badge. Lines: title, publisher, amount, and a remove `btn-link` named "Remove {title}". Total row. Publisher and payment sentence. Primary "Buy selected together" (`BUY_SELECTED`). The lock line "You pay nothing until you approve at the payment step." Empty: "Select two or more articles to buy them together." (`id="pack-hint"`). Server refusals show here in an error box. Rail at 760 px and wider; sticky bottom bar below, which keeps the count, total, button and lock line. |
| `SortFilterBar` | `ui/SortFilterBar.tsx` | `select` "Sort by" (Suggested order, Price: low to high, Price: high to low). Filter chips are `button[aria-pressed]` for "Read online" and "Download and keep". Results heading count updates in a polite live region: "2 of 4 articles shown". |
| `TermsBar` | in `DiscoverForm.tsx` | Bordered box with the consent checkbox (never pre-ticked) and the `<details>` "What the terms say". |
| `CheckoutStepper` | `ui/CheckoutStepper.tsx` | `ol` with `aria-current="step"`. The labels are Choose, Review, Approve at PayPal (adds "N of M" on the step page), Read in your library. Done steps show a check icon plus visually hidden "done". |
| `OrderSummary` | `ui/OrderSummary.tsx` | Sticky rail panel: item count and amount, optional fee row (reviewer), Total (22/800), info notice (`packNotice`), `Countdown`, consent, large primary button (52 px, full width), lock line. MONEY PATH. |
| `PaymentPanel` | in `ApproveClient.tsx` | One per publisher block: heading, line items (`CoverTile` 56, title, option help, amount), subtotal row. Keep `data-testid="approve-block"`. |
| `StatusPill` | `ui/StatusPill.tsx` | Text first, colour second (WCAG 1.4.1). Tones: good (ready), info (waiting, confirming, approved, pending, not started, paused), warn (on hold), neutral (refunded, partly refunded, ended, revoked, not charged). "Not charged" is neutral, not red: it is not the buyer's error. Text always comes from `LINE_TEXT` or `status_text`. |
| `LibraryRow` | `app/library/page.tsx` | Grid `72px 1fr 210px`: tile; title link, meta, `StatusPill`, "Access until {date}", meter bar; actions (primary open button, then links "View receipt" and "Problem with this item?"). Keep `library-item` and `library-status`. |
| `ReceiptView` | `app/receipts/[order]/page.tsx` | Title row with `EnvLabel` and `PrintButton`. Table: Item (title plus publisher), Access, Amount (right-aligned, tabular). Total row. Refunds. The fingerprint is in `<details>`. Print CSS: hide the top bar, footer links and buttons; keep the footer sentence and the label. |
| `OpsStatusStrip` | `app/ops/page.tsx` plus `lib/ops-summary.ts` | A banner at the top with tone from the snapshot, and lines from a pure function (golden-pinned). It ends with a link "Go to Stop PayPal calls". |
| Buttons | `globals.css` | Primary: filled accent, 44 px minimum height (52 px for the checkout action). Secondary: 2 px accent outline. Tertiary: `btn-link`, an underlined accent text button with a 32 px minimum target (24 px is the WCAG 2.5.8 floor). Danger: filled `--bad` with white text, only for "Stop PayPal now". Disabled: `--surface-2` background, `--muted` text, `--line` border, no opacity trick. One primary per view region. |
| Chips | `globals.css` | Band chips: Strong fit (good), Good fit (accent), Partial fit (warn), with a 1 px current-colour border, 13 px and 700 weight. Filter chips: 2 px border, pressed gives accent soft plus a check mark. |
| Icons | inline SVG, as in `FitCard.tsx` | 20 px (16 in fine print), 24 grid, stroke 1.8 to 2, `currentColor`, `aria-hidden="true" focusable="false"`, always next to a text label. The set, drawn in house: search, library (book spines), help (question circle), lock (trust line), clock (countdown), pack (box), check, alert, receipt. No brand marks, and no PayPal logo unless PayPal's own brand rules are followed (leave it out for the deadline). |
| `EmptyState` | `ui/EmptyState.tsx` | Icon (48 px, muted), title (`--fs-lg`), one sentence, one primary action. Variants: library empty, filtered empty, no match (with `CatalogueList` under it). |
| `ErrorState` | `ui/ErrorState.tsx` | Unchanged semantics (`role="alert"`). Style: a 4 px left border in `--bad` on `--bad-soft`, an alert icon, the title, what to do, and an action button when there is one. Place it next to the control that failed (tray, rail, buy box), not at the top of the page. |
| `Skeleton` | `ui/Skeleton.tsx` | Grey `--surface-2` blocks shaped like a `ResultRow`, with a polite live "Finding articles". No animation under `prefers-reduced-motion`; otherwise a 1.2 s opacity pulse. |
| Focus | `globals.css` | Keep the 3 px `--focus` outline with a 3 px offset on `:focus-visible`. Add `main:focus { outline: none; }`. |

## 3. Familiar pattern map (what a buyer will recognise)

| Familiar pattern | UnitMarket form | Honest limits |
| --- | --- | --- |
| Search bar in a dark top bar | `TopBar` search, and the need form on `/discover` | Results come from the need parser, so it is not live search. |
| Result rows: image, title, byline, rating, price, button | Cover tile, title, publisher, fit band plus evidence, price block, "Choose this article" | No ratings, so the fit band takes their place. |
| Sort and filter | Suggested order, price; option chips | No "newest" or "bestseller" (no such data). |
| Product page buy box | Offer page buy box | The ceiling and the price proposal sit inside `<details>`. |
| Cart | Pack tray, for this session only | Two publishers at most and one currency (the server decides). |
| Checkout summary | `OrderSummary` rail with per-publisher panels | Two PayPal payments, said plainly. There is no automatic step. |
| Order confirmation | Order page with rows, pills and "What happens next" | Amounts appear only after the data change P4. |
| "Your orders" | Library rows with status, time left, open, receipt and help | Grouped by item, not by order (until after 12 Nov). |
| Printable invoice | Receipt with print CSS | It is a receipt for test money; the label stays. |

## 4. Implementation notes

- Keep every `data-testid` that the e2e tests use: `fit-card`, `quote-price`, `approve-total`, `approve-block`, `pack-notice`, `step-heading`, `step-deadline`, `order-live`, `order-item`, `order-case`, `order-refund`, `library-item`, `library-status`, `window-meter`, `env-label`, `receipt-*`, `cancel-*`, `ops-*`, `status-banner`, `error-state`, `empty-state` and `countdown`.
- Put the new tokens at the top of `globals.css` and keep the old class names working (`.card`, `.fit-card`, `.banner-*`, `.btn`, `.chip-*`) so pages can move one at a time.
- Money-path pages get no new tokens beyond what Phase 1 applies globally. Their markup changes go through the payments reviewer (04-plan, Phase 2a).
