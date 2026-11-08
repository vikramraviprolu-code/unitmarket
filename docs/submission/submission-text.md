# Devpost submission text: draft for the owners (DOCS-B, finalised against main)

Status: DRAFT 4, updated on 8 Nov 2026 against `main` at commit `75916ff3`. The live build is tag `gcp-pub-14` (commit `d5b5d92b`). The owners approve every word
(decision items 68 and 69, D-065). The submission closes Thu 12 Nov 2026, 12:00 PT (21:00 CET) and cannot be changed after that.

How to read this file:

- Each claim is followed by where it can be checked, in square brackets.
- A line that starts with **TO FINALISE** is not true yet or needs a person to act. It is a slot for something planned, on a branch, or human only.
  Delete the line or fill it in only after the feature has merged and a reviewer has seen it work. Do not leave the marker in the
  Devpost form.
- Wording rules: no italics, no dashes, only PayPal and Claude named as third party tools, no personal data, no credentials.
- Real, fixture and simulated are said plainly. Simulation and fixture results prove the modelled cases only, not PayPal
  compatibility in general.

## Project name and tagline

Name: UnitMarket Sandbox (the PayPal sandbox track of UnitMarket).

Tagline (under 60 characters): Buy just the article you need, pay each publisher.

## Inspiration

Readers who want one article today are asked to take a whole subscription. Publishers lose the casual reader and readers lose
the money they never spend. UnitMarket asks a smaller question: what if you could say what you need and what you will pay, see
articles that fit, and pay only for those, with each publisher paid for its own article?

Why PayPal: an agent that spends money needs a payment rail that has a clear approval step, a verifiable record and a safe test
environment. The PayPal sandbox gives all three without real money.

## What it does

A buyer states a need and a price ceiling. The app finds articles that fit and composes a pack within the limits. The buyer sees
what will be charged before anything happens. A human approves every payment. A pack with two publishers is paid as two separate
PayPal payments, one per publisher, and access opens only after the payment is verified and delivery is verified to be possible.
The buyer gets a library with a time left meter and a receipt. An operator has a console with a safety gate, a Stop button, a
refund form and checks that must hold.

Publishers have their own side. A publisher is invited, claims an account, accepts the publisher terms and links its own PayPal
address, which an operator verifies. A publisher can import articles from a web link it proves it controls, review them, and
publish offers. UnitMarket adds a platform fee of 10 percent of the publisher price on top, so the publisher does not pay it. The
publisher sees its sales and a statement. Payouts to publishers are built and tested in dry run only. [`docs/specs/pob-p1-publisher-accounts.md`,
`docs/specs/pob-m1-fee-and-payout.md`, `docs/specs/pob-i1-web-import.md`, `apps/web/src/pob-journey.state.test.ts`]

Agentic commerce, said honestly: the agent finds and composes within limits you set. It never pays. A person approves every
payment on a page that shows the frozen price, the publishers and the number of payments. The agent has no PayPal data and no
payment tools. [`docs/design/architecture.md` sections 1 and 7; decision D-067; `docs/owner/DECISIONS-FOR-VIKRAM.md` item 17]

What is AI and what is code:

- Code, not AI: the money path (order creation, capture, read back, ledger, refunds), the approval and the safety gate with its
  five locks, the access clock, delivery checks and receipts. [`domain/payments`, `domain/approval`, `packages/safety`]
- Scripted model, not AI: by default the brief parser and the pack composer are a deterministic scripted model, and no AI call is
  made. [`packages/model/src/scripted.ts`, `README.md` status]
- The Claude adapter is merged and off by default. When a person sets `UMS_AI_ADAPTER=claude` and a key, Claude reads the buyer's
  need and proposes the pack, with read only tools, no PayPal data, a hard spend cap, a stop switch and a fall back to the scripted
  model. It has one fixed outbound address, reachable only from the transport package. The adapter has been tested only against a
  scripted stand in; no real AI call has ever been made. [`packages/model`, decision D-067, specs AI-A and AI-H]
- An operator evals page shows the evaluation cases, a verdict for each and a keyword baseline, run against the scripted model and
  recorded results. [`/ops` evals page, spec AI-B]
- **TO FINALISE (AI-A, human only):** a person must store the key, switch the adapter on for the hosted demo and make one real call
  before this text may say that Claude runs in the demo. If that is not done, say so: the rules ask for an AI tool inside the
  project, so the owners must decide how to present this before 12 Nov.

## What is real, what is a fixture, what is simulated

