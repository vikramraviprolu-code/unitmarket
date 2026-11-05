# UnitMarket

UnitMarket lets people and AI agents buy just the content they need, one unit at a time, for a few cents, instead of paying for a whole subscription. A buyer, or an agent holding a spending cap the buyer set, states a need and a price ceiling. UnitMarket proposes a pack that fits, a person approves, and each publisher in the pack gets its own **PayPal sandbox** payment. Every money, delivery, cap and control change is written to a tamper-evident journal that an operator can verify.

This is our entry for the PayPal AI Hackathon, "Build what's next with PayPal and AI".

- Hosted demo: `[PLACEHOLDER: hosted URL, filled in after the deploy]`
- Demo video (under 3 minutes): `[PLACEHOLDER: public YouTube URL]`
- Licence: Apache-2.0 (`LICENSE`). Third-party licences: `THIRD-PARTY-NOTICES.md`.

Built during the submission period, which starts on 1 Oct 2026. The first commit in this repository is dated 21 Oct 2026.

> **Real, dry run, simulated.** PayPal is used in **sandbox only** (test money), and only in sittings run by the owner under a two-key approval. Everywhere else the app runs in **Dry run**: the same code against a pretend PayPal, with the label taken from stored data. The micro-ledger, netting, buyer and seller pools, matching, rebates and payouts are **simulated** in a separate model and never touch PayPal. No real money moves anywhere. All publishers and articles are fictional.

## The problem and the idea

A reader who wants one article is asked to buy a whole subscription. An AI agent that needs one answer has the same problem. Small purchases do not happen because the payment cost is bigger than the purchase: in our model, a seven cent sale paid on its own at PayPal's standard published rate costs about forty-nine cents in fees.

UnitMarket is built on two ideas, which we call the pillars:

1. **Micro-trades by AI agents.** Agents buy in 5 to 10 cent pieces. A ledger records each trade and nets many trades into a few PayPal payments, so a low fee per trade is made up by volume.
2. **Consolidation of buyers and sellers.** Buyers who want the same unit share one payment (buyer pools). Small publishers group on a topic to fill bundles none could fill alone (seller pools). UnitMarket matches the two sides.

The model is like ride-hailing: UnitMarket gathers demand and supply and does the matching, and PayPal is the settlement layer that moves the money. This repository is the working product slice. The pillars at scale are shown in our simulation (see "What is simulated").

## What works today

Everything in this table is merged on `main`.

| Area                                   | State                                                                                                                                                                                                                                                                                                                          |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Buyer journey                          | Need and ceiling, proposed pack, approval with a frozen price and frozen terms, one payment per publisher, library, receipt. Access opens only after a verified capture                                                                                                                                                        |
| PayPal sandbox payments                | Real, observed in the owner's sittings: create order, approval, capture and read back. On 29 Oct 2026 a pack from two publishers was paid as two separate sandbox payments (`docs/evidence/mvp-d-real-sitting-2026-10-29.md`). `[PLACEHOLDER: result of the next owner sitting, from its closing row in docs/decision-log.md]` |
| Dry run (default)                      | Real code against a pretend PayPal, labelled "Dry run" from the stored environment. No account and no credential needed                                                                                                                                                                                                        |
| Public API and agent buying            | API keys with scopes; buyer, seller and operator endpoints; signed event webhooks; an MCP server with six tools (`search_catalogue`, `get_offer`, `propose_pack`, `open_unit`, `check_budget`, `buy_unit`). Decisions D-088, D-093                                                                                             |
| Agent spending caps                    | The buyer sets a money cap, a purchase-count cap, a per-purchase maximum and an expiry for one agent key, from the API or from the buyer's Agents page (D-101). The agent can never create, widen or revoke its own cap. 20 concurrent buys on a 5-purchase cap give exactly 5 orders (D-093)                                  |
| Agent buying in the sandbox            | In the sandbox, `buy_unit` stops and returns `buyer_approval_required` with a UnitMarket page where the buyer approves. It calls nothing on its own. The fully automatic agent path runs in the dry run only                                                                                                                   |
| Buyer screens                          | Home, Agents (create and revoke caps), Spending with CSV, order timeline, receipts, approvals inbox, API keys                                                                                                                                                                                                                  |
| Publisher (seller) area                | Publisher home, offers that a publisher can revise or withdraw as new versions within a price cap, sales list and sale detail without buyer identity, statement, payee change requests checked by an operator                                                                                                                  |
| Transaction journal and `trace:verify` | One append-only, hash-chained table, written in the same database transaction as each tracked change, with the actor, channel and origin (D-097). `pnpm trace:verify` detects an edited row and names it                                                                                                                       |
| Operator console                       | Home with health lights and a needs-you list; alerts that raise and resolve on their own; cases; order page with timeline and evidence pack; transactions search with saved views and CSV; quick-find; activity log; publishers; payee requests; evals                                                                         |
| Controls                               | Gateway panel with the five locks, outbound approval gate, services, feature switches, and an API exposure screen that turns API groups and MCP tools on or off (`403 api_disabled`, D-102)                                                                                                                                    |
| Business rules                         | A rules registry with platform, seller and buyer scopes; a journaled settings store; operator screens to view, change, explain and export rule history as CSV. Each sale freezes the terms in force in its approval snapshot, so a later rule change does not alter it                                                         |
| Refunds                                | Decided by an operator, per unit, behind a second factor                                                                                                                                                                                                                                                                       |
| AI model adapter (Claude)              | Merged and **off by default**. See "AI" below                                                                                                                                                                                                                                                                                  |
| `[PLACEHOLDER: integrated story test]` | `[PLACEHOLDER: add one row when the E2E lane merges: person buys, agent buys under a $5 cap, download, refund, alert raised and resolved, trace:verify passes, tamper demo]`                                                                                                                                                   |

