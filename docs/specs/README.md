# Specs index

Index of every file in `docs/specs/` at `origin/main` `7869114` (31 Oct 2026): 82 spec and plan files plus this index, grouped by lane family. "Merged" means
the lane's code (or, for a docs lane, its documents) is on `main`, checked against `git log origin/main` for the lane id in the
commit subjects. Planning files are marked "plan". The simulation specs (`docs/specs/sim/`) live in the simulation repository,
not here. The full status of each requirement is in `docs/REQUIREMENTS-REGISTER.md`.

## Spec protocol

One task, one spec, one branch, one review (CLAUDE.md, Spec protocol). A spec lives in `docs/specs/<package>-<task>.md`, stays
under one page, and lists its acceptance tests as commands with the expected output. The branch is `feat/<package>-<task>`; the
commit is `type(<package>): <what> (<lane id>)`. Commit 1 holds only tests and data and is run red; then the code is written to
green. A test is never edited to pass unless it contradicts the spec, and the report says so. A lane touches only the files its
spec lists and adds no dependency beyond D-008. A missing interface is a stop and report. Sonnet builds, Opus reviews, and nobody
merges their own work.

## Hosting and infrastructure

| File                                          | Title                                                                 | Lane         | Merged             |
| --------------------------------------------- | --------------------------------------------------------------------- | ------------ | ------------------ |
| `hosting-render-config.md`                    | Hosting as code (Render blueprint), names only, checked by a script   | CO-7         | yes                |
| `hosting-maintenance-mode.md`                 | Hosted maintenance mode (D-037, option a)                             | CO-7b        | yes                |
| `hosting-gcp-kit.md`                          | Google Cloud deployment kit                                           | GCP-1        | yes                |
| `hosting-gcp-kit-hardening.md`                | Google Cloud kit hardening after the first real deploy                | GCP-2        | yes                |
| `hosting-boot-follow-ups.md`                  | Hosted boot and capture bookkeeping follow-ups                        | PAY-1        | no (parked, D-054) |
| `infra-a-optional-secrets-offline-service.md` | Optional secrets and an offline judge service in the Google Cloud kit | INFRA-A      | yes                |
| `infra-hard-offline.md`                       | The offline judge service uses the judge passcode                     | HARD-OFFLINE | yes                |

## Database

| File                                | Title                                                     | Lane  | Merged |
| ----------------------------------- | --------------------------------------------------------- | ----- | ------ |
| `db-postgres-adapter.md`            | Postgres adapter for the database port                    | PG-1  | yes    |
| `db-postgres-wiring-races.md`       | Postgres wiring, loop leader and real-Postgres race tests | PG-2  | yes    |
| `db-single-opener-and-pg-waiver.md` | One opener per PGlite directory, the serialisation proof  | CO-9  | yes    |
| `db-backup-restore.md`              | Offline backup and restore round trip                     | CO-10 | yes    |

## Payments, jobs and access

| File                               | Title                                                               | Lane    | Merged |
| ---------------------------------- | ------------------------------------------------------------------- | ------- | ------ |
| `payments-refund-remaining.md`     | Refunds send an explicit amount checked against PayPal's remaining  | BU-4    | yes    |
| `payments-refunds-complete.md`     | Refunds complete: operator MFA, dashboard refunds, partial and full | CO-4    | yes    |
| `payments-webhook-intake.md`       | Webhook intake in payments: idempotent store, read-back only        | CO-2    | yes    |
| `jobs-poll-budget.md`              | Polling that cannot starve checkout of the daily call budget        | BU-5    | yes    |
| `jobs-abandon-not-found.md`        | A stale checkout whose PayPal order is gone is closed               | BU-9    | yes    |
| `order-a-cancel-resume.md`         | A buyer can cancel an unpaid order and resume payment               | ORDER-A | yes    |
| `access-clock-refund-interplay.md` | Access windows, lost-time credit and refunds                        | CO-5    | yes    |
| `access-clock-monotonic.md`        | Monotonic event time for the access log                             | CO-5b   | yes    |

## PayPal adapter and transport

| File                              | Title                                                     | Lane  | Merged |
| --------------------------------- | --------------------------------------------------------- | ----- | ------ |
| `paypal-own-payee.md`             | Leave our own payee out of create_order (D-028, option c) | BU-7  | yes    |
| `paypal-webhook-verify.md`        | Webhook self-verification in the PayPal adapter           | CO-1  | yes    |
| `paypal-webhook-cert-priority.md` | Certificate fetch priority for known URLs                 | CO-1b | yes    |
| `paypal-webhook-cert-learn.md`    | Webhook certificate pin, learn-only window (D-038)        | CO-1d | yes    |
| `transport-https-wire.md`         | Production Wire on `node:https`                           | BU-1  | yes    |
| `transport-recorder-docs-link.md` | The fixture recorder drops PayPal documentation links     | B-13  | yes    |

## Owner-run test kit