| Part                                     | State                                                                                                                                                                                                                                                                                                                                                                                        |
| ---------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| PayPal sandbox orders, approval, capture | Real, observed. A pack of two items was paid as two separate sandbox payments on 29 Oct 2026. [`docs/evidence/mvp-d-real-sitting-2026-10-29.md`]                                                                                                                                                                                                                                             |
| Hosted purchases on Google Cloud         | Real sandbox purchases and a refund path were observed on 27 and 28 Oct 2026 [`docs/evidence/mvp-c-hosted-2026-10-28.md`]. On 7 Nov 2026 the owner ran a third sitting on the hosted app under D-108: one sandbox purchase of 1.00 USD, paid, receipted, shown in the library, with a working download. All PayPal locks were closed again afterwards. [`docs/decision-log.md` D-108, D-111] |
| Dry run                                  | Real code on a pretend PayPal (recorded or synthetic fixtures), labelled "Dry run" from the stored environment. Covered by the six offline test suites and browser journeys.                                                                                                                                                                                                                 |
| Publishers and articles                  | Fictional. Harbour Ledger Review and Quayside Gazette are demo imprints with demo articles. [`domain/catalogue/src/seed-data.ts`]                                                                                                                                                                                                                                                            |
| Money accounts                           | Sandbox accounts only. No real money moves.                                                                                                                                                                                                                                                                                                                                                  |
| Payee checks                             | Done by an operator by hand, not by PayPal onboarding.                                                                                                                                                                                                                                                                                                                                       |
| Commission                               | On offers published through the web import, UnitMarket adds a platform fee of 10 percent of the publisher price to the price shown; the publisher does not pay it. Seeded demo offers carry no fee. The fee is recorded in the ledger. Every sale in the demo is paid into one sandbox test account, so PayPal splits no money.                                                              |
| Publisher money                          | By design the buyer pays UnitMarket's collection account and UnitMarket pays the publisher after the access window ends with no refund open (D-089). That payout step is built and tested in dry run only. No payout runs against PayPal, and all sandbox sales are paid into one test account that the team controls.                                                                       |
| Refunds                                  | Decided by an operator, for each unit. PayPal keeps its original fee on a refund.                                                                                                                                                                                                                                                                                                            |
| Tax                                      | No tax is calculated and no tax invoice is issued in this demo.                                                                                                                                                                                                                                                                                                                              |
| Legal pages                              | Four drafts for owner approval, including plain English publisher terms. Not legal advice. [`/legal/publisher-terms`, spec LEGAL-B]                                                                                                                                                                                                                                                          |

Said plainly, whichever settlement line is used: "Publishers are fictional. In this sandbox demo both selling publishers are paid
into one sandbox test account that the team controls; multi-merchant payout is not demonstrated. By design the buyer pays
UnitMarket's collection account and UnitMarket pays the publisher after the access window ends with no refund open; that payout step is
built and tested in dry run only, and no payout runs against PayPal. On offers published through the web import, UnitMarket adds a
platform fee of 10 percent of the publisher price to the price shown; the publisher does not pay it, and seeded demo offers carry no fee.
Payee checks are done by
an operator, not by PayPal onboarding. Refunds are decided by an operator, and PayPal keeps its original fee on a refund. No tax
is calculated and no tax invoice is issued in this demo. Simulation and dry run results prove modelled cases only, not PayPal
compatibility." [`docs/design/publisher-questions-recommendations-2026-10-31.md` section 8, `/legal/publisher-terms`]

Settlement line (use exactly one, after the owners check the evidence file):

- If Quayside's own sandbox account has been proven by a real order: "Quayside Gazette is paid by PayPal directly into its own
  sandbox account. Harbour Ledger is our own test imprint, paid into the owner's sandbox account. By design UnitMarket pays the
  publisher after the access window (dry run only today)."
- Otherwise, and this is the state on `main` today (decision D-041; the 29 Oct evidence shows both publishers paid into the same
  sandbox Business account): "Both publishers are paid into one sandbox test account; multi-merchant payout not demonstrated."

**TO FINALISE:** which of the two lines applies is decided by the Quayside test order (decision item 28 and 30). That order is a
human run under a new approval row. This draft does not assume it happened.

## How we built it

- A Next.js 15 and React 19 web app in TypeScript, with domain packages for catalogue, discovery, fit, approval, payments,
  entitlements, access clock, delivery, ledger, receipts, recovery and library. [`apps/web`, `domain/*`]
- A strict layering: only one transport package may open a network connection; only the PayPal package talks to it; the sandbox
  address is one constant; a check fails the build if a live PayPal host appears. [`CLAUDE.md`, `pnpm check:no-live-host`]
- Offline by default: the dry run transport answers from fixtures, so anyone can run the full buyer journey with no credentials.
  Reaching the PayPal sandbox needs five locks to be open: sandbox mode, the connect flag, an active approval row inserted by a
  human at a terminal, the kill switch, and credentials with a clean self check. [`README.md` safety design; architecture section 7]
- A PostgreSQL 16 database (PGlite in memory or on disk offline, Cloud SQL when hosted), with append only audit and ledger tables.
- Hosting on Google Cloud: Cloud Run with one instance, Cloud SQL, Secret Manager and Cloud Build, deployed only by a human with a
  script. [`infra/gcp/`]
- Six test suites (unit, state, contract, integration, adversarial, golden) and Playwright browser journeys that run offline.
- Built with AI help during the submission period: coding sessions with Claude produced and reviewed much of the code under a
  written spec, tests first, and human review rules. [`CLAUDE.md`, `docs/specs/`]

## Challenges we ran into