Decided but not built on `main` today: the 10 percent platform fee (D-089, D-096), enforcement of the 7 day refund window (D-096), and publisher onboarding with fee and payout. The demo charges no platform fee.

Simulation and fixture results prove the modelled cases only, not PayPal compatibility in general.

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

`[PLACEHOLDER: one line pointing at the integrated story and the tamper demo, when the E2E lane merges]`

### Agent story from a terminal

`docs/demo/mvp1-api-demo.md` walks through the API and MCP steps in the dry run: create a buyer key, set a cap, let an agent buy until the cap stops it.

### Optional sign-ins

- **Publisher.** The three publisher sign-ins (Harbour Ledger, Quayside Gazette, Northfield Quarterly) use their own passcode. Run `corepack pnpm owner:secrets` again with a different passcode, keep only the `UMS_DEMO_PASSCODE_HASH=` line, paste it into `apps/web/.env.local` renamed to `UMS_PUBLISHER_PASSCODE_HASH=`, and restart. On `/signin` choose a publisher and use the field labelled "Publisher passcode".
- **Judge.** `UMS_JUDGE_PASSCODE_HASH`, made the same way with a third passcode, signs in Buyer A or Buyer B only. Operator and publisher sign-ins refuse it.

Every variable holds a hash, never the passcode. Names are listed in `.env.example`.

### Checks you can run without any credential

```sh
corepack pnpm test:unit            # one of six suites: unit, state, contract, integration, adversarial, golden
corepack pnpm test:e2e             # browser journeys on the dry run; build the app first
corepack pnpm check:no-live-host   # fails if a live PayPal host appears anywhere
corepack pnpm trace:verify         # checks the journal hash chain of the app's database; stop the app first
corepack pnpm run ci               # every offline check, several minutes
```

## PayPal

Sandbox only. There is no live mode anywhere in the code: boot refuses any value naming live or production, the sandbox address is one constant in `packages/transport/src/endpoints.ts`, and `pnpm check:no-live-host` fails the build if a live PayPal host appears.

- **What the app calls.** Five sandbox operations, through one sealed transport package: get a token, create an order, get an order, capture an order, and read the capture (Orders v2). Refunds, webhook postbacks and payouts are not called in a sitting.
- **Two keys.** Reaching the sandbox needs `UMS_PAYPAL_CONNECT=on` **and** an active approval row that the owner inserts at a terminal with `pnpm safety:approve`, which refuses in CI. The row sets a scope, an amount cap per order and a call budget.
- **Five locks.** Sandbox mode, the connect flag, the approval row, the kill switch, and credentials present with a clean self check. All five must be open. The operator Controls page shows each one.
- **Ceiling (D-094).** Five operations, at most $5 per order, 40 calls, $20 captured per sitting, four hours. Only the owner runs a sitting. Builder and reviewer agents never hold credentials.
- **Read back.** A PayPal response is treated as a claim. The app reads each capture back before access opens.
- **Settlement, said plainly.** In the sittings every selling publisher is paid into one sandbox business account that the team controls. Paying a second merchant directly into its own account is not demonstrated. UnitMarket never holds a publisher's money.

