# Spec: legal pages, footer links and the sign-in privacy notice (LEGAL-A)

Task: four static pages with real draft text marked for owner approval, links to them in the footer, and a short privacy
notice on the sign-in page (PRIV-6).
Package: `apps/web` Owner: builder (Sonnet) Reviewer: Opus, one round; owners approve the text (H)
Branch: `feat/web-legal-a-pages` Commit: `feat(web): <what> (LEGAL-A)` Decisions: D-065 items 49, 51, 67; D-004, D-041,
D-051. Common rules: plan section 2. No dependency on other overnight lanes.

Goal: a judge or a buyer can read, before paying, what they agree to, what data is processed and how refunds work; a
publisher can read the publisher terms; every page says plainly that it is a draft for owner approval, that it is not legal
advice, and that this is a sandbox demo where no real money moves.

Pages (server components, no client code), copy in `apps/web/src/lib/legal-copy.ts` as plain data (title, updated date as a
fixed string, sections of heading plus paragraphs), rendered by one component `apps/web/src/ui/LegalPage.tsx`:

- `/legal/terms` "Terms of purchase": what a unit is; personal use only, no redistribution; access five days from verified
  payment and ready delivery (architecture 9.4, D-006); price and terms held 15 minutes once the buyer starts to buy; one
  PayPal payment per publisher; sandbox: test money only.
- `/legal/privacy` "Privacy notice": what is processed (session cookie, a hashed network address for rate limits, the
  persona chosen, orders and access events; PayPal processes payment details on its own pages and we never see card data;
  payer email and names are redacted from our logs, architecture 9.9); why; retention (logs 30 days at the host, provider
  call records 90 days, orders and ledger kept for the judging period); export or deletion on request through the operator
  (decision 52); no advertising, no tracking scripts, no third-party fonts; contact shown as the text "Contact details will be
  added by the owners before submission."
- `/legal/refunds` "Refund policy": refunds are decided by an operator per unit; a full refund ends access to that unit; partial
  refunds do not revoke access (ASM-61); sandbox: refunds return test money.
- `/legal/publisher-terms` "Publisher terms and sandbox disclaimer": publishers here are fictional; payee checks are by an
  operator, not PayPal onboarding; no commission in this demo, planned 20 percent, not implemented (item 36); UnitMarket uses
  no payout mechanism (D-004); where each publisher's money goes is shown on its statement from stored data.
  Every page starts with the banner "Draft for owner approval. This is not legal advice." and the sandbox line. No italics,
  no dash characters (U+2013, U+2014, or a spaced hyphen used as a dash), D-051 verb agreement.

Footer (`apps/web/src/app/layout.tsx`): a `nav` with `aria-label="Legal"` and the four links, under the existing footer
sentence. Sign-in (`apps/web/src/app/signin/page.tsx`): one sentence above the form, "We use a session cookie and a hashed
network address to keep this demo safe. Read the privacy notice.", the last three words a link to `/legal/privacy`.

Tests first (the unit runner does not compile `.tsx`: test the copy module and read page sources as text, as
`order-pages.state.test.ts` does): `apps/web/src/legal.state.test.ts` (four routes exist as `page.tsx`; each renders
`LegalPage` with its copy; the footer holds the four hrefs; the sign-in page links `/legal/privacy`);
`apps/web/src/legal-copy.golden.test.ts` (golden of all copy; banner present on all four; no italics markup, no dash
characters; the words "paid out" absent).

Acceptance: `corepack pnpm test:state apps/web`, `corepack pnpm test:golden apps/web`, plan section 3. All pass.
Do not: touch `DiscoverForm.tsx` (owned by UX-1A, which shows the terms at the tick; a link to `/legal/terms` there is a
follow-up after UX-1A merges); edit `globals.css` (use existing classes); claim compliance with any law;
name a real company, person or address.
Evidence: outputs, red run, screenshots of one page at 400 and 1280 px if a browser runs, cost line.
