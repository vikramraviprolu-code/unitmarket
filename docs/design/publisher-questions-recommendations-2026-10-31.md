# Publisher supply side: 30 questions with recommendations (31 Oct 2026)

Status: RECOMMENDATIONS ONLY, for the owners to decide. No product code was changed, no PayPal call was made, no credential was
held. Written against `origin/main` at `7082f09`. Questions brainstormed by the owner (Sakthi); numbers kept. This is not legal or
tax advice: every item marked COUNSEL needs a lawyer or tax adviser before a real launch.

Read first and used throughout: `docs/proposals/publisher-side-proposal-2026-10-30.md` (the proposal),
`docs/design/publisher-traceability-2026-10-31.md` (103 rows, cited as P-xx, MT-x, DV-xx), `docs/owner/OVERNIGHT-ASSUMPTIONS.md`
(cited as assumption n), `docs/decision-log.md`, `docs/design/architecture.md` sections 9.5, 9.12 and 12, `docs/design/nfr.md` 2.6,
`docs/owner/DECISIONS-FOR-VIKRAM.md` (cited as item n) and `apps/web/src/lib/legal-copy.ts` (the draft terms).

Scoring criteria (D-065): Technological Implementation, Design, Potential Impact, Innovation, Presentation. Dates: feature freeze
Fri 6 Nov (item 12), money path and payee freeze Mon 2 Nov (item 31), team submission Mon 9 Nov, hard limit Thu 12 Nov 12:00 PT.

## How to read each answer

- (a) default for the hackathon demo; (b) for a real launch, where different; (c) why; (d) why not the main alternatives; (e) what
  it means for the build; (f) flags.
- Build words: BUILT (on `main` with a test or a route); S (under one lane); M (one lane of 60 to 90 minutes with its review); L
  (two or more lanes); HUMAN (only a person can do it). A lane day is one builder slot for a working day, about three or four lanes
  including reviews.
- Flags: COUNSEL (legal or tax adviser must confirm); SECURITY (not decided here: options and trade off only, marked OWNER
  DECISION); PAYPAL FACT (checked against PayPal's own pages, listed in section 10, marked VERIFIED when the page was opened and
  read, UNVERIFIED otherwise).
- One fact shapes many answers. In the product design each publisher is paid directly by PayPal into its own PayPal account through
  the Orders v2 `payee` field; UnitMarket never holds a publisher's money (architecture 9.5, D-004). On `main` today both selling
  publishers are paid into the owner's sandbox Business account (D-041), and the screens and submission text must say so.

## 1. Agreement and onboarding

### Q1. Who signs for a publisher, and is click through acceptance enough for the demo?

- (a) Demo: yes, click through is enough. The publishers are fictional, so nobody signs. Show a versioned "Publisher terms"
  acceptance record on the dashboard: terms version, accepted by which persona, when. Seed it for the fictional publishers, and
  ask for it once on first sign in if AGREE-1 is built.
- (b) Launch: a person with authority to bind the publisher (owner, director or someone they name) accepts a versioned agreement
  electronically and states their role. Larger publishers get a countersigned order form on top. Every acceptance is stored append
  only with the version, time and signer.
