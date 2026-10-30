# Bible update pack, 23 Oct to 31 Oct 2026

This is a pack to paste, not the Bible itself. The UnitMarket Build Bible is a private document that Vikram holds; it is not in
this repository and no agent can open or edit it. Vikram copies the blocks below into the matching Bible sections. Every line
names its requirement id from `docs/REQUIREMENTS-REGISTER.md`, its decision row in `docs/decision-log.md`, or its item in
`docs/owner/DECISIONS-FOR-VIKRAM.md` (written DV-n), so the Bible can point back to the repository.

Written on 31 Oct 2026 (lane DOCS-C2, docs only) against `origin/main` at `7869114`. The base is the briefing of 23 Oct
(`docs/briefing/mvp-status-2026-10-23.md`). Nothing here was run against PayPal, Google Cloud or a hosted URL. Simulation, fixture
and dry run results prove the modelled cases only, not PayPal compatibility.

## 1. Scope

Paste under the Bible's scope section.

Added to scope since 23 Oct:

- MVP-B closed (BU-6, BU-6b, BU-6c, BU-8, BU-9). First real sandbox order created on 24 Oct (D-036); owner-run sandbox run
  on 26 Oct (`docs/evidence/mvp-b-sandbox-2026-10-26.md`).
- MVP-C: webhook route, certificate pin, refunds with operator MFA, maintenance mode, offline gate, hosted sitting on Google Cloud
  (CO-1d, CO-3, CO-6, CO-7b, CO-8, CO-G, MVPC-HOSTED). Closed on 29 Oct with conditions (D-054).
- MVP-D: two publishers in one approval, one PayPal order per publisher, offline gate and one real sitting (DP-1 to DP-6, DP-5b,
  MVPD-REAL; D-041, D-057).
- Hosting on Google Cloud Run with Cloud SQL Postgres (D-049), Postgres adapter and wiring (PG-1, PG-2), deploy kit (GCP-1,
  GCP-2).
- The publisher side, added by D-064: personas, payee requests, offers, sales, statement, operator page, applicants, CSV,
  refunds view, since your last visit, create offer, article facts, totals, settlement sentence, agreement record, publisher
  terms (PUB-A1 to PUB-F1, R-SET-1 to R-SET-3, R-PUB-1, R-LEG-3).
- An AI tool inside the product, off by default, under the D-067 exception (R-AI-1 to R-AI-7).
- Screens: skins, motion, reader view, buyer fixes, legal pages (R-SKN-1 to R-SKN-5, R-RDR-1, R-BUY-1 to R-BUY-14, R-LEG-1,
  R-LEG-2).
- Judging support: judge passcode, offline judge service, optional secrets (R-JUD-1, R-OFF-1, R-OFF-2, R-DEP-1 to R-DEP-3).
- Close-out: licence and notices, threat model, privacy script, browser coverage (R-HRD-1, R-HRD-2, R-HRD-4, R-PRV-1).

Out of scope or on hold:

- WordPress entry (MVP-E): on hold by the owner on 31 Oct; branches kept, nothing merged (R-PUB-8, DV-70, assumption 35). An
  entry paths research memo waits for owner approval (`docs/design/entry-paths-research-2026-10-31.md`).
- Paying Quayside directly into its own sandbox account: not built (R-PUB-3, R-PUB-4, DV-28, DV-30). Both selling publishers are
  paid into the owner's sandbox test account (D-041).
- Payouts API (D-004, DV-32), platform fees (P-4b2), Disputes API (P-G3), article upload (P-D3), notifications (P-H2).
- Multi-currency holding: captured, not scheduled (D-030).

## 2. Owners

Paste under the Bible's owners section.

| Role                            | Who                                                       | Source                                  |
| ------------------------------- | --------------------------------------------------------- | --------------------------------------- |
| Owner, Representative           | Vikram                                                    | DV-2; D-062                             |
| Operator on the hosted app      | Sakthi (from 29 Oct), and Vikram                          | D-062, D-063                            |
| Reviewer and merger, priorities | Sakthi                                                    | D-064; CLAUDE.md roles                  |
| Deploy commands                 | Sakthi, at his own terminal                               | `docs/owner/SAKTHI-DEPLOY-COPYPASTE.md` |
| Video                           | Sakthi                                                    | DV-66                                   |
| PayPal developer account        | Vikram, kept until about 21 Dec                           | DV-25                                   |
| Google Cloud account            | Vikram                                                    | D-049                                   |
| Approval rows                   | the owner at a terminal only                              | D-029, CLAUDE.md rule 2                 |
| Coordination                    | the coordinating session, no credentials for Google Cloud | D-049, D-066                            |
| Builders and reviewers          | Sonnet builds, Opus reviews; no credentials               | CLAUDE.md roles; D-066                  |

## 3. Dates

Paste under the Bible's dates section. All dates 2026 unless stated.

