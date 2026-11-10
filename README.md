# UnitMarket

UnitMarket lets people and AI agents buy just the content they need, one unit at a time, for a few cents, instead of paying for a whole subscription. A buyer, or an agent holding a spending cap the buyer set, states a need and a price ceiling. UnitMarket proposes a pack that fits, a person approves, and each publisher in the pack gets its own **PayPal sandbox** payment. Every money, delivery, cap and control change is written to a tamper-evident journal that an operator can verify.

This is our entry for the PayPal AI Hackathon, "Build what's next with PayPal and AI".

- Hosted demo: https://unitmarket.live (a **sandbox** build with test money; browser sign in works only on that address; see "The hosted demo" below).
- Demo video (under 3 minutes): `[TODO after upload: public video URL]`
- Licence: Apache-2.0 (`LICENSE`). Third-party licences: `THIRD-PARTY-NOTICES.md`.

Built during the submission period, which starts on 1 Oct 2026. The first commit in this repository is dated 21 Oct 2026.

> **Real, dry run, simulated.** PayPal is used in **sandbox only** (test money), and only in sittings run by the owner under a two-key approval. Everywhere else the app runs in **Dry run**: the same code against a pretend PayPal, with the label taken from stored data. The micro-ledger, netting, buyer and seller pools, matching and rebates are **simulated** in a separate model and never touch PayPal. No real money moves anywhere. All publishers and articles are fictional.

## The problem and the idea

A reader who wants one article is asked to buy a whole subscription. An AI agent that needs one answer has the same problem. Small purchases do not happen because the payment cost is bigger than the purchase: in our model, a seven cent sale paid on its own at PayPal's standard published rate costs about forty-nine cents in fees.

UnitMarket is built on two ideas, which we call the pillars:

1. **Micro-trades by AI agents.** Agents buy in 5 to 10 cent pieces. A ledger records each trade and nets many trades into a few PayPal payments, so a low fee per trade is made up by volume.
2. **Consolidation of buyers and sellers.** Buyers who want the same unit share one payment (buyer pools). Small publishers group on a topic to fill bundles none could fill alone (seller pools). UnitMarket matches the two sides.

The model is like ride-hailing: UnitMarket gathers demand and supply and does the matching, and PayPal is the settlement layer that moves the money. This repository is the working product slice. The pillars at scale are shown in our simulation (see "What is simulated").

## What is real, dry run and simulated

| Part                                            | Status                                                                                                                                                                                                                                                                                                                                                                          |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Buyer payments in the PayPal sandbox            | **Real, test money.** On 29 Oct 2026 a pack from two publishers was paid as two separate sandbox payments, run from the owner's laptop (`docs/evidence/mvp-d-real-sitting-2026-10-29.md`). On 7 Nov 2026 the owner made one sandbox purchase of one article for 1.00 USD on the hosted app under the approval basis D-108 (recorded in `docs/decision-log.md`, D-108 and D-111) |
| Where sandbox sales are paid                    | Every sandbox sale is paid into one sandbox test account that the team controls. Paying a second merchant into its own account is not demonstrated                                                                                                                                                                                                                              |
| Publisher payouts                               | **Dry run only.** The payout step is built and tested; its only implementation is the pretend one. No payout runs against PayPal, and real PayPal payouts are not built                                                                                                                                                                                                         |
| Refunds                                         | Decided by an operator, per unit, behind a second factor. No refund is sent to PayPal in a sitting                                                                                                                                                                                                                                                                              |
| Tax                                             | Not calculated. No tax invoice is issued; a receipt is a record of the sale                                                                                                                                                                                                                                                                                                     |
| Micro-ledger, netting, pools, matching, rebates | **Simulated** in a separate model, never connected to PayPal and not part of this repository                                                                                                                                                                                                                                                                                    |
| Publishers, articles, buyers                    | Fictional                                                                                                                                                                                                                                                                                                                                                                       |

Simulation and fixture results prove the modelled cases only, not PayPal compatibility in general.

## What works today

Everything in this table is merged on `main`. The live build at the time of writing is tag `gcp-pub-17`, `main` at commit `ea7bd701` (Cloud Run revision `unitmarket-sandbox-00044-pgs`, deployed on 10 Nov 2026, `docs/decision-log.md` D-119). `gcp-pub-17` adds to the web import one permanent proof code per publisher for all of its sites, operator vouching for an address (second factor and a reason, audited) and removal of an address (D-116).