- (c) Why: judges asking "what did the publisher agree to?" today get only the per offer rights attestation ("I confirm that I hold
  the rights to sell this article at this price on these terms", stored as `PUB-ATTEST-1`). One visible acceptance record helps
  Design and Potential Impact, it is cheap, and it follows the existing pattern of `attestation_version` and `terms_version`.
- (d) Why not an electronic signature service: a new dependency (D-008) and a new outbound host (rule S2) for no score gain. Why not
  nothing: the two sided market story has a hole where the publisher's consent should be.
- (e) S if the acceptance is seeded and shown read only; M for AGREE-1 (an append only `publisher_agreement_acceptances` table,
  forward migration 0013, a gate on publisher pages until accepted, golden copy). Catalogue data, not money path, so item 31
  leaves it open after 2 Nov.
- (f) COUNSEL for launch: whether click through binds a business in each launch country and what evidence must be kept.

### Q2. What are the commercial terms: revenue share, term, termination, notice, exclusivity?

- (a) Demo: no commission, said in plain words: "No commission in this demo; planned 20 percent, not implemented" (BUILT, DV-36,
  `COMMISSION_LINE`, publisher terms page). Add to the draft publisher terms: non exclusive; either side may stop at any time in the
  demo; no fees.
- (b) Launch: 20 percent of the gross price per sale, collected as a PayPal platform fee once PayPal enables us as a partner; until
  then no commission. Non exclusive. Twelve month term that renews; either side may end it on 30 days notice; immediate termination
  for rights breaches, fraud or unlawful content. No minimum volume.
- (c) Why: non exclusive lowers the barrier for small publishers (Impact). PayPal states platform fees need the caller to be enabled
  (`PLATFORM_FEES_NOT_SUPPORTED`) and are not supported for first party integrations, which is what we are today, so a collected
  commission is not achievable honestly by 9 Nov. Note the price interplay: at 1.00 USD a 20 percent commission plus PayPal's
  standard fee leaves the publisher about 0.28 (Q14).
- (d) Why not exclusivity: small publishers also sell elsewhere and would refuse; judges read lock in. Why not invoicing publishers
  monthly: we become their creditor and need billing and collections. Why not deducting commission before paying out: that is
  collect then pay out, which D-004 and architecture 9.5 reject.
- (e) BUILT (wording). S to rewrite the publisher terms page (LEGAL-B).
- (f) COUNSEL (commercial terms). PAYPAL FACT VERIFIED (platform fees, first party restriction, enablement error).

### Q3. Who warrants rights, what licence do we get, and how fast must a takedown happen?

- (a) Demo: the publisher warrants rights through the attestation checkbox on every offer revision (BUILT); buyers get personal use
  only, no redistribution (BUILT, terms of purchase); a takedown is the publisher pressing Withdraw, which stops new sales at once
  (BUILT). State the warranty and our licence in the draft publisher terms.
- (b) Launch: the publisher warrants it owns or controls the rights, the content is lawful, and it indemnifies us against third
  party claims. Our licence: non exclusive, limited to the launch countries, ending at termination, to host the content, show its
  title and abstract, deliver it to buyers and let the AI helper match briefs to it; no right to train models. Takedown: the
  publisher withdraws instantly itself; on a third party legal notice an operator acts within one business day as a target, with
  the exact duty set by counsel per country.
- (c) Why: rights are a small publisher's first worry (Impact). The record is already auditable: attestation per authorisation, and
  content frozen once an offer is authorised (trigger `articles_content_frozen`), which is good Technological Implementation to
  show.
- (d) Why not an exclusive or perpetual licence: more than we need, and it scares publishers. Why not a seven day takedown target:
  too slow for a legal claim when our withdraw is already instant.
- (e) BUILT for the demo, plus S for terms text. Launch: an operator takedown tool (Q16), M.
- (f) COUNSEL (warranty, indemnity, any notice and takedown regime such as the US DMCA safe harbour with its designated agent, and
  the AI use clause; see assumption 11 on the buyer side AI line).

### Q4. How much identity or business verification for the demo versus a real launch?

- (a) Demo: none. Publishers are fictional and labelled "(fictional)" in the seed data and on the terms page (BUILT, P-4L5).
- (b) Launch: let PayPal verify the account that receives money, through Partner Referrals onboarding, and accept a seller only when
  PayPal's seller status shows `payments_receivable` true and `primary_email_confirmed` true. Add our own light checks: legal name,
  control of the website domain (a DNS record or page token), country, a contact, and sanctions screening if counsel says it is
  required.
- (c) Why: in the direct payment model PayPal is the one that knows the account holder; we avoid holding identity documents, which
  lowers privacy and security risk. Fictional brands keep real personal data out of the demo (item 67).
- (d) Why not collect ID documents ourselves: a data protection burden with no score. Why not no checks at launch: fraud and rights
  abuse go straight to buyers.
- (e) BUILT for the demo. Launch: L, and Partner Referrals needs partner approval from PayPal (HUMAN).
- (f) COUNSEL (whether a marketplace that never holds funds has its own KYC duties). PAYPAL FACT VERIFIED: "You must be an approved
  partner to use this integration"; status fields as above.

### Q5. Who approves a publisher, on what criteria, and by one person or two?

- SECURITY, OWNER DECISION. Approving a publisher, together with its payee, decides where buyers' money goes.
- Built today: the seeded publishers are active; the operator route refuses to activate an applicant (test "an applicant cannot be
  activated through this route"); suspend and reactivate need one operator with MFA and are audited (P-I4).
- Criteria (not a security choice, recommended): rights attestation given; payee shown receivable (Q8); first articles pass review
  (Q13); no prohibited content; corridor supported.
- Options: O1 one operator with MFA, audited (same as suspend; cheapest). O2 two person rule: one operator proposes, a different
  operator confirms (two operators exist, D-062 and D-063). O3 owner command at a TTY only, like `safety:approve`.
- Trade off: O1 lets one compromised or mistaken operator approve a fake publisher with their own account; O2 and O3 close that at
  the cost of a lane and slower approvals. For the demo nothing is needed if the publishers stay seeded active (cut list item 4).
- (e) Demo: nothing. O2 or O3: M. (f) Not counsel.

### Q6. Do publishers get individual logins, authenticator codes and team members?

- SECURITY, OWNER DECISION.
- Built today: three publisher personas behind one publisher passcode hash, separate from the demo passcode (DV-34, assumption 18).
  A publisher session cannot change the payee (operator only), prices are capped at 2000 minor units and frozen per approval.
- Options: O1 keep the shared hash (anyone holding it can sign in as any publisher and revise prices within the cap or withdraw
  offers). O2 one hash per publisher (M). O3 add authenticator codes for publishers, reusing the operator TOTP code (M; making and
  storing keys is HUMAN). O4 real accounts with team members and roles such as owner, editor and finance (L, launch).
- Trade off: O1 costs nothing and the money destination is safe; the exposure is price edits and withdrawals for the judging window.
  O2 and O3 each cost a lane and add secrets to rotate after judging (item 64). For launch the minimum is individual accounts with
  MFA for anyone who can change prices, rights or ask for a payee change.
- (f) Not counsel.

## 2. Payment linking

### Q7. Is the publisher paid directly into its own PayPal account, or do we collect and pay out later? (D-004)

- (a) Demo: the product model is direct payment. Keep D-004 (no Payouts API). The demo build as it stands pays both selling
  publishers into the owner's sandbox account (D-041), labelled, unless the owners choose Q11 option B.
- (b) Launch: direct payment as a PayPal partner (PayPal Complete Payments): sellers onboarded through Partner Referrals, each order
  naming the publisher as payee, commission as a platform fee.
- (c) Why: PayPal's own page says money goes to the app owner's account by default, and including the payee's email or merchant id
  pays another account. That keeps UnitMarket out of holding publisher money (nfr 2.6 puts money transmission out of scope), and it
  is the mechanism PayPal judges expect. The code already sends a payee whenever it is not our own merchant id (D-028, MT-5).
- (d) Why not the Payouts API: a new allow listed path and approval scope after the freeze, it makes us the holder of publisher
  money, and it shows PayPal judges the weaker model. Why not a manual transfer from the owner's dashboard: a fiction that must not
  be presented as product behaviour.
- (e) No build: the decision is to keep D-004.
- (f) COUNSEL (whether facilitating direct payments creates duties anyway). PAYPAL FACT VERIFIED (pay another account; the
  `PAYEE_NOT_CONSENTED` description). UNVERIFIED: whether our sandbox app may create and capture an order for a third party payee
  without consent (spike step 16 never ran).

### Q8. What proves the PayPal account is real and can receive?

- SECURITY for the method, OWNER DECISION. Facts and options below.
- Built today: an operator retypes the requested merchant id, MFA required, audited; a duplicate id is refused unless both rows are
  flagged shared; in sandbox mode verification is refused with `owner_command_required` by design (assumption 3).
- Options: R1 PayPal Partner Referrals: PayPal returns the merchant id and reports `payments_receivable` and
  `primary_email_confirmed` (strongest; needs partner approval). R2 a small test order to the stated merchant id with a read back of
  the payee, the D-028 echo check (proves it can receive; needs an approval row that names that payee, which the approval table
  cannot express today, DV-30). R3 an email plus an operator check (weakest: an email can be mistyped or point at the wrong
  person).
- Recommended in any case (not a security choice): store the merchant id, never rely on email; require a Business account; the
  account must accept the corridor currency, otherwise captures sit PENDING (architecture 12, verified behaviour).
- (f) PAYPAL FACT VERIFIED for R1 fields and the `PAYEE_ACCOUNT_NOT_VERIFIED` and `PAYEE_ACCOUNT_INVALID` errors. UNVERIFIED:
  whether a Personal account can be an Orders v2 payee.

### Q9. What happens when a publisher changes the account: cooling off, second check, who approves?

- SECURITY, OWNER DECISION.
- Built today: a change request does nothing until an operator verifies it by retyping the id with MFA (P-B1); 3 requests a day;
  append only history visible to the publisher (P-B2); a change while an approval is open makes `placeOrder` answer
  `payee_unavailable` and create no order (test in `web/payee.state.test.ts`). Not built: cooling off, notice to the old contact, a
  second operator.
- Options: C1 cooling off of 24 to 72 hours before a verified change takes effect (blocks a quick redirect of money; delays honest
  changes). C2 notify the old contact and every publisher admin (needs email, which does not exist, Q23). C3 two person approval.
  C4 a fresh PayPal check through Partner Referrals (launch only).
- Trade off: payee redirection is the single most valuable attack on a marketplace; each control costs a lane or more. Whatever is
  chosen, MT-4 must land first: the statement must follow the payee stored on each unit (PUB-E1), or a change makes old lines false.
- (f) Not counsel.

### Q10. What happens if PayPal limits or closes the account: do sales pause automatically?

- (a) Demo: no build. Say in the testing notes that a restricted payee makes order creation fail and nothing is charged. How the
  current error map words `PAYEE_ACCOUNT_RESTRICTED` to a buyer was not checked for this memo.
- (b) Launch: yes, pause automatically. On `PAYEE_ACCOUNT_RESTRICTED`, `PAYEE_ACCOUNT_LOCKED_OR_CLOSED` or `PAYEE_NOT_CONSENTED`,
  set the publisher to a payee problem state, hide its offers, refuse new approvals, raise an operator alert and tell the publisher.
  Resume only after an operator check. With Partner Referrals, also react to seller status changes.
- (c) Why: fail closed is the design's habit (kill switches, payee guards). Because each publisher has its own PayPal order, one bad
  account does not block the others.
- (d) Why not retry with another payee: never; D-028 forbids a retry with a changed body. Why not manual only: buyers keep failing
  at checkout until someone notices.
- (e) M on the money path (`packages/paypal` error map, `domain/payments`, publisher status) with an Opus review, after the freeze:
  OWNER DECISION on timing.
- (f) PAYPAL FACT VERIFIED (the three error descriptions).

### Q11. For the demo, is Quayside paid into a real second sandbox account, or labelled fiction?

- OWNER DECISION (accounts and PayPal calls are human only and drastic).
- Option A, labelled fiction (the state on `main`, D-041): both selling publishers paid into the owner's account; the fallback judge
  line is already drafted ("Both publishers are paid into one sandbox test account; multi-merchant payout not demonstrated").
  No build, no risk.
- Option B, a new US Business sandbox account for Quayside: a human creates it and sets its receiving preference; decision rows
  amend D-041 and D-023; PUB-E1 fixes MT-4 first (S to M); HARD-PAYEE finishes the owner command (M); PAYEE-SCOPE adds an approval
  scope that names one payee and a transport check (L, money path, Opus review; today the transport allows any payee under
  `mvp_c_refunds`, MT-5); then the OWN-1 owner sitting under a new approval row. Risks: `PAYEE_NOT_CONSENTED`; captures PENDING if
  the receiving preference is wrong; refunds of a Quayside capture with our credentials are UNVERIFIED and may be dashboard only.
- Trade off: B is the strongest Technological Implementation and Innovation proof (two PayPal merchants, real) and restores PAY-01
  and PAY-07, but it is about two lane days plus a human sitting, and item 31 says payee changes only before Mon 2 Nov, which leaves
  a weekend. A costs nothing and is honest.
- If no decision is recorded by Sun 1 Nov, option A stands and the fallback line is used. (f) PAYPAL FACT: see Q7.

## 3. Catalogue

### Q12. How does content arrive: upload, feed, CMS plugin, or manual entry by an operator?

- (a) Demo: the operator seeds it (BUILT, 10 articles). If the entry paths memo is approved, add the signed offer link and the
  "Share this offer" panel (`docs/design/entry-paths-research-2026-10-31.md`).
- (b) Launch, in order: paste or upload of plain text or Markdown in the console with limits (200 KB, server side sniff, sha256,
  inert render, the AI-1 injection set re run); then feed import (branch `feat/feed-import`); then CMS plugins (branch
  `feat/wordpress-plugin`).
- (c) Why: judges test the buyer path; seeded content proves the model. Upload is L and opens an attack surface (files, prompt
  injection) days before the freeze.
- (d) Why not upload now: L plus its own security review. Why not feeds now: SSRF surface and an owner host allow list, on hold.
  Why not WordPress: PHP cannot be run or tested here (assumption 35).
- (e) BUILT for the demo. Upload L (P-D3); share panel S to M (other memo).
- (f) SECURITY only if upload is built (its own review). Not counsel.

### Q13. Who reviews content before it goes live, and what gets rejected?

- (a) Demo: no review step; seeded content was written by the team; an offer is live once authorised (BUILT).
- (b) Launch: an operator reviews the first articles of each new publisher, then later articles go live at once with sampling.
  Automatic checks always run: size, type, duplicate hash, the AI-1 injection set. Rejected: infringing or unlawful content, scripts
  or malware, text written to steer the AI helper or the price, hate or adult content against policy, misleading titles, prices
  outside the rules.
- (c) Why: protects buyers and the AI helper, and scales with a small team.
- (d) Why not review everything forever: does not scale and slows small publishers. Why not no review: brand and legal risk.
- (e) BUILT for the demo. Launch L (review queue).
- (f) COUNSEL (content policy; whether hosting rules such as the EU Digital Services Act apply to us).

### Q14. Who sets prices, within what range, and what minimum given PayPal's fixed fee?

- (a) Demo: the publisher sets one price per access option, integer minor units above 0, at most 2000 (BUILT, `checkPrice`,
  `UMS_OFFER_MAX_MINOR`); demo prices 1.00 to 2.50 USD (BUILT, DV-37). No universal floor (architecture 9.12).
- (b) Launch: the publisher sets the price; we set a floor and a ceiling per corridor. Floor about 1.00 USD when the receiving
  account has PayPal's micropayments rate, otherwise about 3.00 USD. Ceiling around 20 USD to bound dispute exposure (Q21). The
  offer editor shows the fee effect, labelled as an estimate.
- (c) Why: PayPal's US business fees page (read 30 Oct 2026): standard checkout 3.49 percent plus 0.49 USD; micropayments 4.99
  percent plus 0.09 USD. Micropayments is cheaper below about 26.67 USD.

  | Price    | Standard fee  | Micropayments fee | Publisher keeps after standard fee and 20 percent |
  | -------- | ------------- | ----------------- | ------------------------------------------------- |
  | 1.00 USD | 0.52 (52 pct) | 0.14 (14 pct)     | 0.28                                              |
  | 2.50 USD | 0.58 (23 pct) | 0.21 (8 pct)      | 1.42                                              |
  | 5.00 USD | 0.66 (13 pct) | 0.34 (7 pct)      | 3.34                                              |

  Sandbox fees may differ; the app shows only the fee PayPal reports in `seller_receivable_breakdown`.

- (d) Why not UnitMarket setting the exact price (the original Bible rule): publishers lose control and the console loses its main
  job. Why not no floor: under about 0.60 USD most of a sale goes to the fixed fee.
- (e) BUILT. A corridor floor is S (`min_charge_minor` already exists in the corridor schema, UNVERIFIED value). A fee estimate in
  the editor conflicts with the copy rule "money figures only from stored rows"; put the table in the README instead unless the
  owners relax the rule.
- (f) PAYPAL FACT VERIFIED for the published rates. UNVERIFIED: whether and how a given account gets the micropayments rate.

### Q15. When an article is edited or withdrawn, what do earlier buyers keep?

- (a) Demo (BUILT): a buyer keeps the exact version bought for the five day window. A price or terms change writes a new offer
  version and never changes an earlier approval ("Buyers who already approved keep the price they saw"). Content is frozen once an
  offer is authorised, so a correction is a new article. Withdraw stops new sales only. A downloaded copy stays with the buyer.
- (b) Launch: the same, plus an optional notice to earlier buyers that a corrected version exists.
- (c) Why: the snapshot freeze (A-08) and the hash on the receipt are the trust story, already built and tested.
- (d) Why not upgrade buyers to the new version automatically: it breaks the hash proof on the receipt. Why not end access on
  withdraw: the buyer paid for five days; it would need a refund each time.
- (e) BUILT. The notice is M, later.
- (f) COUNSEL (consumer rules on digital content, for example whether updates must be supplied).

### Q16. How are corrections and legal takedowns handled for buyers who already paid?

- (a) Demo: a correction is a new article and a new offer. A legal takedown is Withdraw plus a full refund per affected unit, which
  ends access (BUILT, refund policy and MVP-C). Write this into the publisher terms; no new code. Note: the hosted approval D-062
  has no refund operations, so a refund in a hosted sitting needs a new approval row (HUMAN).
- (b) Launch: an operator takedown action that ends access for every unit of one article with a reason code, an audit row and a
  buyer message, and refunds those buyers in full; the publisher bears the refund when the cause is its content (in the direct
  model PayPal takes it from the publisher's account). For corrections, offer earlier buyers the corrected article at no charge.
- (c) Why: the full refund path is already proven in the sandbox; it avoids new money path code before the freeze.
- (d) Why not revoke without a refund: the buyer paid for the window; a trust and consumer law problem. Why not edit content in
  place: it breaks the hash, the receipt and the freeze trigger.
- (e) Demo S (terms text). Launch M (takedown tool) and M (free correction grant).
- (f) COUNSEL (takedown duties, consumer refunds).

## 4. Money in operation

### Q17. Payout cadence, minimum threshold, currency, and who bears PayPal's fees?

- (a) Demo: no payouts (D-004). The statement shows the PayPal fee beside sales, not subtracted (BUILT). In the demo the fee falls on
  the receiving sandbox account, which is the owner's.
- (b) Launch: in the direct model there is no cadence and no threshold: PayPal credits the publisher's own balance at capture.
  Currency is the offer currency, one per order, with balances per currency (D-030). PayPal deducts its fee from the receiving
  account, so the publisher bears it; this is written into the agreement.
- (c) Why: no payout operation, no money held, nothing to reconcile on our side. A judge sees a simpler and safer design.
- (d) Why not weekly payouts above a threshold: needs Payouts or manual transfers (D-004) and makes us hold funds. Why not absorb
  PayPal's fee: we lose about 0.52 on every 1.00 sale.
- (e) BUILT.
- (f) PAYPAL FACT VERIFIED (fees). Commercial term for COUNSEL to write.

### Q18. When does commission start, and how is it shown?

- (a) Demo: none charged; "No commission in this demo; planned 20 percent, not implemented" on the statement and the terms (BUILT).
- (b) Launch: commission starts only once PayPal enables platform fees for our partner account. Each statement line then shows
  "UnitMarket commission (PayPal platform fee)"; PayPal shows the same fee to the seller as "Partner commissions". A launch offer
  of 0 percent for the first 90 days is a commercial option.
- (c) Why: honest, and technically required: the fee can only be taken by PayPal for an enabled partner.
- (d) Why not a computed 20 percent line in the demo: a projected figure breaks the copy rule and implies we collect. Why not a
  monthly invoice: credit risk and a billing system.
- (e) BUILT.
- (f) PAYPAL FACT VERIFIED (platform fees, "Partner commissions" wording, daily settlement of partner fees). COUNSEL for tax on
  commission.

### Q19. Who is the merchant of record for sales tax or VAT, and who issues invoices and tax forms?

- (a) Demo: no tax is computed; prices are all in, as set by the publisher (architecture 12); the receipt is an evidence document,
  not a tax invoice. Add one sentence to the terms: "UnitMarket does not issue tax invoices in this demo."
- (b) Launch: counsel and a tax adviser decide. The candidate model is that the publisher is the seller and the PayPal payee, and
  UnitMarket is an agent charging a commission. But marketplace facilitator laws in many US states, and EU rules on electronically
  supplied services sold through platforms, can make a platform responsible for collecting tax even when it never holds the money.
  Each launch country must be checked before go live. PayPal says it issues Form 1099-K to US account holders who receive goods and
  services payments above thresholds; in the direct model that would be the publisher.
- (c) Why: engineers cannot settle this, and getting it wrong leaves the platform owing tax.
- (d) Why not UnitMarket as merchant of record: it means collecting all the money (against D-004 and 9.5) and registering for tax
  everywhere. Why not ignore tax: not an option for a launch.
- (e) Demo S (one sentence and its golden). Launch L plus HUMAN (adviser).
- (f) COUNSEL and tax adviser. PAYPAL FACT UNVERIFIED: the multiparty pages read do not say who is merchant of record; the 1099-K
  point comes from a search summary of PayPal's help page, which was not opened.

### Q20. Who decides refunds, can the publisher contest, and is the publisher's share clawed back?

- (a) Demo (BUILT): an operator decides per unit; buyers cannot refund themselves; a full refund ends access; a partial refund is a
  price adjustment (D-046); a refund is booked only when PayPal confirms it (D-019). The publisher sees refunded states on its sales
  page and cannot contest in the demo. Real sandbox refunds ran under D-052 into the owner's account.
- (b) Launch: an operator decides on written rules (a delivery failure we detected is refunded or credited without argument; buyer
  claims go to an operator). The publisher is told and may object within two business days for refunds above a set amount, but a
  refund for our delivery failure is never held up. In the direct model PayPal takes the refund from the publisher's account, so the
  share is clawed back by PayPal itself. PayPal keeps its original fee, so the agreement must say who carries that loss: the
  publisher when the cause is its content, UnitMarket when the cause is our delivery.
- (c) Why: buyer trust (Impact); operator control is already built and tested; on small prices the lost fee is a large share.
- (d) Why not let the publisher decide: slow and a conflict of interest. Why not refund every claim automatically: abuse.
- (e) BUILT. A publisher refunds list (P-G2) S; an objection step M, later.
- (f) PAYPAL FACT VERIFIED ("the fees you originally paid to receive the payment are not returned"). UNVERIFIED: whether our
  credentials may refund a capture paid to a third party merchant (option B in Q11). COUNSEL (consumer refund and withdrawal rights
  for digital content).

### Q21. Who handles disputes and chargebacks, with what evidence and time limits?

- (a) Demo: no Disputes API (PAY-07 out list, P-G3); the screens show only verified reversal states (BUILT). Say in the video that
  the delivery evidence we already store is what a publisher needs to defend a claim.
- (b) Launch: in the direct model a dispute is raised against the payee, the publisher, who answers in its own PayPal account. We
  supply an evidence pack per unit within one business day: receipt, terms version, snapshot hash, delivery evidence (access ready,
  link use times), window dates. With partner permissions the Disputes API could let us submit evidence for the publisher. Internal
  target: evidence two business days before PayPal's response date for that dispute.
- (c) Why: PayPal Seller Protection for intangible items needs evidence that the item was delivered or provided as described and
  that transaction fees were paid; it covers item not received claims made through PayPal and eligible unauthorised payments, not
  "significantly not as described" claims. Our delivery evidence fits that exactly, an Innovation point. Fees matter: a US dispute
  fee is 15 USD and a chargeback fee 20 USD, far above a 2 USD sale, so the price ceiling and fraud rules must bound exposure.
- (d) Why not UnitMarket answering every dispute itself: we are not the payee and would need the publisher's permissions. Why not
  ignore disputes: publishers lose claims they could win.
- (e) Demo BUILT. Evidence pack export M (read only; could be shown). Disputes API L, roadmap.
- (f) PAYPAL FACT VERIFIED (Seller Protection help article; fees page; the Disputes API has evidence, accept claim and offer
  endpoints, and sandbox only endpoints to settle a test dispute). UNVERIFIED: whether a partner can act on a seller's dispute;
  the buyer's filing window and the seller's response time. COUNSEL (liability split in the agreement).

### Q22. What must a publisher see: daily sales, statements, CSV, tax pack, buyer counts without identities?

- (a) Demo: BUILT: sales table without buyer identity (PRIV-1), statement per currency that reconciles to the ledger, payee page,
  offers. Finish: the same settlement sentence on S1, S6 and S7 (PUB-E2, MT-6); the sales page and statement agree, with a totals
  row and one test (PUB-E3, MT-2, needs the owners' call on assumption 30 about `mismatch`). CSV only if time allows (S). No buyer
  counts.
- (b) Launch: daily sales, a monthly statement as PDF and CSV, a yearly tax pack per country and currency once Q19 is settled, and
  distinct buyer counts only in groups of at least 10 (a suggested threshold against re identification).
- (c) Why: Design is scored on a complete product; figures that agree across pages are the trust test a PayPal judge applies.
- (d) Why not buyer names or emails: privacy and PRIV-1. Why not charts in the demo: lanes spent on three publishers with a handful
  of sales.
- (e) Mostly BUILT; PUB-E2 M, PUB-E3 S, CSV S.
- (f) COUNSEL (privacy of aggregated buyer data at launch).

### Q23. Which events notify a publisher, and by what channel?

- (a) Demo: none (cut first, P-H1). The dashboard shows current state.
- (b) Launch: email for payee change requested and decided (always, to every publisher admin), suspension and reactivation, refund,
  dispute or reversal, takedown notice, and a weekly sales digest; an in app list; webhooks for larger publishers later.
- (c) Why: there is no email service; adding one is a new outbound host and likely a new dependency (S2, D-008) days before the
  freeze.
- (d) Why not email now: host, deliverability and a new secret. Why not SMS or push: cost and no need.
- (e) NOT BUILT; launch M to L.
- (f) The payee change notice is part of the Q9 SECURITY decision.

### Q24. How does a publisher reach us, and what response time do we promise?

- (a) Demo: one team contact address on the publisher terms and in the README (the privacy page still says "Contact details will be
  added by the owners before submission"); promise "best effort during judging", no fixed response time.
- (b) Launch: a support address and a form in the console; targets of one business day for takedown, payee and suspension issues and
  two business days for the rest.
- (c) Why: honest; a two person team cannot staff a 24 hour promise to 15 Dec.
- (d) Why not a 24 hour promise: we would break it. Why not a chat widget: a third party script that our CSP forbids.
- (e) HUMAN (choose the address), then S (text and golden).
- (f) No personal email in the repository or video (item 67).

## 5. Closure and compliance

### Q25. What does offboarding involve?

- (a) Demo: suspend is BUILT (offers hidden, new approvals refused, entitlements kept, MFA, audited). Describe offboarding in the
  publisher terms; no build.
- (b) Launch: 30 days notice either way; offers withdrawn at the end; buyers keep their running windows; a final statement; no balance
  to settle because PayPal paid the publisher directly; refunds and disputes after the end handled under surviving clauses; content
  deleted after the last window ends plus a short grace period; ledger, receipts and audit rows kept for the legal retention period.
- (c) Why: direct payment makes offboarding simple, which is worth saying to judges.
- (d) Why not delete everything at once: breaks buyers' access and financial records. Why not keep content forever: our licence ends
  at termination.
- (e) BUILT for the demo; launch M.
- (f) COUNSEL (retention periods, surviving clauses).

### Q26. Who may suspend, and what happens to approvals already open (the 15 minute window gap)?

- SECURITY, OWNER DECISION.
- Built today: one operator with MFA suspends (rate limited, audited); offers are hidden; open quotes are expired; a quote taken
  before suspension can no longer be approved. KNOWN GAP pinned by a test: an approval already made can still be placed inside its
  15 minute window (assumption 32, P-A2).
- Options: O1 accept and document (no build; exposure at most 15 minutes, at most 2000 minor units per PayPal order). O2 `placeOrder`
  re reads publisher and offer status at place time and refuses with "not charged" (M on the money path after the freeze, Opus
  review). O3 suspension cancels open approvals at once (touches `domain/approval`, same promise change). For who suspends: one
  operator with MFA (built), a two person rule, or a per publisher kill switch (LATER).
- Trade off: O1 lets a suspended, possibly fraudulent, publisher receive a few payments for 15 minutes. O2 and O3 close it but change
  the A-08 promise that a frozen approval completes at the price shown (it would still keep the price, but could be refused).
- (f) Not counsel.

### Q27. Do publishers consent to our privacy notice and to use of their name and brand?

- (a) Demo: no consent flow; publishers are fictional and no real personal data is used (BUILT, item 67).
- (b) Launch: the agreement accepted in Q1 includes a privacy notice for publisher contacts (names, emails, payee id) and a brand
  licence to show the name, logo, titles and abstracts in the catalogue and in marketing, ending at termination.
- (c) Why: transparency duties for personal data, and the contest rules forbid third party trademarks in the video (item 66), which
  is another reason the demo brands stay fictional.
- (d) Why not real publisher names in the demo: needs permission and conflicts with the video rule. Why not a separate consent for
  each use: friction for no gain.
- (e) BUILT for the demo; launch S as part of AGREE-1 copy.
- (f) COUNSEL.

### Q28. Which governing law and dispute forum apply to the agreement?

- (a) Demo: none. The drafts say "not legal advice"; do not name a law in demo pages, because no legal entity exists yet.
- (b) Launch: the law and courts of the country where the UnitMarket operating company is set up, with a low cost route (arbitration
  or small claims) for small publishers; buyer facing terms follow the buyer's mandatory consumer law.
- (c) Why: naming a law without an entity or counsel could mislead.
- (d) Why not pick a well known law now: there is no entity to which it would apply.
- (e) HUMAN.
- (f) COUNSEL.

## 6. Scope

### Q29. What goes in the hackathon demo versus shown as roadmap?

- (a) Demo: agree with the coordinator's split, with three changes. (1) Payee verification is in the demo only as an operator check,
  labelled "not PayPal onboarding". (2) "Payouts" is not a roadmap item: the roadmap is direct settlement into each publisher's
  PayPal account; UnitMarket never pays out (D-004). (3) Suspension is in the demo (built and cheap to show).
- Demo set: click through acceptance record (Q1), operator payee check (built), offers revise and withdraw within the cap (built),
  dashboard, sales and statement with one honest settlement sentence (built plus PUB-E2), refunds by an operator (built; in a hosted
  recording only with a new approval row that lists the refund operations, otherwise show the offline run labelled Dry-run),
  suspension (built).
- Roadmap set: PayPal Partner Referrals onboarding and identity checks, direct payment per publisher (unless Q11 B), commission as a
  platform fee, dispute evidence pack and Disputes API, tax handling, offboarding with notice, notifications, team logins with MFA,
  upload and feeds.
- (c) Why: every demo item is built or one small lane away; every roadmap item needs PayPal partner approval, counsel or a money path
  change after the freeze.
- (d) Why not put identity checks or payouts in the demo: neither can be done honestly by 9 Nov.

### Q30. Should the video show a publisher onboarding flow, or only the dashboard?

- (a) Demo: the dashboard only, plus about 10 seconds on the agreement record and the operator's payee check, and one roadmap card
  naming PayPal Partner Referrals as the future onboarding.
- (c) Why: Presentation is one fifth of the score and the video is under 3 minutes; the buyer journey and the AI agent must carry it.
  An onboarding flow would need applicant approval and self sign up, and its payee step would be faked, which PayPal judges would
  spot.
- (d) Why not build onboarding: L after the freeze, a new sign up surface to secure, and a fake KYC step. Why not show no publisher at
  all: loses the two sided market story (Impact).
- (e) No build. Recording is HUMAN (item 66).

## 7. Summary table

| Q   | Short recommendation (demo)                                          | Build effort        | Owner decision |
| --- | -------------------------------------------------------------------- | ------------------- | -------------- |
| 1   | Click through acceptance record, versioned                           | S seeded, M AGREE-1 | Y              |
| 2   | No commission in demo; 20 percent as platform fee later   | BUILT, S terms      | Y              |
| 3   | Attestation per revision; personal use licence; instant withdraw     | BUILT, S terms      | N              |
| 4   | None in demo; PayPal onboarding at launch                            | BUILT               | N              |
| 5   | Seeded active; who approves is a security choice                     | none, O2 M          | Y (SECURITY)   |
| 6   | Shared publisher hash today; options listed                          | none, O2 or O3 M    | Y (SECURITY)   |
| 7   | Direct payment model; keep D-004                                     | none                | Y (confirm)    |
| 8   | Store merchant id, Business, corridor currency; method open          | BUILT               | Y (SECURITY)   |
| 9   | Operator check built; cooling off and notices open                   | BUILT, then M each  | Y (SECURITY)   |
| 10  | Auto pause at launch; no demo build                                  | M money path        | Y (timing)     |
| 11  | A labelled fiction stands unless B is chosen by Sun 1 Nov            | A none, B about 2 d | Y              |
| 12  | Seeded content; signed link and share panel if approved              | BUILT, S to M       | Y (other memo) |
| 13  | No review in demo; first articles reviewed at launch                 | BUILT               | N              |
| 14  | Publisher sets, cap 2000, 1.00 to 2.50 demo; corridor floor later    | BUILT               | N              |
| 15  | Buyers keep the version bought; content frozen                       | BUILT               | N              |
| 16  | Correction is a new article; takedown is withdraw plus full refund   | S terms             | N              |
| 17  | No payouts; PayPal pays publisher at capture; publisher bears fee    | BUILT               | N              |
| 18  | No commission line in demo; platform fee line at launch              | BUILT               | N              |
| 19  | No tax, no invoice in demo, say so; counsel before launch            | S                   | Y (COUNSEL)    |
| 20  | Operator decides; PayPal claws back; fee loss split in agreement     | BUILT               | N              |
| 21  | No Disputes API; evidence pack is the story                          | BUILT, M optional   | N              |
| 22  | Finish settlement sentence and totals; CSV optional                  | M plus S            | Y (asm 30)     |
| 23  | None in demo; email at launch                                        | none                | N              |
| 24  | Team contact address; best effort during judging                     | HUMAN, S            | Y              |
| 25  | Suspend built; offboarding in terms                                  | BUILT               | N              |
| 26  | Gap pinned; options listed                                           | O1 none, O2 M       | Y (SECURITY)   |
| 27  | Fictional brands; privacy and brand clause at launch                 | BUILT               | N              |
| 28  | No law named in demo                                                 | HUMAN               | N              |
| 29  | Demo: acceptance, payee check, offers, dashboard, refunds, suspend   | see section 8       | Y              |
| 30  | Dashboard only, plus a roadmap card                                  | none                | Y              |

## 8. Recommended demo scope

Build next, in priority order (about six lanes, roughly two lane days with three builders in parallel; none touches the money path):

1. PUB-E2 (M): one settlement sentence from `settlementMode` on S1, S6 and S7 (MT-6, P-B1, P-S1, P-S7, P-4L3). On the proposal's
   never cut list.
2. PUB-E3 (S): the sales page and statement agree, a totals row, one cross check test (MT-2, MT-3, P-E2). Needs the owners' call on
   assumption 30.
3. LEGAL-B (S): rewrite the publisher terms in `apps/web/src/lib/legal-copy.ts` and its golden: non exclusive, rights warranty and our
   licence, takedown by withdraw and refund, refunds and the kept PayPal fee, disputes and evidence, offboarding, commission line, no
   tax invoices, contact. Still marked draft and not legal advice.
4. AGREE-1 (M, or S if seeded and read only): publisher terms acceptance record on the dashboard (Q1, Q27).
5. PUB-E5 (S): article facts on the offer page (P-D1).
6. EVID-1 (M, optional): a read only evidence pack per unit for operators, and for publishers without buyer identity (Q21).
7. DOC-FIX (S): the README and submission lines below, and the transport claim in `docs/specs/overnight-plan.md` (MT-5).

The browser journey for the publisher pages (P-5T4) appears covered by HARD-E2E (`4331db2`, `apps/web/e2e/publisher-pages.spec.ts`
and others), merged after the traceability audit; confirm rather than rebuild. Only if the owners choose them: Q11 B (PUB-E1,
HARD-PAYEE, PAYEE-SCOPE, OWN-1) and Q26 O2 (ORDER-GAP).

Show as roadmap in the video (one card, about 15 seconds): PayPal Partner Referrals onboarding with PayPal's own seller checks; each
publisher paid directly by PayPal into its own account; commission as a PayPal platform fee; dispute evidence packs; tax handled with
an adviser; notifications and team logins with MFA; feeds and CMS plugins.

What the README and submission text should say honestly (draft lines for the owners):

- "Publishers are fictional. In this sandbox demo both selling publishers are paid into one sandbox test account that the team
  controls; multi-merchant payout is not demonstrated." (Replace with the Q11 B line only after a real order proves it.)
- "UnitMarket never holds a publisher's money and uses no payout service. The design pays each publisher directly through PayPal."
- "No commission in this demo; planned 20 percent, not implemented. Collecting it needs PayPal partner approval for platform fees."
- "Payee checks are done by an operator, not by PayPal onboarding."
- "Refunds are decided by an operator. PayPal keeps its original fee on a refund."
- "No tax is calculated and no tax invoice is issued in this demo."
- "Simulation and dry run results prove modelled cases only, not PayPal compatibility."

## 9. The five decisions that change the build the most

1. Q11 with Q7: stay on the labelled single account (no build) or prove a second merchant (about two lane days of money path work
   after a human creates an account, plus an owner sitting, all before Mon 2 Nov).
2. Q26: accept the 15 minute gap or close it in `placeOrder` (an M money path lane with an Opus review after the freeze, and a change
   to the A-08 promise).
3. Q1 with Q30: a seeded acceptance record (S) or a click through gate (M); and no onboarding flow in the video (saves an L lane and
   a fake KYC step).
4. Q12: seeded content plus the signed link and share panel (S to M) or upload in the console (L plus a security review).
5. Q6: keep the shared publisher passcode, or per publisher hashes or authenticator codes (M each, plus human key work and rotation
   after judging).

## 10. PayPal sources checked (30 to 31 Oct 2026)

| Page (title as shown)                                                                  | What it says, as used here                                                                                                                                                                       | Status                       |
| -------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------- |
| "Pay another account" (developer.paypal.com, Checkout standard customize)              | By default money is paid to the application owner's account; add a payee with an email address or merchant id to pay another account. Silent on consent, disputes and merchant of record.       | VERIFIED, read               |
| "PayPal Complete Payments Platform for Marketplaces and Platforms" (multiparty)        | Partner fees for commissions; seller sees "Partner commissions"; partner fees settle daily; test in sandbox with a standard developer account; go live after approval. Silent on tax and MoR.    | VERIFIED, read               |
| Multiparty overview, platform fee rules                                                | "Platform fee is not supported for first-party integrations"; partner must be enabled by PayPal.                                                                                                | Search summary of PayPal page |
| "Onboard sellers before payment" (multiparty seller onboarding)                        | "You must be an approved partner"; Partner Referrals; status shows merchant id, `payments_receivable` and `primary_email_confirmed`.                                                             | VERIFIED, read               |
| "Error Messages: Orders v2"                                                            | `PAYEE_NOT_CONSENTED`, `PAYEE_ACCOUNT_RESTRICTED`, `PAYEE_ACCOUNT_LOCKED_OR_CLOSED`, `PAYEE_ACCOUNT_NOT_VERIFIED`, `PAYEE_ACCOUNT_INVALID`, `PLATFORM_FEES_NOT_SUPPORTED` descriptions.          | VERIFIED, read (first part)  |
| "Customer Disputes v1" API index                                                       | List and show disputes; provide evidence, accept claim, make offer and other actions; settle and require evidence are sandbox only. Silent on partner access and deadlines.                     | VERIFIED, read               |
| "Payouts" (developer.paypal.com)                                                       | Payouts pays multiple recipients. Not needed: D-004 stands.                                                                                                                                     | VERIFIED, read               |
| "PayPal Business Fees" (US)                                                            | Checkout 3.49 percent plus 0.49 USD; micropayments 4.99 percent plus 0.09 USD; original fees not returned on refund; chargeback fee 20 USD; dispute fee 15 USD (30 USD high volume).            | VERIFIED, read               |
| "What is PayPal Seller Protection?" (US help article)                                  | Intangible goods need integration requirements, evidence of delivery as described, fees paid; covers item not received through PayPal and eligible unauthorised payments; not SNAD claims.      | VERIFIED, read               |
| "PayPal's Seller Protection Program" (US legal hub)                                    | Page did not load in full; not used beyond the help article.                                                                                                                                    | UNVERIFIED                   |
| "Will PayPal report my sales to the IRS?" (US help)                                    | 1099-K to account holders receiving goods and services payments above federal and state thresholds.                                                                                             | Search summary only          |

Not found on any PayPal page read: who is merchant of record in a multiparty integration; whether a partner can answer a seller's
dispute; the buyer filing window and seller response time for disputes; whether a Personal account can be an Orders v2 payee; whether
our sandbox app may pay a third party payee without consent (spike step 16). All stay UNVERIFIED.