| Date                     | What                                                             | Source               |
| ------------------------ | ---------------------------------------------------------------- | -------------------- |
| Sat 31 Oct               | Vikram confirms or changes items 1 to 72                         | D-065                |
| Mon 2 Nov                | Money path freeze; payee change only before it                   | DV-31; `mvp-plan.md` |
| Tue 3 Nov 12:00 UTC      | Hosted outbound basis D-062 ends                                 | D-062; DV-61         |
| Thu 5 Nov and Wed 11 Nov | Re-check the Rules, Updates and FAQ tabs                         | D-065; DV-1          |
| Fri 6 Nov                | Feature freeze in the evening; Devpost draft saved               | DV-12; DV-5          |
| Sat 7 Nov                | Video recorded under its own approval row                        | DV-66                |
| Sat 7 or Sun 8 Nov       | Rotate secrets, full history scan, repository public             | DV-64; DV-9          |
| Mon 9 Nov                | Submit; tag `submission-1`                                       | DV-12                |
| Thu 12 Nov 12:00 PT      | Submission closes (21:00 CET); no change after                   | D-065                |
| 30 Nov, 7 Dec, 14 Dec    | Three seven-day judging windows, each with a new basis and row   | DV-21                |
| 1 Dec to 15 Dec          | Judging; the demo stays free and available until 15 Dec 08:00 PT | D-065                |
| About 21 Dec             | Winners announced; developer account kept until then             | DV-25                |
| 26 Jan 2027              | Webhook certificate pin expires; a new learn window is needed    | D-053                |

## 4. Requirements

Paste under the Bible's requirements section. Counts from `docs/REQUIREMENTS-REGISTER.md`.

| Part                                        | Rows | built and merged | partial | not built | human only | deferred |
| ------------------------------------------- | ---- | ---------------- | ------- | --------- | ---------- | -------- |
| MVP-B close, MVP-C, MVP-D (24 to 29 Oct)    | 37   | 31               | 0       | 2         | 3          | 1        |
| Overnight requirements (30 to 31 Oct)       | 73   | 54               | 4       | 5         | 8          | 2        |
| Publisher traceability, refreshed (103 ids) | 103  | 57               | 21      | 7         | 6          | 12       |
| Owner decision items 1 to 72                | 72   | 33               | 17      | 0         | 21         | 1        |

Publisher traceability moved from 44 built, 28 partial, 13 not built, 6 human only, 12 deferred (audit at `ded0380`) to 57, 21,
7, 6, 12. The rows still not built: P-D3 (add an article), P-4b1 (Quayside paid directly), P-4L4 (label for untested Quayside
refunds), P-5M5 (Supabase revoke), P-5S2 (owner set-payee command), DV-30 (approval row naming one payee), REF-S4 (publish
article).

Requirements still open, by family:

- Publisher: S1 period figures (P-S1, DV-27); sales filters (P-E2, P-S4); refund reason and operator left out on purpose (P-G2);
  rights and floor edit (P-C4); S7 exposure checked after a purchase (P-5T4, MT-3); approval window gap (R-PUB-5, P-A2).
- AI: one real call, the key and a price re-check (R-AI-8); injection tests against the real service (R-AI-9).
- Deploy: the deploy itself and the offline service (R-DEP-5, R-OFF-3); deploy prep names only migration 0012 (R-DEP-4).
- Close-out: keyboard pass (R-HRD-4), axe-core (R-HRD-5), ZAP (R-HRD-6), submission and testing drafts (R-HRD-7).
- Not built, from before the overnight work: PAY-1 hosted follow-ups (parked, D-054); the `maintenance.unconfigured` log line
  (D-044).

## 5. Risks

Paste under the Bible's risks section.

| Risk                                                                                      | Ids                    | Mitigation today                                                            |
| ----------------------------------------------------------------------------------------- | ---------------------- | --------------------------------------------------------------------------- |
| A PayPal judge sees one merchant: nobody is paid directly                                 | P-4b1, OW-2, DV-28     | Honest settlement sentence on S1, S5, S6, S7 (R-SET-2); fallback judge line |
| An approval made before a suspend or withdraw can still be placed in its 15 minute window | R-PUB-5, assumption 32 | KNOWN GAP test; suspension expires open quotes                              |
| No real AI call has been made; the rules ask for an AI tool                               | R-AI-8, DV-13          | Adapter merged, off by default, scripted fallback                           |
| Nothing built overnight is on the hosted app                                              | R-DEP-5                | Offline run from the repository (Path A)                                    |
| The hosted app cannot finish a purchase outside an approval window                        | R-OFF-1, assumption 21 | Offline judge service, once deployed by a person                            |
| Stale lines say the privacy script is not merged                                          | R-PRV-1                | Fix in `README.md`, the submission drafts and the spec header               |
| Deploy prep names only migration 0012; 0013 to 0015 are also forward only                 | R-DEP-4                | Backup first (deploy prep step 2)                                           |
| The model price for the caps is from a cached reference                                   | R-AI-4, assumption 8   | Safety factor of 2; owner re-checks                                         |
| One publisher passcode hash serves three publishers                                       | R-PUB-7, assumption 18 | Prices capped and frozen per approval; payee not editable by a publisher    |
| A named payee is stopped by data and process, not by the locks                            | MT-5, R-PUB-4          | Both publishers hold the owner id; verify refused outside a dry run         |
| LGPL sharp library in an Apache-2.0 repository                                            | R-HRD-3, assumption 13 | Exact allow-list entry with a reason; owner confirms                        |
| Real-Postgres race tests are waived per sitting, not closed                               | PG-2, D-045            | A new row is needed before the app stays live for judging                   |

