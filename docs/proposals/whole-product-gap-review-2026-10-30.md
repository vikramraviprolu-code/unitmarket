# UnitMarket whole-product gap review (30 Oct 2026)

Status: REVIEW ONLY. Nothing is built from this. Written by an Opus read-only reviewer; saved by the coordinator. The reviewer
read SBX `main` at `b83c5a8` and the original requirement documents in the simulation repository (reference only). It did not
run the app or the tests, made no PayPal call and opened no env file. The planning document was not available, so the "20 agreed
requirements" cited in `docs/briefing/mvp-status-2026-10-23.md` section 8 and `docs/design/mvp-plan.md` could not be checked.

## Headline: four gaps that matter more than WordPress and the publisher console

The official rules were read on 20 Oct (summary in the simulation repository, `docs/REFERENCE.md` line 142). They say the
project must integrate the PayPal developer platform (free sandbox) with an AI tool, be a public repository with a visible
open source licence, and have a working demo. SBX today fails or risks each:

1. No LICENSE file; `package.json` says `"license": "UNLICENSED"`; the README still describes the lane 00 scaffold.
2. No real AI: only a scripted model (`packages/model/src/scripted.ts`); `docs/design/architecture.md` line 67 says no Claude
   API in this design. Whether a scripted model meets "with an AI tool" is a human judgement to confirm on the rules page.
3. The hosted demo stops taking payments when its approval row expires (D-056: at most 7 days per row; D-062 ends 3 Nov), and
   judging runs 1 to 15 Dec. No judge payment path is documented.
4. No terms, privacy or refund pages; the buyer ticks terms without seeing them.

## 1. How the publisher side dropped out (date order)

- 19 Oct, planning document Rev 11: PAY-01 puts publisher onboarding UI out; PAY-11 puts the seller dashboard and admin out; PAY-07 still
  required one purchase unit per publisher with its payee.
