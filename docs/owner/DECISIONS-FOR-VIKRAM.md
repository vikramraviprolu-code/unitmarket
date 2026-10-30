# Decisions for Vikram to confirm (prepared 30 Oct 2026)

Sakthi gave a go-ahead on every item below as recommended (D-065). The work runs overnight on these as working
assumptions. Vikram: please read this list, say "confirmed" or name the item numbers you want changed. Only those
items are reworked. Items marked H need a human to act. The numbers match the list given in the session.

The official rules were pasted by Sakthi on 30 Oct 2026. Key points: PayPal sandbox plus an AI tool is required inside
the project; a working build must be runnable from the repo or hosted; the repo must be public with an open source
licence shown in its About section; the project must stay free and available until the Judging Period ends (15 Dec,
08:00 PT); judging runs 1 Dec to 15 Dec; the submission closes Thu 12 Nov, 12:00 PT (21:00 CET) and cannot be changed
after that; one Representative enters and receives the prize; the video is under 3 minutes, public on YouTube, no
copyrighted music, no third-party trademarks; the work must be solely owned by the entrant.

## Bucket 1. Decisions and human set-up (Fri 30 Oct to Sat 31 Oct)

| #   | Decision                        | Recommendation (working assumption)                                                                                 | Why                                                                                               |
| --- | ------------------------------- | ------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| 1   | Rules recorded as verified      | Yes, decision row D-065. Re-check Rules, Updates and FAQ tabs on 5 Nov and 11 Nov.                                  | Replaces the unverified status in D-045. The sponsor may amend the rules (section 11).            |
| 2   | Representative                  | Vikram (H)                                                                                                          | Owns the repo and the PayPal developer account. Prize and tax forms go to the Representative.     |
| 3   | Eligibility of each member      | Each confirms in writing: country, age, no PayPal or Devpost staff or relatives, not a judge (H)                    | An ineligible entrant can be disqualified after judging.                                          |
| 4   | Team ownership and prize split  | Short written agreement; no employer or university claim (H)                                                        | Rules require the work to be solely owned, with no other person holding rights.                   |
| 5   | Devpost registration            | Representative joins, adds the other member, saves a draft by Fri 6 Nov (H)                                         | No edits after the deadline; drafts are allowed before it.                                        |
| 6   | Which repo is the entry         | The sandbox repo only; the simulation repo stays private                                                            | Multiple submissions must differ substantially; the sandbox repo has the real PayPal integration. |
| 25  | Developer account               | Vikram keeps it until about 21 Dec, in writing (H)                                                                  | Sandbox app and credentials live under it; winners are announced around 21 Dec.                   |
| 26  | GCP budget alert                | USD 50 alert (H)                                                                                                    | Demo must stay free for judges; an alert warns of surprise cost.                                  |
| 29  | Second sandbox Business account | Yes, US Business, created by a human (H)                                                                            | Only way to show a payment into a separate merchant. Free; a fallback exists.                     |
| 60  | Fixtures (B-13)                 | Sakthi pulls main, re-runs `record:fixtures`, pushes `feat/transport-b13-fixtures`; coordinator checks it first (H) | Recorder bug is fixed; last open MVP-B item.                                                      |
| 63  | Vikram handover items           | Hosted passcode, PayPal test logins, `calls.json`, billing viewer, GitHub Admin (H)                                 | Only Vikram can supply them.                                                                      |
| 72  | Working pattern                 | Up to three builders at once, Opus review on every money-path lane (D-066)                                          | Disk is the limit (3.6 GB free), not cost.                                                        |

## Bucket 2. Cheap fixes with no money path