| Area                                   | State                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| -------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Buyer journey                          | Need and ceiling, proposed pack, approval with a frozen price and frozen terms, one payment per publisher, library, receipt. Access opens only after a verified capture. Buyers can sign up with a username and password                                                                                                                                                                                                                                                                                                                                                      |
| PayPal sandbox payments                | Real, observed in the owner's sittings (see the table above): create order, approval, capture and read back                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| Dry run (default)                      | Real code against a pretend PayPal, labelled "Dry run" from the stored environment. No account and no credential needed                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| Public API and agent buying            | API keys with scopes; buyer, seller and operator endpoints; signed event webhooks (delivered to an in-process sink in this build, with no outbound web call); an MCP server with six tools (`search_catalogue`, `get_offer`, `propose_pack`, `open_unit`, `check_budget`, `buy_unit`). Decisions D-088, D-091, D-093                                                                                                                                                                                                                                                          |
| Agent spending caps                    | The buyer sets a money cap, a purchase-count cap, a per-purchase maximum and an expiry for one agent key, from the API or from the buyer's Agents page (D-101). The agent can never create, widen or revoke its own cap. 20 concurrent buys on a 5-purchase cap give exactly 5 orders (D-093)                                                                                                                                                                                                                                                                                 |
| Agent buying in the sandbox            | In the sandbox, `buy_unit` stops and returns `buyer_approval_required` with a UnitMarket page where the buyer approves. It calls nothing on its own. The fully automatic agent path runs in the dry run only                                                                                                                                                                                                                                                                                                                                                                  |
| Buyer screens                          | Home, Agents (create and revoke caps), Spending with CSV, order timeline, receipts, approvals inbox, API keys                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| Publisher accounts                     | A publisher applies on a public form. An operator approves and is shown a one time invite code. The publisher claims an account with it, signs in with a username and password, accepts the publisher terms with a real action, and links their own PayPal address, which an operator verifies. UnitMarket never creates a PayPal account for a publisher (D-089). Three fictional demo publishers keep their own sign in                                                                                                                                                     |
| Publisher web import                   | A publisher proves they control a web address (a meta tag or a fixed file), then UnitMarket reads items, pictures and prices into a staging list. The publisher picks, edits and publishes; published items become articles and offers with a hosted copy of the content. The reader is deterministic and hand written, with no AI. Fetches are limited to the verified domain over https and public addresses, with no redirects. Live fetching runs only while its own switch, `web_import_enabled`, is on (D-115)                                                          |
| Publisher (seller) area                | Publisher home, offers that a publisher can revise or withdraw as new versions within a price cap, sales list and sale detail without buyer identity, statement, payee change requests checked by an operator. The statement shows sale, UnitMarket fee, owed and paid out                                                                                                                                                                                                                                                                                                    |
| Platform fee on top                    | The buyer pays the publisher's price plus UnitMarket's fee; the publisher does not pay it. The default is 10 percent (D-089, D-096), rounded half away from zero. An operator can change the rate from 0 to 30 percent with a reason and a second factor. It applies only to offers published through the web import; seeded demo offers and hand-made offers carry no fee. Each sale freezes its own split, so a later change never alters a sale, and the ledger records the fee and the publisher share                                                                    |
| Refund window                          | Enforced. A buyer can ask for a refund until the deadline in the sale's frozen terms (7 days by default, counted from the start of access, D-096). After it an operator refunds only with a stated override reason, which is written to the audit trail (`docs/specs/br-4-refund-window.md`)                                                                                                                                                                                                                                                                                  |
| Payouts to publishers (dry run)        | After the access window of a sale has ended with no refund open, a job pays the publisher's share to their verified PayPal address, one payout per publisher and currency, once, in the dry run only. A refund inside the window stops the payout; a refund after a payout is taken off the next one. Operations shows payouts due, sent and failed (`docs/specs/pob-m1-fee-and-payout.md`)                                                                                                                                                                                   |
| Seller chosen currency and corridors   | A seller picks USD, EUR or GBP for each new offer it creates (imported items stay USD; per batch import currency comes later, D-113). Migrations 0033 and 0034 set six corridors: us-usd, gb-gbp and de-eur cover every country except India; in-usd, in-eur and in-gbp serve India publishers, buyers outside India only. All six are enabled live (owner check). Real EUR or GBP sandbox purchases are not demonstrated: dry run only, as are payouts, and no money conversion (D-117; `docs/specs/db-ww-corridors.md`, `docs/specs/catalogue-offer-currency.md`)           |
| Transaction journal and `trace:verify` | One append-only, hash-chained table, written in the same database transaction as each tracked change, with the actor, channel and origin (D-097). `pnpm trace:verify` detects an edited row and names it                                                                                                                                                                                                                                                                                                                                                                      |
| Operator console                       | Home with health lights and a needs-you list; alerts that raise and resolve on their own; cases; order page with timeline and evidence pack; transactions search with saved views and CSV; quick-find; activity log; publishers and applicants; payee requests; payouts; the platform fee; evals                                                                                                                                                                                                                                                                              |
| Controls                               | Gateway panel with the five locks, outbound approval gate, services, feature switches, and an API exposure screen that turns API groups and MCP tools on or off (`403 api_disabled`, D-102)                                                                                                                                                                                                                                                                                                                                                                                   |
| Business rules                         | A rules registry with platform, seller and buyer scopes; a journaled settings store; operator screens to view, change, explain and export rule history as CSV. Each sale freezes the terms in force in its approval snapshot, so a later rule change does not alter it                                                                                                                                                                                                                                                                                                        |
| Buyer cancel of an unpaid order        | The order page offers Continue to payment and Cancel for an unpaid order; cancel is refused once a payment has started                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| Reader view                            | Articles open in the app with a time left meter and a per reader rate limit                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| Two skins and the Appearance control   | Bright Market and Deep Harbour, chosen in the footer                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| AI model adapter (Claude)              | Merged and **off by default**. It is off on the hosted app. See "AI" below                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| Integrated story and tamper demo       | One offline test runs the whole story in the dry run: a person buys from two publishers, an agent buys $0.10 units over MCP under a $5 cap and a 10 purchase limit, a download link is issued, an operator refunds one item behind a second factor, an alert is raised, acknowledged and closes on its own, the agent uses all 10 purchases, the 11th is refused with `cap_exhausted` and writes no money row, and `trace:verify` exits 0. The tamper demo edits a ledger amount and then a journal row, and `trace:verify` names each edit (`docs/demo/integrated-story.md`) |