## 6. Decisions

Paste under the Bible's decisions section. One line per row of `docs/decision-log.md` since the briefing; the log is the record.

| Row   | Date   | One line                                                                                      |
| ----- | ------ | --------------------------------------------------------------------------------------------- |
| D-033 | 23 Oct | Dashboard facts; receiving preference set to keep the original currency                       |
| D-034 | 23 Oct | Read-only spike Part R ran: token 200, not-found read 404, 2 of 40 calls                      |
| D-035 | 24 Oct | MVP-B first order approval basis, scope `mvp_b_polling`, 2000 minor units per order           |
| D-036 | 24 Oct | Payee echo check passed: PayPal echoes our own merchant id                                    |
| D-037 | 25 Oct | Hosted maintenance mode (option a)                                                            |
| D-038 | 25 Oct | Webhook certificate pin: learn only                                                           |
| D-039 | 25 Oct | Three acceptances for the MVP-C sitting                                                       |
| D-040 | 25 Oct | TOTP keys only in host settings and own env files; shared demo passcode accepted; two waivers |
| D-041 | 25 Oct | MVP-D payee setup: both publishers paid into the owner's sandbox account, `payee_shared` flag |
| D-042 | 25 Oct | MVP-D approval row terms and race test waiver                                                 |
| D-043 | 26 Oct | Certificate learn window at most 60 minutes                                                   |
| D-044 | 26 Oct | Unset maintenance flag warns, does not refuse boot (log line not built)                       |
| D-045 | 26 Oct | Race tests waived for the hosted sitting only                                                 |
| D-046 | 26 Oct | Two documented limits of MVP-C accepted                                                       |
| D-047 | 26 Oct | One MVP at a time                                                                             |
| D-048 | 26 Oct | Working limits after the cost review                                                          |
| D-049 | 26 Oct | Hosting on Google Cloud Run and Cloud SQL Postgres                                            |
| D-050 | 26 Oct | `pg` driver approved as a dependency                                                          |
| D-051 | 26 Oct | Wording rule: "not charged" only for declined, failed or abandoned orders                     |
| D-052 | 27 Oct | Outbound basis for the MVP-C hosted window                                                    |
| D-053 | 27 Oct | Webhook certificate pinned from the learn window                                              |
| D-054 | 29 Oct | MVP-C closed with conditions; MVP-D unparked; PAY-1 parked                                    |
| D-055 | 29 Oct | Basis for an extension of the hosted window (dropped by D-056)                                |
| D-056 | 29 Oct | Extension dropped; hosted app fails closed after D-052                                        |
| D-057 | 29 Oct | Outbound basis for the MVP-D real sitting on the owner's laptop                               |
| D-058 | 29 Oct | Full history secret scan: 10 reviewed false positives                                         |
| D-059 | 29 Oct | Incident: terminal settings pointed at the hosted database; nothing reached PayPal            |
| D-060 | 29 Oct | D-057 start time moved earlier                                                                |
| D-061 | 29 Oct | Hosted demo passcode hash exposed and rotated                                                 |
| D-062 | 29 Oct | Hosted outbound basis to 3 Nov 12:00 UTC; Sakthi becomes operator                             |
| D-063 | 29 Oct | Operator key list repaired; one setup key exposed and rotated                                 |
| D-064 | 30 Oct | Priorities: screens, publisher side, gap review, then WordPress; three agents                 |
| D-065 | 30 Oct | Official rules recorded; items 1 to 72 taken as working assumptions                           |
| D-066 | 30 Oct | Overnight working rules                                                                       |
| D-067 | 30 Oct | Controlled AI exception: one model API host inside `packages/transport`                       |
| D-068 | 31 Oct | Requirements register, specs index, architecture addendum and this pack written as docs only  |

D-032 is an approval reference used by D-034; it has no row of its own in the log.

Owner decisions still open, to record in the Bible once taken: DV-28 and DV-30 (Quayside own account and its approval row),
assumption 30 (mismatch counted on the sales page), assumption 32 (approval window gap), assumption 36 (withdrawn offer page),
assumption 35 (entry paths memo), DV-55 (axe-core under D-008), assumption 13 (sharp LGPL), and a new row before the app stays
live for judging without the race tests (D-045).