| #   | Decision                           | Recommendation                                                                                    | Why                                                                                     |
| --- | ---------------------------------- | ------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| 7   | Licence                            | Apache-2.0, unmodified LICENSE at the root, `package.json` field fixed                            | Rules need a licence GitHub detects. Apache-2.0 includes a patent grant.                |
| 8   | Dependency licence audit           | Yes, with a third-party notices file                                                              | Rules require compliance with every open source licence used.                           |
| 11  | README rewrite                     | Now: offline run in under ten minutes, optional own-credentials mode, real versus fixture, AI use | First thing judges and automated analysis read; run instructions are a rule.            |
| 42  | Phase 1A neutral screen fixes      | Resume, one Opus review                                                                           | Fixes real defects; clean base for the skins.                                           |
| 49  | Legal pages                        | Four static pages: terms, privacy, refund policy, publisher terms and sandbox disclaimer          | Design is scored on a complete product. We draft; owners approve; not legal advice (H). |
| 50  | Terms shown before the tick        | Yes                                                                                               | Consent to unseen terms is a trust and legal defect.                                    |
| 51  | Privacy notice on sign-in          | Yes                                                                                               | PRIV-6; real emails and IPs are processed.                                              |
| 45  | Receipt shows titles and publisher | Yes                                                                                               | A key video moment; article ids mean nothing to a buyer.                                |
| 46  | "No match" browse-all              | Yes                                                                                               | Search is the first thing a judge tries.                                                |
| 53  | Findings from the real test        | Fix receipt, library time statement, full order reference on `/ops`; rest if time allows          | Visible in the demo; cheap.                                                             |
| 54  | Payee id removed from buyer data   | Yes                                                                                               | A buyer has no need for the merchant id.                                                |
| 58  | Environment guard lane             | Opus re-review, fix the command-line tests, merge                                                 | Would have prevented the D-059 wrong-database incident.                                 |

## Bucket 3. Money path (before the Mon 2 Nov freeze)

| #   | Decision                        | Recommendation                                                                                                     | Why                                                                                                 |
| --- | ------------------------------- | ------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------- |
| 28  | Settlement option               | Quayside Gazette paid into its own sandbox Business account; Harbour Ledger stays on the owner's account; labelled | Shows real multi-merchant settlement. Unproven until one test order; fallback needs no code change. |
| 30  | Approval row for the test order | Narrow row: one order, named payee (last four only), cap 2000 minor units, one day (H, `safety:approve`)           | D-062 forbids any named payee. Narrow limits keep risk small.                                       |
| 31  | What the freeze covers          | Money-path code and the seal. Publisher screens and catalogue data stay open. Payee change only before 2 Nov.      | Protects what moves money and leaves room to finish the product.                                    |
| 32  | Payouts API                     | Keep D-004 (not used)                                                                                              | Would make UnitMarket a holder of publisher money; not required.                                    |
| 33  | Payouts box on the PayPal app   | Leave unticked (H)                                                                                                 | Least privilege.                                                                                    |
| 61  | Finish hosted payments          | Insert the D-062 row on the hosted DB, resume, connect on, run a real two-publisher pack before 3 Nov (H)          | Proves the hosted path; D-062 expires 3 Nov 12:00 UTC.                                              |
| 62  | Hosted rehearsal rows           | Leave and document                                                                                                 | Approval rows are append-only; deleting breaks the audit trail.                                     |

## Bucket 4. AI

| #   | Decision                        | Recommendation                                                                                                                                        | Why                                                         |
| --- | ------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| 13  | Real AI model in the app        | Yes: Claude adapter, brief and compose only, read-only tools, scripted fallback                                                                       | Rules require an AI tool; Stage 1 is pass/fail on it.       |
| 14  | Architecture decision row       | Replace "no Claude API ever" with a controlled exception                                                                                              | The design forbids what the rules require.                  |
| 15  | How it connects                 | One extra egress allow-list entry inside the transport package; key in Secret Manager (H); no new npm dependency; `ai_enabled` switch, off by default | Keeps the existing safety design with one narrow path.      |
| 16  | Model and spend                 | Haiku 5.5; total cap USD 20; daily cap USD 2; per-request token caps; scripted fallback at the cap                                                    | Cheapest adequate model; judges use it for about two weeks. |
| 17  | Agentic commerce framing        | Agent finds and composes within limits; a human approves every payment; honest about AI versus code                                                   | Targets two honorable mentions without overstating.         |
| 18  | Evals page                      | Yes, small: number of cases and a keyword baseline                                                                                                    | Evidence of genuine effort. First AI item to cut.           |
| 19  | Injection tests on real adapter | Yes; result in the README                                                                                                                             | Test set exists; a real model raises the stakes.            |

## Bucket 5. Publisher console

| #   | Decision           | Recommendation                                                           | Why                                                                           |
| --- | ------------------ | ------------------------------------------------------------------------ | ----------------------------------------------------------------------------- |
| 27  | Scope              | Must-have list in `docs/proposals/publisher-side-proposal-2026-10-30.md` | Answers "what does the publisher see?"; supports Design and Potential Impact. |
| 34  | Publisher passcode | Separate hash (H)                                                        | A leak allows only capped price edits.                                        |
| 35  | Price cap          | Tied to 2000 minor units                                                 | Already limits any one order.                                                 |
| 36  | Commission wording | "no commission in this demo; planned 20 percent, not implemented"        | Honest, and gives a business-model line.                                      |
| 37  | Demo prices        | 1.00 to 2.50 USD                                                         | PayPal's fixed fee can exceed a 0.40 sale.                                    |