Not built: real PayPal payouts, a second merchant paid into its own account, tax calculation, and money conversion between currencies.

## The hosted demo

The hosted app at https://unitmarket.live runs in **Sandbox** mode: the label on every page says so and comes from stored data. It uses test money only.

- Browser sign in works only on that address. Sign in at `/signin`. Judges use the judge passcode given in the submission form, which signs in Buyer A or Buyer B only.
- The hosted app calls the PayPal sandbox only while the owner has a sitting open under the two-key approval. A deploy resets the connect flag to off. With the flag off, checkout is paused and nothing is charged (`docs/decision-log.md` D-056, D-111). For a complete purchase at any time, use the offline path below.
- The Claude adapter is off on the hosted app, so the scripted model composes packs there.

## Try it offline in under ten minutes

You need Node 22.22.0 (see `.nvmrc`) and Corepack. No account and no credential are needed. Run these in a normal terminal window.

```sh
corepack pnpm install --frozen-lockfile
corepack pnpm owner:secrets
```

`owner:secrets` asks for a demo passcode of at least 12 characters, twice, and prints four `NAME=value` lines. It needs a real terminal and refuses in CI. Create `apps/web/.env.local` (ignored by git), paste the four lines into it, and add these three lines:

```sh
UMS_MODE=offline
UMS_PUBLIC_ORIGIN=http://localhost:3000
NEXT_TELEMETRY_DISABLED=1
```

Then build and start:

```sh
corepack pnpm --filter @umsbx/web build
corepack pnpm --filter @umsbx/web start
```

Open `http://localhost:3000`. The page shows "Dry run". `http://localhost:3000/healthz` answers `{"ok":true,"environment":"dryrun"}`. Rebuild after every `git pull`.

### Three minute demo path

1. Sign in at `/signin` as Buyer A with your demo passcode.
2. On `/discover` type a need and a ceiling, for example `harbour charges and the quayside market, under $5`, then choose Find articles.
3. Tick the terms of purchase, select one article from each publisher and choose Buy selected together.
4. On the approval page read the two blocks (one per publisher) and the line "2 payments". Choose Continue to payment.
5. On the pretend PayPal pages approve payment 1 of 2, see "Step 2 of 2", then approve payment 2 of 2.
6. The order page shows each article as ready. Open the library and the receipt.
7. Open `/buyer/agents` to set a spending cap for an agent key, and `/buyer/spending` to see what was spent.
8. In a fresh browser window sign in as Operator with the same passcode and open `/ops`: the order timeline, alerts, transactions, `/ops/controls` (the five locks and the Stop button) and `/ops/rules`. Refunds and some switches need an authenticator code, which this README does not set up.

To see the whole story and the tamper proof without clicking, run the commands in `docs/demo/integrated-story.md`. They use an in-memory database, make no network call and need no credential.