| File                         | Title                                                          | Lane  | Merged |
| ---------------------------- | -------------------------------------------------------------- | ----- | ------ |
| `testkit-sandbox-subject.md` | Owner-run sandbox conformance subject, gated by the five locks | BU-6  | yes    |
| `testkit-poll-rate.md`       | Cut the conformance approval poll rate                         | BU-8  | yes    |
| `owner-run-redact-ids.md`    | Owner-run call log redaction of merchant id and approval token | BU-6b | yes    |

## Configuration and security

| File                               | Title                                                             | Lane    | Merged |
| ---------------------------------- | ----------------------------------------------------------------- | ------- | ------ |
| `config-env-file-guard.md`         | Refuse a process environment that silently overrides `.env.local` | F8      | yes    |
| `config-overnight-names.md`        | Config names for the overnight lanes                              | CFG-0   | yes    |
| `passcode-hash-env-safe.md`        | Passcode hash survives `.env.local` loaders                       | BU-6c   | yes    |
| `security-operator-totp.md`        | Operator TOTP (RFC 6238) for refunds and switch changes           | CO-6    | yes    |
| `security-operator-totp-review.md` | Follow-ups from the review of operator TOTP                       | CO-6b   | yes    |
| `judge-a-passcode.md`              | A judge passcode that signs in buyers only                        | JUDGE-A | yes    |

## Web app

| File                              | Title                                                                                     | Lane            | Merged |
| --------------------------------- | ----------------------------------------------------------------------------------------- | --------------- | ------ |
| `web-unseal-outbound.md`          | Unseal: composition builds the approved transport behind the five locks                   | BU-2            | yes    |
| `web-next-start-proof.md`         | Prove the unsealed app boots and fails closed under `next start`, offline                 | BU-3            | yes    |
| `web-webhook-route.md`            | The public webhook route                                                                  | CO-3            | yes    |
| `web-refund-states.md`            | Refund and pending states in the web app, operator refund route                           | CO-8            | yes    |
| `web-refund-panel-review.md`      | Refund panel follow-ups from the re-review                                                | CO-8c           | yes    |
| `web-ux-phase1a.md`               | Screens phase 1A, the safe quick wins                                                     | UX-1A, L1       | yes    |
| `web-hard-e2e.md`                 | Browser coverage for publisher area, legal pages, passcodes, Appearance, reader, sign out | HARD-E2E        | yes    |
| `reader-a-view.md`                | In-app reader view with the time-left meter                                               | READER-A        | yes    |
| `skin-a-system.md`                | Skin system and the Bright Market skin                                                    | SKIN-A          | yes    |
| `skin-b1-bright-market-poster.md` | Bright Market poster look                                                                 | SKIN-B1         | yes    |
| `skin-b-harbour-motion.md`        | Deep Harbour skin and the shippable motion set                                            | SKIN-B, SKIN-B2 | yes    |
| `fix-docs-gate12.md`              | Copy and documentation fixes from the end to end gate                                     | FIX-DOCS        | yes    |
| `fix-flow-gate12.md`              | Flow fixes from the end to end gate                                                       | FIX-FLOW        | yes    |
| `fix-gate35.md`                   | Defects found by end to end gate 3 to 5                                                   | GATE35-FIX      | yes    |
| `fix-gatefinal.md`                | Defects from the final end to end gate (items 2 to 7)                                     | GATEFIX2        | yes    |

## MVP-C gate

| File                      | Title                                                       | Lane  | Merged |
| ------------------------- | ----------------------------------------------------------- | ----- | ------ |
| `mvp-c-offline-gate.md`   | MVP-C offline gate: acceptance twins, evidence, owner steps | CO-G  | yes    |
| `mvp-c-gate-hardening.md` | MVP-C gate hardening (tests and docs from the gate review)  | CO-Gb | yes    |

## MVP-D (two publishers in one approval)

| File                                   | Title                                                             | Lane  | Merged |
| -------------------------------------- | ----------------------------------------------------------------- | ----- | ------ |
| `mvp-d-overview.md`                    | Two publishers in one approval (composite), lane overview         | MVP-D | plan   |
| `mvp-d-open-questions.md`              | MVP-D decisions: by the coordinator, by the owner, and still open | MVP-D | plan   |
| `mvp-d-dp1-snapshot-gates.md`          | Composite snapshot gates, settlement route and supply data        | DP-1  | yes    |
| `mvp-d-dp2a-provider-orders.md`        | Provider orders for route D2, one PayPal order per publisher      | DP-2a | yes    |
| `mvp-d-dp2b-reconcile-continuation.md` | Background paths per provider order and pack continuation         | DP-2b | yes    |
| `mvp-d-dp2c-followups.md`              | Engine follow-ups from the DP-2b, DP-3 and DP-4 reviews           | DP-2c | yes    |
| `mvp-d-dp3-recovery-partial.md`        | Refunds per unit's PayPal order and the partial composite message | DP-3  | yes    |
| `mvp-d-dp4-ledger-receipts.md`         | Per-publisher ledger sums, INV7 and per-publisher receipt lines   | DP-4  | yes    |
| `mvp-d-dp5-web-composite.md`           | Composite in the web app: pack selection, two PayPal approvals    | DP-5  | yes    |
| `mvp-d-dp5b-order-page-fixes.md`       | Order page tone and cancel page                                   | DP-5b | yes    |
| `mvp-d-dp6-offline-gate.md`            | MVP-D offline gate: acceptance twins D-01 to D-07                 | DP-6  | yes    |