## Bucket 6. Screens

| #   | Decision        | Recommendation                                                                      | Why                                                                                |
| --- | --------------- | ----------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| 38  | Style           | Bright Market and Deep Harbour as two switchable skins                              | Owner's choice; live switch is a demo moment; costs about one lane and doubles QA. |
| 39  | Default skin    | Bright Market                                                                       | Friendlier first impression; the video needs one fixed look.                       |
| 40  | Switch location | "Appearance" control in the footer, cookie                                          | Correct skin on load without a flash; no account needed.                           |
| 41  | Other options   | Archive A, B, C, F, G, H                                                            | Nothing is built from them.                                                        |
| 43  | Motion set      | Researched set; counts may animate, amounts never; no tilt or magnetic buttons      | Motion explains state; animated money invites doubt.                               |
| 44  | Reader view     | In-app reader with the time-left meter                                              | Raw text looks unfinished.                                                         |
| 47  | Approval step   | Stays still in both skins                                                           | The buyer is about to pay.                                                         |
| 48  | Sponsor tools   | Skip AG Grid, APIMatic, Bryntum, Channel3, Render; revisit 10 Nov only if all green | AG Grid needs inline styles our CSP forbids; Render means leaving GCP.             |

## Bucket 7. Close-out

| #   | Decision              | Recommendation                                                                                                                                           | Why                                                      |
| --- | --------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------- |
| 52  | Privacy export/delete | One small operator script and one test; cut first if short of time                                                                                       | Covers PRIV-3 and PRIV-4 cheaply.                        |
| 55  | Accessibility testing | axe-core as a dev-only dependency (D-008, O-2) plus a manual keyboard pass. Dependency pending Vikram's confirmation; the keyboard pass runs without it. | Design is scored; axe and keyboard runs were never done. |
| 56  | ZAP scan              | Sakthi runs it against a local copy (H)                                                                                                                  | Standard baseline; avoids the hosted app.                |
| 57  | Threat model          | One page from the architecture sections                                                                                                                  | Missing document; material exists.                       |
| 59  | Timing race tests     | Keep the D-045 waiver; two focused tests only if time allows (wording to be confirmed)                                                                   | Low risk against hours cost this late.                   |

## Bucket 8. Freeze, rehearsal, go public

| #   | Decision               | Recommendation                                                                                       | Why                                                                       |
| --- | ---------------------- | ---------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| 12  | Freeze and tag         | Feature freeze Fri 6 Nov evening; submit Mon 9 Nov; tag `submission-1`; no breaking pushes to 15 Dec | Deadline is Thu 12 Nov 21:00 CET; judges test the repo as it stands.      |
| 20  | How judges test        | Both: offline run from the repo and a hosted URL                                                     | Rules accept either; both covers a judge who cannot reach the hosted app. |
| 22  | Judge buyer account    | One dedicated sandbox Personal buyer; login in the testing instructions; rotate after judging (H)    | Rules allow sandbox logins; fake money only.                              |
| 23  | Dry-run fallback       | Labelled Dry-run path whenever live payments are off, label from stored data                         | No dead page; honest label.                                               |
| 24  | Demo passcode          | Separate passcode, rotated after judging (H)                                                         | Rules need credentials in the instructions for a private site.            |
| 66  | Video                  | Sakthi owns it; recorded Sat 7 Nov under its own approval row; under 3:00; no music; YouTube (H)     | Rules limits; Presentation is one fifth of the score.                     |
| 67  | No personal data shown | Sandbox accounts only; emails blurred; fictional publishers                                          | Post-deadline edits only remove personal data.                            |
| 64  | Rotate secrets         | After the video and before going public (H)                                                          | Anything exposed during building must be dead before the repo is public.  |
| 9   | Go public              | Sat 7 or Sun 8 Nov after a full-history secret scan; stays public to 15 Dec (H)                      | Late enough to scrub, early enough to fix.                                |
| 10  | Incident rows          | Publish after checking no values appear                                                              | Honest handling builds trust.                                             |
| 68  | Submission text        | Coordinator drafts by 5 Nov; owners approve (H)                                                      | Scored and unchangeable after the deadline.                               |
| 69  | Testing instructions   | Coordinator drafts; owners approve (H)                                                               | Rules require complete instructions and any test credentials.             |