To see the publisher side without clicking, run `corepack pnpm vitest run apps/web/src/pob-journey.state.test.ts`. It walks one publisher from application to payout on an offline app: apply, approve, claim, terms, PayPal link, web import from a scripted web, publish, a buyer purchase, the fee, the dry run payout, the statement and a refund that stops a payout. It makes no network call.

### Agent story from a terminal

`docs/demo/mvp1-api-demo.md` walks through the API and MCP steps in the dry run: create a buyer key, set a cap, let an agent buy until the cap stops it.

### Optional sign-ins

- **Publisher demo personas.** The three fictional publisher sign-ins (Harbour Ledger, Quayside Gazette, Northfield Quarterly) use their own passcode. Run `corepack pnpm owner:secrets` again with a different passcode, keep only the `UMS_DEMO_PASSCODE_HASH=` line, paste it into `apps/web/.env.local` renamed to `UMS_PUBLISHER_PASSCODE_HASH=`, and restart. On `/signin` choose a publisher and use the field labelled "Publisher passcode".
- **Publisher accounts.** A new publisher applies at `/apply`. As Operator, approve the applicant at `/ops/publishers`; the one time invite code is shown there once. The publisher claims the account at `/signin/seller/claim`.
- **Judge.** `UMS_JUDGE_PASSCODE_HASH`, made the same way with a third passcode, signs in Buyer A or Buyer B only. Operator and publisher sign-ins refuse it.

Every variable holds a hash, never the passcode. Names are listed in `.env.example`.

### Checks you can run without any credential

```sh
corepack pnpm test:unit            # one of six suites: unit, state, contract, integration, adversarial, golden
corepack pnpm test:e2e             # browser journeys on the dry run; build the app first
corepack pnpm check:no-live-host   # fails if a live PayPal host appears anywhere
corepack pnpm check:secrets-names  # fails if a public variable name could carry a secret, or .env.example holds a value
corepack pnpm trace:verify         # checks the journal hash chain of the app's database; stop the app first
corepack pnpm run ci               # every offline check, several minutes
```

On the earlier commit `172e5c7a` the full offline run passed 5,275 unit, 4,047 state, 379 contract, 687 integration, 2,377 adversarial and 592 golden tests, plus 200 browser journeys and the trace check (verified on 9 Nov 2026). For `gcp-pub-16` only a lighter check was run before merge: 210 test files and 3,245 tests passed on a tree identical to the deployed commit `3b079523` (main combined with PRs 81 and 82), with typecheck, lint, fixtures, isolation, no-live-host, secrets-names and openapi checks passing; the full six suites and the browser gate were not run (D-117). `gcp-pub-17` added one lane checked with its own 354 tests and the static checks (D-119). Browser journeys and the trace check run offline on the dry run.

## PayPal

Sandbox only. There is no live mode anywhere in the code: boot refuses any value naming live or production, the sandbox address is one constant in `packages/transport/src/endpoints.ts`, and `pnpm check:no-live-host` fails the build if a live PayPal host appears.

- **What the app calls.** Five sandbox operations, through one sealed transport package: get a token, create an order, get an order, capture an order, and read the capture (Orders v2). Refunds, webhook postbacks and payouts are not called in a sitting.
- **Two keys.** Reaching the sandbox needs `UMS_PAYPAL_CONNECT=on` **and** an active approval row that the owner inserts at a terminal with `pnpm safety:approve`, which refuses in CI. The row sets a scope, an amount cap per order and a call budget.
- **Five locks.** Sandbox mode, the connect flag, the approval row, the kill switch, and credentials present with a clean self check. All five must be open. The operator Controls page shows each one.
- **Ceiling (D-094).** Five operations, at most $5 per order, 40 calls, $20 captured per sitting, four hours. Only the owner runs a sitting. Builder and reviewer agents never hold credentials. The sitting of 7 Nov 2026 ran under the written basis D-108.
- **Read back.** A PayPal response is treated as a claim. The app reads each capture back before access opens.
- **Settlement, said plainly.** In the sittings every selling publisher is paid into one sandbox business account that the team controls. Paying a second merchant directly into its own account is not demonstrated. By design the buyer pays UnitMarket's collection account and UnitMarket pays the publisher after the access window; that payout step runs in the dry run only.

To use your own sandbox app instead, see `docs/owner/MVPD-OWNER-STEPS.md`. The variable names are in `.env.example`. Values go in your own `apps/web/.env.local` or host settings, never in the repository, a log, a pull request or a chat. Nothing here is needed to judge the project.

## AI

Claude is used in two ways, and the line between them matters.