## Publisher side

| File                              | Title                                                                             | Lane    | Merged |
| --------------------------------- | --------------------------------------------------------------------------------- | ------- | ------ |
| `pub-a1-personas-shell.md`        | Publisher personas, migration 0012 and the publisher shell                        | PUB-A1  | yes    |
| `pub-a2-payee.md`                 | "Where you get paid" and operator payee verification                              | PUB-A2  | yes    |
| `pub-b-offer-revise-withdraw.md`  | Publisher offer revise and withdraw, demo prices                                  | PUB-B   | yes    |
| `pub-c-sales-statement.md`        | Publisher sales and statement read models, pages S4 and S5                        | PUB-C   | yes    |
| `pub-d-ops-publishers.md`         | Operator publishers page and suspend                                              | PUB-D   | yes    |
| `pub-e1-publisher-should.md`      | Publisher SHOULD features: CSV, refunds view, since your last visit, create offer | PUB-E1  | yes    |
| `pub-e2-applicants.md`            | Operator side of publisher onboarding, applicants                                 | PUB-E2  | yes    |
| `pub-e5-article-facts.md`         | Article facts on the offer pages                                                  | PUB-E5  | yes    |
| `pub-f1-sales-statement-agree.md` | Sales page totals agree with the statement                                        | PUB-F1  | yes    |
| `agree-1-agreement-record.md`     | Seeded, read-only record of each demo publisher accepting the terms               | AGREE-1 | yes    |

The settlement per block and the one settlement sentence on S1, S5, S6 and S7 merged as lane SETTLE-A, which has no spec file here.

## Legal

| File                         | Title                                                    | Lane             | Merged |
| ---------------------------- | -------------------------------------------------------- | ---------------- | ------ |
| `legal-a-pages.md`           | Legal pages, footer links and the sign-in privacy notice | LEGAL-A          | yes    |
| `legal-b-publisher-terms.md` | Publisher terms rewrite and honest docs                  | LEGAL-B, DOC-FIX | yes    |

## AI

| File                      | Title                                                       | Lane | Merged |
| ------------------------- | ----------------------------------------------------------- | ---- | ------ |
| `ai-a-model-adapter.md`   | Claude model adapter behind the model port, with spend caps | AI-A | yes    |
| `ai-b-evals-page.md`      | Operator evals page                                         | AI-B | yes    |
| `ai-h-model-hardening.md` | Model output and discovery hardening                        | AI-H | yes    |

## Operations and privacy

| File                           | Title                                      | Lane                            | Merged                                  |
| ------------------------------ | ------------------------------------------ | ------------------------------- | --------------------------------------- |
| `ops-privacy-export-delete.md` | Operator privacy script, export and delete | OPS-PRIV, built as HARD-PRIVACY | yes (the header still says "spec only") |

## Documents, repository and plans

| File                                | Title                                                                      | Lane     | Merged      |
| ----------------------------------- | -------------------------------------------------------------------------- | -------- | ----------- |
| `docs-a-threat-privacy-keyboard.md` | Threat model, privacy script spec, keyboard pass checklist                 | DOCS-A   | yes         |
| `docs-b-submission-deploy.md`       | Submission text, testing instructions and deploy preparation drafts        | DOCS-B   | yes         |
| `repo-compliance.md`                | Repo compliance: licence, dependency licence audit, README                 | L2       | yes         |
| `overnight-plan.md`                 | Overnight plan, 30 to 31 Oct 2026: lanes, file ownership, order and checks | SPECS-ON | plan        |
| `README.md`                         | This index                                                                 | DOCS-C2  | this branch |

## Business rules (UNI-80, D-096)

Design: `docs/business-rules/configurable-rules-design.md` (PR #8). Order: BR-1, then BR-2 and BR-10, then BR-3, then BR-4 and BR-6.

| File                           | Title                                       | Lane  | Merged |
| ------------------------------ | ------------------------------------------- | ----- | ------ |
| `br-1-rules-registry.md`       | Rule registry and pure terms resolver       | BR-1  | no     |
| `br-2-rules-settings-store.md` | Rule settings table and operator write path | BR-2  | no     |
| `br-3-terms-snapshot.md`       | Resolved terms frozen into the approval     | BR-3  | no     |
| `br-4-refund-window.md`        | Refund deadline from the frozen terms       | BR-4  | no     |
| `br-6-rules-screens.md`        | Operator "Business rules" screens           | BR-6  | no     |
| `br-10-rules-drift-check.md`   | Registry and reference stay in step         | BR-10 | no     |