## Bucket 9. Submit and buffer

| #   | Decision              | Recommendation                                                      | Why                                |
| --- | --------------------- | ------------------------------------------------------------------- | ---------------------------------- |
| 70  | WordPress             | Only the signed link and a static publisher page, if all else green | Plan's own cut rule keeps it last. |
| 71  | WordPress host, brand | Defer both                                                          | Only needed if item 70 goes ahead. |

## Bucket 10. Judging window

| #   | Decision                | Recommendation                                                                                                             | Why                                                  |
| --- | ----------------------- | -------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------- |
| 21  | Live payments window    | Hosted app Dry-run by default; live sandbox rows only 30 Nov to 15 Dec in three seven-day rows (30 Nov, 7 Dec, 14 Dec) (H) | Keeps D-056's seven-day maximum with three renewals. |
| 65  | Sakthi's extra GCP role | Remove `roles/storage.admin` after 3 Nov, add Viewer (H)                                                                   | Temporary grant; least privilege once stable.        |

## What the overnight work will not do (human or owner only)

No PayPal call and no approval row. No creation of accounts, keys or secrets. No deploy to Google Cloud (Sakthi runs
the deploy command prepared at the end). No YouTube upload. No repo visibility change. No tag.

## Status of each item at `a897c69` (30 Oct 2026, FINALISE-DOCS)

DONE means built and merged on `main` (or a decision taken and recorded). PARTIAL means some of it is built or drafted and the rest
is open. HUMAN-ONLY means a person must act; no agent may. Commit pointers are in `MORNING-HANDOVER-2026-10-31.md`. The ORDER-A
lane (buyer cancel of an unpaid order) is not an item here and is TO FINALISE on branch `feat/order-a-cancel`.