To use your own sandbox app instead, see `docs/owner/MVPD-OWNER-STEPS.md`. The variable names are in `.env.example`. Values go in your own `apps/web/.env.local` or host settings, never in the repository, a log, a pull request or a chat. Nothing here is needed to judge the project.

## AI

Claude (Anthropic) is used in two ways, and the line between them matters.

1. **Building the product.** Coding sessions with Claude wrote and reviewed much of the code, under a written spec for each task, tests first, and a separate review before merge. The working rules are in `CLAUDE.md` and the specs in `docs/specs/`.
2. **Inside the product.** A Claude adapter turns a buyer's plain words into a search and proposes a pack. It uses read-only tools, never sees PayPal data, has a spend cap and a stop switch, and falls back to a deterministic scripted model. It is **off by default**: without `UMS_AI_ADAPTER=claude` and a key, the scripted model answers and no AI call is made.
3. **Agents as buyers.** The buyers in the agent flow are AI agents of any kind, connected through the MCP server and the public API, held to the cap a person set.

`[PLACEHOLDER, owner check: say "Claude runs in the recorded demo" only if a real Claude call was made in the sitting.]`

What is not AI: the money path, the approval, the five locks, the journal, delivery checks and receipts. An agent never pays outside its cap, and in the sandbox an agent purchase waits for the buyer's approval.

## What is simulated

These parts live in a separate simulation model, never connected to PayPal, and are not run by this repository:

- the micro-ledger and netting of many trades into few payments;
- buyer pools, seller pools and matching;
- rebates and payouts.

In that simulation, ten thousand agent trades of 5 to 10 cents cost about $4,926 in fees when each is paid on its own at PayPal's standard published rate, and about $83 when the ledger nets them into 198 PayPal movements. Buyer pools turn ten thousand payments into 233. These are model results on published prices, not PayPal results. A lower micro-settlement price that appears in our video is our own proposal, not a PayPal product.

`[PLACEHOLDER, owner call: whether the simulation repository is made public. If it stays private, say "shown in the video only" here.]`

## Safety design

1. The default mode is offline: a dry run transport, fixtures, a scripted model and no credentials.
2. Two-key approval and five locks before any PayPal call.
3. Fail closed: no `live` value exists, and no live PayPal host passes the build.
4. Secrets stay on the server. The only public variable is `NEXT_PUBLIC_UMS_ENV_LABEL`. `.env.example` holds names only. CI scans the full git history with gitleaks. `[PLACEHOLDER: gitleaks result on the release commit]`
5. Access to content opens only after a verified payment and a delivery that is verified possible.
6. Strict layering enforced by lint: only the transport package opens a network connection, only `packages/config` reads the environment, and time and ids are injected so tests are deterministic.

## Before this repository is made public (owner calls)

These are decisions for the owner, Vikram. They are listed here so they are not missed; delete this section once each is done.

- `[OWNER CALL: contact email]` The legal and account copy, its golden files and tests, and a few docs carry the owner's contact address. Keep it, or replace it with a project address, before the repository goes public.
- `[OWNER CALL: Bible mentions]` Several docs mention the private planning document by name. Keep, reword or remove them before the repository goes public.
- `[OWNER CALL: make public]` Only the owner flips the repository to public, after `docs/public-release-checklist.md` is done and a last gitleaks run on the final `main` is clean. Then add the licence to the repository About box.

## Legal and data

The legal pages (terms of purchase, privacy notice, refund policy, publisher terms) are drafts for the owners to approve and are not legal advice. No tax is calculated and no tax invoice is issued; a receipt is a record of the sale. A privacy export and deletion script (`pnpm privacy:export`, `pnpm privacy:delete`) runs only from the owner's own terminal.

## Docs

`CLAUDE.md` (working rules), `docs/design/` (architecture, MVP plan, non-functional requirements), `docs/decision-log.md`, `docs/evidence/` (what each sitting showed), `docs/specs/` (one spec per task), `docs/business-rules/`, `docs/owner/` (owner step guides), `docs/public-release-checklist.md`, `docs/PROVENANCE.md`.

## Licence

Apache-2.0. See `LICENSE`. Dependency licences are listed in `THIRD-PARTY-NOTICES.md`, produced by `node scripts/licenses-report.mjs`. One production dependency, `@img/sharp-libvips-*` (LGPL-3.0-or-later, a prebuilt library that the image tool inside Next.js loads), is recorded with a written reason in that script.