1. **Building the product.** Coding sessions with Claude wrote and reviewed much of the code, under a written spec for each task, tests first, and a separate review before merge. The working rules are in `CLAUDE.md` and the specs in `docs/specs/`.
2. **Inside the product.** A Claude adapter turns a buyer's plain words into a search and proposes a pack. It uses read-only tools, never sees PayPal data, has a spend cap and a stop switch, and falls back to a deterministic scripted model. It is **off by default**: without `UMS_AI_ADAPTER=claude` and `UMS_ANTHROPIC_API_KEY` in your own `.env.local`, the scripted model answers and no AI call is made. It is off on the hosted app, so Claude does not run in the hosted demo.
3. **Agents as buyers.** The buyers in the agent flow are AI agents of any kind, connected through the MCP server and the public API, held to the cap a person set.

What is not AI: the money path, the approval, the five locks, the journal, delivery checks and receipts. An agent never pays outside its cap, and in the sandbox an agent purchase waits for the buyer's approval.

## What is simulated

These parts live in a separate simulation model, never connected to PayPal, and are not run by this repository:

- the micro-ledger and netting of many trades into few payments;
- buyer pools, seller pools and matching;
- rebates and the payouts of that model.

The per publisher dry run payout in this repository (see "What works today") is a separate, much smaller piece: one payout per publisher after the access window, through a pretend PayPal.

In the simulation, ten thousand agent trades of 5 to 10 cents cost about $4,926 in fees when each is paid on its own at PayPal's standard published rate, and about $83 when the ledger nets them into 198 PayPal movements. Buyer pools turn ten thousand payments into 233. These are model results on published prices, not PayPal results. A lower micro-settlement price that appears in our video is our own proposal, not a PayPal product.

The simulation code is in a separate repository and is not part of this submission. Its results are shown in the video.

## Safety design

1. The default mode is offline: a dry run transport, fixtures, a scripted model and no credentials.
2. Two-key approval and five locks before any PayPal call.
3. Fail closed: no `live` value exists, and no live PayPal host passes the build.
4. Secrets stay on the server. The only public variable is `NEXT_PUBLIC_UMS_ENV_LABEL`. `.env.example` holds names only. CI scans the full git history with a secret scanner. The scan on 5 Nov 2026 (every branch, 999 commits) found 0 leaks (`docs/public-release-checklist.md`). `[TODO before submission: repeat the scan on the final commit and state the result]`
5. Access to content opens only after a verified payment and a delivery that is verified possible.
6. Strict layering enforced by lint: only the transport package opens a network connection, only `packages/config` reads the environment, and time and ids are injected so tests are deterministic.

## Where things are

- `apps/web`: the web app, the public API and the MCP server, with the browser journeys in `apps/web/e2e`.
- `domain/`: the business rules, one folder per area (catalogue, discovery, approval, payments, ledger, delivery, entitlements, mandates, offer-entry, publisher-console, rules, recovery, alerts, trace and others).
- `packages/`: contracts, config, db (migrations), jobs, model, paypal, safety, security, transport, runtime, obs and testkit.
- `scripts/`: the checks and owner tools (`check:*`, `safety:*`, `trace:verify`, `owner:secrets`).
- `infra/gcp`: the hosting kit. `fixtures/`: recorded and synthetic PayPal responses. `tests/`: cross package tests. `video/`: the demo video source.

## Legal and data

The legal pages (terms of purchase, privacy notice, refund policy, publisher terms) are drafts for the owners to approve and are not legal advice. No tax is calculated and no tax invoice is issued; a receipt is a record of the sale. A privacy export and deletion script (`pnpm privacy:export`, `pnpm privacy:delete`) runs only from the owner's own terminal.

## Docs

`CLAUDE.md` (working rules), `docs/design/` (architecture, MVP plan, non-functional requirements), `docs/decision-log.md`, `docs/READINESS.md`, `docs/evidence/` (what each sitting showed), `docs/specs/` (one spec per task, indexed in `docs/specs/README.md`), `docs/business-rules/`, `docs/api/openapi-v1.json`, `docs/demo/`, `docs/submission/`, `docs/owner/` (owner step guides), `docs/public-release-checklist.md`, `docs/PROVENANCE.md`.

## Licence

Apache-2.0. See `LICENSE`. Dependency licences are listed in `THIRD-PARTY-NOTICES.md`, produced by `node scripts/licenses-report.mjs`. One production dependency, `@img/sharp-libvips-*` (LGPL-3.0-or-later, a prebuilt library that the web framework's image tool loads), is recorded with a written reason in that script.