| #   | Status     | One line                                                                                                 |
| --- | ---------- | -------------------------------------------------------------------------------------------------------- |
| 1   | PARTIAL    | Rules recorded as D-065; the re-checks on 5 Nov and 11 Nov are a person's job                            |
| 2   | HUMAN-ONLY | Representative is chosen and registered by Vikram                                                        |
| 3   | HUMAN-ONLY | Each member confirms eligibility in writing                                                              |
| 4   | HUMAN-ONLY | Ownership and prize split agreement                                                                      |
| 5   | HUMAN-ONLY | Devpost registration and draft by 6 Nov                                                                  |
| 6   | DONE       | The sandbox repo is the entry; the simulation repo stays private                                         |
| 7   | DONE       | Apache-2.0 `LICENSE` on `main`; setting it in the About section waits for going public                   |
| 8   | DONE       | Licence audit and `THIRD-PARTY-NOTICES.md`; `check:licences` runs in `ci`                                |
| 9   | HUMAN-ONLY | Go public after the full history scan                                                                    |
| 10  | PARTIAL    | Incident rows D-059, D-061, D-063 are in the log; a person checks that no values appear before public    |
| 11  | DONE       | README rewrite with status, demo path, offline run and optional modes                                    |
| 12  | HUMAN-ONLY | Freeze, submit and tag `submission-1` are a person's actions                                             |
| 13  | PARTIAL    | Claude adapter merged and off by default; no key stored, no real AI call ever made                       |
| 14  | DONE       | D-067 replaces "no Claude API ever" with a controlled exception                                          |
| 15  | PARTIAL    | One fixed egress inside the transport package and the switch are built; the key is human only            |
| 16  | PARTIAL    | Spend caps and scripted fallback built; the model price needs an owner re-check (assumption 8)           |
| 17  | DONE       | Agentic framing is in the submission draft: the agent finds and composes, a person approves              |
| 18  | DONE       | Operator evals page merged                                                                               |
| 19  | PARTIAL    | Injection tests run against a stand in transport; nothing run against the real service, no README result |
| 20  | PARTIAL    | Path A (offline) is written and matches the README; the hosted path waits for a deploy                   |
| 21  | HUMAN-ONLY | Three seven day windows each need a new basis and approval row                                           |
| 22  | HUMAN-ONLY | Judge sandbox buyer account is created and rotated by a person                                           |
| 23  | PARTIAL    | Offline judge service prepared in the deploy kit (INFRA-A); a person must deploy it                      |
| 24  | PARTIAL    | Judge passcode merged (JUDGE-A); its value and rotation are human only                                   |
| 25  | HUMAN-ONLY | Vikram keeps the developer account until about 21 Dec                                                    |
| 26  | HUMAN-ONLY | GCP budget alert                                                                                         |
| 27  | DONE       | Publisher area merged: personas, offers, sales, statement, payee requests, operator page                 |
| 28  | HUMAN-ONLY | Quayside direct payee is not built or tested; needs a second account, a command and a new approval row   |
| 29  | HUMAN-ONLY | Second sandbox Business account is made by a person                                                      |
| 30  | HUMAN-ONLY | Narrow approval row inserted at a terminal                                                               |
| 31  | PARTIAL    | The freeze rule is recorded; the payee change is merged; ORDER-A (money path) is still unmerged          |
| 32  | DONE       | Payouts API not used (D-004 kept)                                                                        |
| 33  | HUMAN-ONLY | Leave the Payouts box unticked on the PayPal app                                                         |
| 34  | PARTIAL    | Separate publisher passcode hash built; one hash serves all three publishers; value is human only        |
| 35  | DONE       | Offer price cap `UMS_OFFER_MAX_MINOR`, default 2000 minor units                                          |
| 36  | DONE       | Commission wording in the drafts and legal pages                                                         |
| 37  | DONE       | Demo prices 1.00 to 2.50 USD applied as audited offer revisions                                          |
| 38  | DONE       | Bright Market and Deep Harbour merged as switchable skins                                                |
| 39  | DONE       | Bright Market is the default skin                                                                        |
| 40  | DONE       | Appearance control in the footer, cookie based                                                           |
| 41  | DONE       | Nothing built from the other options; previews kept under `docs/design/ui-options`                       |
| 42  | DONE       | Phase 1A screen fixes merged                                                                             |
| 43  | DONE       | Motion set merged with the skins; amounts never animate                                                  |
| 44  | DONE       | In app reader with the time left meter merged                                                            |
| 45  | DONE       | Receipt shows titles and publisher                                                                       |
| 46  | DONE       | Browse all when nothing matches                                                                          |
| 47  | DONE       | Approval step stays still in both skins                                                                  |
| 48  | DONE       | Sponsor tools skipped; the 10 Nov revisit is a person's call                                             |
| 49  | PARTIAL    | Four legal pages merged as drafts; the owners must approve them; not legal advice                        |
| 50  | DONE       | Terms are shown before the tick                                                                          |
| 51  | DONE       | Privacy notice on sign in                                                                                |
| 52  | PARTIAL    | Script is specified (`docs/specs/ops-privacy-export-delete.md`) and not written                          |
| 53  | PARTIAL    | Receipt and full order reference fixes merged; the library time statement was not re-checked here        |
| 54  | DONE       | Merchant id removed from buyer data                                                                      |
| 55  | PARTIAL    | Keyboard checklist written; the pass and the axe-core dependency are not done                            |
| 56  | HUMAN-ONLY | ZAP scan run by Sakthi on a local copy                                                                   |
| 57  | DONE       | Threat model at `docs/design/threat-model.md`                                                            |
| 58  | DONE       | Environment guard merged                                                                                 |
| 59  | PARTIAL    | D-045 waiver kept; the two optional timing tests are not written                                         |
| 60  | HUMAN-ONLY | Recorder fix merged (B-13); the fixtures push is Sakthi's                                                |
| 61  | HUMAN-ONLY | Finishing hosted payments needs the approval row and a real run before 3 Nov                             |
| 62  | DONE       | Rehearsal rows left and documented, because approval rows are append only                                |
| 63  | HUMAN-ONLY | Hosted passcode, test logins, `calls.json`, billing viewer, GitHub Admin                                 |
| 64  | HUMAN-ONLY | Rotate secrets before going public                                                                       |
| 65  | HUMAN-ONLY | Sakthi's extra GCP role is changed after 3 Nov                                                           |
| 66  | HUMAN-ONLY | Video recording under its own approval row                                                               |
| 67  | PARTIAL    | Publishers and articles are fictional; blurring emails in the video is a person's job                    |
| 68  | PARTIAL    | Submission text updated against `main`; owners approve; human only markers remain                        |
| 69  | PARTIAL    | Testing instructions updated against `main`; owners approve; human only markers remain                   |
| 70  | PARTIAL    | WordPress not started; the signed link branch is paused (D-064)                                          |
| 71  | DONE       | WordPress host and brand deferred as decided                                                             |
| 72  | DONE       | Working pattern under D-066; the builder cap was raised to six (assumption 20)                           |