- 19 to 20 Oct, simulation: seller screens S1 to S7 were built anyway (merged as #34, #37, #44, #49, each "requirement id
  pending"), so the register had no row to carry them forward. Simulation `docs/DEFERRED.md` kept only "WordPress as the
  publisher on-ramp".
- 21 Oct, SBX baseline: architecture names `/publisher/*`, route rule `publisher`, "publisher content upload in MVP-E only", but
  `mvp-plan.md` schedules no publisher lane and no acceptance test names a publisher screen. D-3 no commission, D-005 WordPress
  after the first MVP, ASM-06 buy and refund only.
- 23 Oct briefing section 8 recorded "partly built: publisher agreements, commission split, onboarding" but it became neither a
  lane nor a decision row.
- 25 Oct, D-041: both fictional publishers paid into the owner's one account. 26 Oct, D-047 and D-048 narrowed work to the money
  gates. 29 Oct UX review scored buyer and ops screens only. 30 Oct, D-064 added the publisher side to scope.

Process causes (not people): the source scope put it out; the simulation built it outside the register; SBX builds only what an
acceptance test names; MVP-E was the only "publisher" item so the plan looked publisher-aware; no traceability matrix from the
original requirements to the SBX MVPs. Visible symptom: the sign-in "Publisher" persona signs in as the first publisher and lands
nowhere (`SignInForm.tsx:9`, `composition.server.ts:1124-1128`).

## 2. Gap matrix

Status: B built, P partial, M missing, DD deliberately deferred or changed. Importance: J judges, PP PayPal story, T trust, L
legal or rules. Effort: S about one lane (half a day with review), M two to three lanes, L four or more. Ord: suggested order.

| #   | Requirement or workflow                      | SBX status and evidence                                                                               | Imp    | Eff   | Ord   |
| --- | -------------------------------------------- | ----------------------------------------------------------------------------------------------------- | ------ | ----- | ----- |
| 1   | Public repo, open source licence, demo       | M. No LICENSE; UNLICENSED; visibility not verified                                                    | L,J    | S     | 1     |
| 2   | Honest README                                | M. Describes the lane 00 scaffold                                                                     | J,T    | S     | 1     |
| 3   | Hosted demo live to 15 Dec                   | P. Cloud Run host; checkout fails closed after approval expiry (D-056)                                | J,PP   | S+own | 1     |
| 4   | Judge can pay at the sandbox                 | M. No documented sandbox buyer login for judges                                                       | J,PP   | S     | 1     |
| 5   | AI agent, evals                              | P. Scripted model only; prompts and read-only tools exist; no Claude adapter                          | J,L    | M+dec | 2     |
| 6   | Evals page, developer panel                  | P. `/ops` has orders, alerts, invariants; no evals page                                               | J      | S     | 7     |
| 7   | Publisher onboarding                         | M. Only operator or seed sets `payee_verified_at`                                                     | J,PP,T | M     | 3     |
| 8   | Seller dashboard (sales, fees, net, refunds) | M. Ledger stores sale, paypal_fee, refund; `publisherBalances` feeds only INV7                        | J,PP,T | M     | 3     |
| 9   | Settlement statement                         | DD (D-004). No statement either                                                                       | PP,T   | S     | 3     |
| 10  | Offer management (price, versions, withdraw) | M. Versioned in schema; only the seed writes                                                          | J,T    | M     | 5     |
| 11  | Publish article / upload                     | M                                                                                                     | J      | M-L   | late  |
| 12  | Catalogue admin by operator                  | M. Seed runs only on an empty DB                                                                      | J      | S-M   | 5     |
| 13  | Separate payee per publisher                 | DD (D-041). Named payee blocked by seal (D-028)                                                       | PP     | S+M   | 4     |
| 14  | Platform fee / commission                    | DD (D-3). No business-model story                                                                     | J,PP   | S/L   | 4     |
| 15  | Price rules ($1 floor)                       | DD. Real sitting used 0.40 and 0.90; PayPal fixed fee can exceed the price (`fee_above_amount` alert) | J,PP   | S     | 4     |
| 16  | Supply: publishers, articles, rights log     | B. 3 fictional publishers, 10 articles                                                                | J      | -     | -     |
| 17  | Reader brief                                 | B. Deterministic parser                                                                               | J      | -     | -     |
| 18  | Veto rules                                   | B, changed form                                                                                       | T      | -     | -     |
| 20  | Consent                                      | B but terms ticked, not shown (`DiscoverForm.tsx:138`)                                                | T,L    | S     | 2     |
| 21  | Orders, capture, read-back, webhooks         | B. Real single and two-publisher sittings; real decline not attempted                                 | PP     | -     | -     |
| 22  | Delivery, three states                       | B                                                                                                     | T      | -     | -     |
| 23  | Reading experience                           | P. Raw text/plain; no reader view                                                                     | J      | S     | 6     |
| 24  | Receipt                                      | B but shows article ids, no titles or publisher                                                       | J,T    | S     | 2     |
| 25  | Entry paths                                  | B for offer page and discover; static sample publisher page not built                                 | J      | S     | 8     |
| 28  | Refund per unit                              | B. Operator decides; publisher never sees it                                                          | T      | S     | 3     |
| 29  | Dispute handling                             | M. Reversal handled manually                                                                          | T      | L     | leave |
| 30  | Legal pages                                  | M. None in `apps/web/src/app`                                                                         | L,T,J  | S     | 2     |
| 31  | Privacy export and delete (PRIV-3, PRIV-4)   | M. No script                                                                                          | L      | S-M   | 9     |
| 32  | Accessibility (A11Y-1 to 7)                  | P. axe and keyboard runs not run                                                                      | J,L    | S-M   | 8     |
| 33  | Security close-out                           | P. ZAP not run; threat model missing; receipt API returns `payee_merchant_id`                         | T      | S-M   | 8     |
| 34  | Observability and support                    | B mostly; alert e-mail never provoked                                                                 | T      | S     | 9     |
| 35  | Search quality                               | P. "No match" dead end; every card "Good fit"                                                         | J      | S     | 6     |
| 36  | Buyer accounts                               | DD (D-040), fine for judging                                                                          | J      | -     | leave |
| 37  | E-mail and notifications                     | M                                                                                                     | T      | M     | leave |
| 38  | WordPress entry (MVP-E)                      | Paused (D-064). E-L1 tests committed, code drafted                                                    | J      | 3.5 d | last  |
| 40  | Video under 3:00 on real captures            | M (MVP-F)                                                                                             | J      | owner | 9     |

## 3. Top ten gaps (smallest credible fix, and whether it comes before WordPress)

1. Rules compliance of the repository (rows 1, 2): LICENSE (MIT or Apache-2.0, owner's choice) and matching `package.json`; a
   one-screen README (what it is, the 3-minute demo path, real versus fixture, safety design in five lines, offline run);
   final secret scan; make the repo public after the owners review which decision-log incident rows they will publish
   (D-059, D-061, D-063). Before WordPress: yes.
2. A judge can use the demo until 15 Dec (rows 3, 4): decide the judging window policy (renewal calendar of rows of at most 7
   days, or one row with a small cap and call budget for 1 to 15 Dec); a dedicated sandbox Personal buyer for judges whose login
   goes only into the submission form; a labelled dry-run fallback when checkout is paused; a judge rehearsal from a fresh
   browser. Before WordPress: yes.
3. The AI half (rows 5, 6): a Claude adapter behind the existing ModelPort, compose and brief only, read-only tools, scripted
   fallback when the key is absent or `ai_enabled` is off, AI-4 caps, an evals page showing n and the keyword baseline. Needs
   owner decisions first (revise architecture section 1, a dependency or HTTP path outside the PayPal transport per rule S2, a
   spend cap, key location). If the answer is no, the README must say plainly which AI tool the project uses and how.
4. Publisher console v1, read only (rows 7, 8, 9, 28): one persona per publisher; `/publisher` with offers, sales per unit (date,
   title, gross, observed PayPal fee, refunds, net); a truthful settlement line; a downloadable statement. No new money logic.
   This is what MVP-E pretends to be. The Opus publisher proposal (`publisher-side-proposal-2026-10-30.md`) covers it in depth.
5. Money truth for publishers (rows 13 to 15): second sandbox Business account and spike step 16 (about 1 hour); if it works,
   one reviewed payee lane before the 2 Nov freeze, else keep the D-041 wording; raise demo prices to at least 1 to 2 USD; show
   "platform fee: none in this demo".
6. Legal and trust pages (rows 20, 30): four static pages (terms of purchase, privacy, refund policy, publisher terms plus a
   sandbox disclaimer), footer links, and terms disclosed at the tick.
7. Receipt, order page, reader view (rows 23, 24, 35): UX review plan items Q3, P2, M5 and "browse all"; a simple in-app reader
   with the window meter.
8. Publisher offer management and catalogue admin (rows 10, 12): "change option price" writes a new offer version; withdraw;
   operator payee verify. Article upload stays out.
9. Accessibility and security close-out (rows 32, 33): axe or manual keyboard and VoiceOver on the five-step flow; ZAP baseline;
   a one-page threat model; drop `payee_merchant_id` from the buyer receipt JSON.
10. Privacy rights (row 31): one operator script exporting and pseudonymising a buyer's rows, keeping ledger and receipts; one test.

Also: the simulation repository plans to go public on 8 Nov too, so the owners must pick one entry repo and say what the other
is. SBX has only the money-path dependency freeze (Mon 2 Nov, `mvp-plan.md:9`); a feature-freeze date needs a decision row.

## 4. Fine to leave out (with reason)

Payouts API (D-004); real platform fees via Partner Referrals (needs partner enablement); real publisher onboarding or KYC (out
in the planning document; operator-set `payee_verified_at` is honest if labelled); article upload (needs the security controls of
architecture item 16); buyer sign-up (D-040); e-mail; Disputes API; DRM; UK and India corridors (D-002, D-030); Supabase (Cloud SQL
works, D-049); WordPress plugin and feed import (the plan's own cut rule, `mvp-plan.md:227`); standing mandates, demand pricing,
PDF passport.

## 5. Recommended sequence (Fri 30 Oct to Thu 12 Nov)

About 10 lane-days with three agents at once (D-064); fits by Fri 6 Nov only if decisions land on 30 or 31 Oct.

- Fri 30 to Sat 31 Oct: owner decisions (publisher v1 scope; AI yes or no; licence and entry repo; judging approval policy and
  judge buyer account; second sandbox merchant; SBX feature-freeze date). Screens stream continues. Legal pages lane.
- Sun 1 to Mon 2 Nov: publisher console v1 read only; if a second merchant is approved, owner spike step 16 and one payee lane
  before the freeze; raise demo prices and show the fee line.
- Tue 3 to Wed 4 Nov: D-062 expires Tue 3 Nov 12:00 UTC, so a new row for testing and recording; Claude adapter and evals page
  (or an honest AI statement); offer price change and withdraw; reader view.
- Thu 5 Nov: accessibility run, ZAP, threat model, merchant-id redaction; README, judge guide, LICENSE.
- Fri 6 Nov: feature freeze in the evening; video sitting under its own approval row; privacy script.
- Sat 7 to Sun 8 Nov (MVP-F): rotate secrets, full-history gitleaks, make repo public, clean clone pass, judge rehearsal.
- Mon 9 Nov: submit. Tue 10 to Thu 12: buffer; MVP-E only if all green, and only E-L1 and a static publisher page.
- 1 to 15 Dec: approval renewals on the agreed calendar; daily uptime check.

Cut order if short of time: WordPress; article upload; offer editing (keep read-only console); second merchant (keep D-041 wording);
evals page (keep adapter and README table); privacy script (document the operator procedure). Never cut: licence and public repo,
honest README, the judge-usable hosted demo, legal pages and the receipt fix, the read-only publisher console, the video, and the
AI decision whichever way it goes.

## 6. What the reviewer could not verify

The planning document and its 20 agreed requirements; the current rules text (D-045: not yet verified by us; confirm on the
hackathon page whether "with an AI tool" can be met by a scripted model, the licence and public-repo requirement, and the demo
running to 15 Dec); GitHub visibility of this repository; the current hosted app state; whether PayPal's fee exceeded the 0.40
sale in the real sittings; overlap with in-flight work; whether the simulation's seller screens were meant as reference; any
runtime behaviour (the Northfield publisher sits in a disabled GB corridor and may not be buyable); how judges get a sandbox
buyer login within the owners' credential rules. Decision-log rows are needed for: the judging approval policy, a Claude API
(architecture section 1 revision), a new dependency (D-008), and the feature-freeze date.