- Paying more than one publisher with one approval. A pack needs one PayPal order per publisher, each approved and captured on its
  own, with a clear "Step 2 of 2" for the buyer and a safe stop between the two. The first real run paid two separate payments
  correctly. [`docs/evidence/mvp-d-real-sitting-2026-10-29.md`]
- Staying safe while testing against a real service. We built the two key approval, a kill switch, a call budget and a rule that
  an approval row is append only. We also had incidents and wrote them down: a terminal that pointed at the wrong database, and
  secrets pasted into a chat that were rotated within the hour. [`docs/decision-log.md` D-059, D-061, D-063]
- Honest settlement. Paying a second, separate merchant needs a second sandbox account and a payee check by hand. We say which
  parts are demonstrated and which are not. [`docs/proposals/publisher-side-proposal-2026-10-30.md` section 4]
- Fees. PayPal's fixed fee can exceed a very small sale, so the demo prices are set in the range 1.00 to 2.50 USD (decision item
  37), applied as audited offer revisions. [spec PUB-B]

## Accomplishments that we are proud of

- A real pack paid as two PayPal sandbox payments, read back and verified before any access opened. [evidence file above]
- Fail closed everywhere: no live mode exists in the code, boot refuses any value naming live or production, and the repository
  holds no credentials. [`pnpm check:no-live-host`, `pnpm check:secrets-names`]
- A complete operator side: safety gate, Stop button, refunds behind an authenticator code, invariants that must hold.
- Every claim in this text has a file or a check behind it.
- A publisher area: invite, claim, sign in, terms, a PayPal address that an operator verifies (one verified address per publisher,
  enforced by the database), web import with a domain proof, offers that a publisher revises or withdraws within a price cap, a
  sales page and a statement. An operator page shows each publisher's exposure and can suspend a publisher. One automated test walks
  the whole publisher journey in dry run, from apply to refund. [specs PUB-A1 to PUB-D, POB-P1, POB-M1, POB-I1, POB-W]
- Every release is verified in full before it is deployed: static checks, six test suites (about 13,300 tests), a production build,
  200 browser journeys and a check of the append only transaction journal, run on the exact tree that is then deployed.
- Two switchable skins with the Appearance control and a small motion set, an in app reader with a time left meter, sign out and
  navigation per role, and four draft legal pages. [specs SKIN-A, SKIN-B, READER-A, LEGAL-A]

## What we learned

- A payment agent is mostly a safety design problem. The useful question is not "can it pay" but "what must be true before any
  call leaves the app, and how does a human stop it".
- Read back everything. A PayPal response is a claim; the ledger and the receipt follow the verified read back, not the response.
- Keep fixtures and reality apart in the open. Labels come from stored data, never from a guess.
- Small, spec first lanes with an independent review caught money path mistakes before they merged.

## What's next

- Prove a second merchant by paying one publisher into its own sandbox account, then say so. (Not done.) Run a payout to a publisher's own sandbox account. (Not done: payouts are dry run only.)
- Partner features that this demo does not use: platform fees collected through PayPal. The 10 percent fee is recorded in the
  ledger only, and the payout to a publisher is dry run only.
- Not built: a real payee check by PayPal (an operator checks the address by hand today). A privacy export and delete script is
  merged and runs only from the owner's terminal. **TO FINALISE:** a reviewer should see it work before the submission says more
  than that.
- More publishers and a real catalogue of rights.

## Built with

PayPal sandbox (Orders and webhooks), Next.js, React, TypeScript, Node.js, PostgreSQL, PGlite, Zod, Vitest, Playwright, Google Cloud
Run, Cloud SQL, Secret Manager and Cloud Build. **TO FINALISE:** add Claude (Anthropic) as the AI model only after the adapter
has merged and is switched on. Claude is also named under "How we built it" as a coding tool.

## Links to fill in at submission

- Repository: public GitHub URL (Representative, after the secret scan; decision items 9 and 64).
- Hosted demo URL: `https://unitmarket-sandbox-626887286871.europe-west3.run.app` (Cloud Run, tag `gcp-pub-14`). Browser sign-in works only on this address.
- Video: public YouTube link, under 3 minutes (decision item 66).
- Testing instructions: paste `docs/submission/testing-instructions.md`, with the credential placeholders replaced in the Devpost
  form only.
- Licence: Apache-2.0. The `LICENSE` file, the README and the notices file are on `main`. **TO FINALISE (human only):** set the
  licence in the repository About section when the repository is made public.

## Open questions for the owners

1. Is the Claude adapter on for the hosted demo? On 8 Nov 2026 the deploy of `gcp-pub-14` reported `UMS_AI_ADAPTER` and
   `UMS_ANTHROPIC_API_KEY` with no value, so the adapter is off and no AI model runs on the hosted app. The rules require an AI tool
   inside the project. The owners decide before 12 Nov: switch it on (a human stores the key, one real call, a deploy that leaves the
   PayPal connection off), or say plainly that it is off.
2. Which settlement line applies (see above)?
3. Who is the Representative and who is listed as team members (items 2 to 5)?
4. Do you approve the wording of "Built with AI help" under How we built it?
