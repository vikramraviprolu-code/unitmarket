# UnitMarket Sandbox

UnitMarket lets a reader buy only the article they need instead of paying for a whole subscription. An agent finds articles that fit a stated need and a price ceiling and composes a pack within those limits. The human approves every payment. Payments go through PayPal sandbox, with one payment per publisher.

This work was built during the submission period, which starts on 1 Oct 2026. The first commit in this repository is dated 21 Oct 2026.

Everything here runs offline by default: a dry run transport answers from recorded or synthetic fixtures, a scripted model stands in for the AI, and no credentials are needed. This repository holds no secret. Reaching the PayPal sandbox is optional and needs your own sandbox app (see "Use your own PayPal sandbox app").

Licence: Apache-2.0 (see `LICENSE`). Third party licences: `THIRD-PARTY-NOTICES.md`. Docs: `docs/`.

## Status

| Area                                 | State                                                                                                                                                                                                                                                                                                          |
| ------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| PayPal sandbox payments              | Real, observed in the owner's sittings (evidence in `docs/evidence/`): order, approval, capture and read back, and on 29 Oct 2026 a pack of two items paid as two separate sandbox payments                                                                                                                    |
| Dry run (default)                    | Real code on a pretend PayPal. The same buyer journey, labelled "Dry run" from the stored environment, covered by the offline test suites and 27 browser tests                                                                                                                                                 |
| Settlement                           | In the 29 Oct sitting both publishers were paid into the same sandbox merchant account. Paying Quayside Gazette directly into its own account is not built or tested; it needs a second sandbox Business account made by a person                                                                              |
| Discovery and pack composition       | Built. The default model is scripted (deterministic, no AI call)                                                                                                                                                                                                                                               |
| AI model adapter (Claude)            | Merged, off by default, with spend caps and a stop switch. Without `UMS_AI_ADAPTER=claude` and a key the scripted model answers and no network call is made. No real AI call has ever been made with it                                                                                                        |
| Operator evals page                  | Merged. Shows the evaluation cases and verdicts against the scripted model and recorded results, with a keyword baseline                                                                                                                                                                                       |
| Publisher area                       | Merged. Three publisher sign-ins and personas, a publisher home, offers that a publisher can revise or withdraw as new versions within a price cap, a sales page and a statement page, and payee change requests that an operator checks before anything changes (verification is refused outside the dry run) |
| Operator publishers page             | Merged. Shows each publisher's exposure and lets an operator suspend a publisher. An approval made before a suspension can still be placed inside its 15 minute window (known gap, pinned by a test)                                                                                                           |
| Reader view                          | Merged. Articles open in the app with a time left meter and a per reader rate limit                                                                                                                                                                                                                            |
| Judge passcode                       | Merged. A separate passcode (`UMS_JUDGE_PASSCODE_HASH`, a hash, never the value) that signs in the two buyer personas only. Operator and publisher sign-ins refuse it                                                                                                                                          |
| Two skins and the Appearance control | Merged. Bright Market and Deep Harbour, chosen in the footer, with the motion set. Each skin is one fixed palette                                                                                                                                                                                              |
| Sign out and navigation              | Merged. Sign out, and a navigation bar that differs for buyer, publisher and operator                                                                                                                                                                                                                          |
| Legal pages                          | Merged as drafts for the owners to approve: terms of purchase, privacy notice, refund policy and publisher terms. Not legal advice                                                                                                                                                                             |
| Deploy kit                           | Merged and prepared, not run by an agent. It maps optional secrets by name and has an offline judge service variant. A person deploys it. No hosted deploy has happened with the publisher area, the reader view, the skins, the judge passcode or the AI adapter                                              |
| Buyer cancel of an unpaid order      | TO FINALISE. Built on a branch (`feat/order-a-cancel`), not on `main`                                                                                                                                                                                                                                          |
| Hosted demo URL                      | Not published in this README. Run it offline as described below                                                                                                                                                                                                                                                |

Simulation and fixture results prove the modelled cases only, not PayPal compatibility in general.

## Three minute demo path (offline)

1. Start the app (next section) and open `http://localhost:3000`. The page shows "Dry run" in its label.
2. Sign in at `/signin` as Buyer A with your demo passcode.
3. On `/discover` type a need and a ceiling, for example `harbour charges and the quayside market, under $5`, then choose Find articles.
4. Tick the terms of purchase, select one article from each publisher and choose Buy selected together.
5. On the approval page read the two blocks (one per publisher) and the line "2 payments". Confirm the price and terms and choose Continue to payment.
6. On the pretend PayPal pages approve payment 1 of 2, see "Step 2 of 2", then approve payment 2 of 2.
7. The order page shows each article as ready, then open the library and the receipt.
8. In a fresh browser window sign in as Operator with the same passcode and open `/ops` to see the safety gate block and the Stop button. Refunds there need an authenticator code, which this README does not set up.

## Run it offline in under ten minutes

You need Node 22.22.0 (see `.nvmrc`) and Corepack. Run these in a normal terminal window.

```sh
corepack pnpm install --frozen-lockfile
corepack pnpm owner:secrets
```

`owner:secrets` asks for a demo passcode of at least 12 characters twice and prints four `NAME=value` lines. It needs a real terminal and refuses in CI. Create `apps/web/.env.local` (ignored by git), paste the four lines into it, and add these three lines:

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

Open `http://localhost:3000` and `http://localhost:3000/healthz`; the second answers `{"ok":true,"environment":"dryrun"}`. Rebuild after every `git pull`.

### Publisher sign-in (optional)

The three publisher sign-ins (Harbour Ledger, Quayside Gazette, Northfield Quarterly) use their own passcode, not the demo passcode. Without it they refuse, and buyers and the operator still work. The variable name is `UMS_PUBLISHER_PASSCODE_HASH`; it holds a hash, never the passcode.

To make one, run `corepack pnpm owner:secrets` again at a terminal and type a different passcode (at least 12 characters, twice). From its four output lines keep only the `UMS_DEMO_PASSCODE_HASH=` line, paste it into `apps/web/.env.local` and rename it to `UMS_PUBLISHER_PASSCODE_HASH=`. Leave the other three lines out so your first secrets stay. Restart the app. On `/signin` choose a publisher and type that passcode in the field labelled "Publisher passcode".

### AI adapter (optional)

By default a scripted model answers and no AI call is made. To try the Claude adapter, set `UMS_AI_ADAPTER=claude` and `UMS_ANTHROPIC_API_KEY` in your own `.env.local`. Names are listed in `.env.example`; never paste a key anywhere else.

### Judge passcode (optional)

A separate passcode lets a judge sign in as Buyer A or Buyer B without being able to reach `/ops` or any publisher page. The variable name is `UMS_JUDGE_PASSCODE_HASH`; it holds a hash, never the passcode, and it must differ from the demo and publisher hashes. Make it the same way as the publisher hash above. Without it no judge passcode exists.

Checks you can run without any credential:

```sh
corepack pnpm test:unit        # one of six suites: unit, state, contract, integration, adversarial, golden
corepack pnpm test:e2e         # 27 browser tests on the dry run; build the app first
corepack pnpm check:licences   # dependency licence audit
corepack pnpm run ci           # every offline check, several minutes
```

## Use your own PayPal sandbox app (optional)

This is for people who want to see real sandbox payments with their own fake accounts. Nothing here is needed to judge the project.

You create a sandbox REST app and sandbox buyer and business accounts in your own PayPal developer account. You put values in your own `.env.local` or your host settings, never in the repository, a log, a pull request or a chat. The variable names are in `.env.example`; the ones for this mode are:

`UMS_MODE`, `UMS_PAYPAL_CONNECT`, `UMS_OUTBOUND_APPROVAL_REF`, `UMS_OUTBOUND_SCOPE`, `UMS_OWN_MERCHANT_ID`, `PAYPAL_CLIENT_ID`, `PAYPAL_CLIENT_SECRET`, `PAYPAL_WEBHOOK_ID`, `UMS_DB`, `UMS_PGLITE_DIR`.

Setting them is not enough: a call also needs an active approval row that you insert yourself at a terminal with `corepack pnpm safety:approve`, and `corepack pnpm safety:resume` to turn the outbound switch on. The step by step guide is `docs/owner/MVPD-OWNER-STEPS.md`; `docs/owner/MVPB-OWNER-STEPS.md` covers the single publisher case. There is no live mode; only the PayPal sandbox can be reached.

## Safety design

1. The default mode is offline: a dry run transport, fixtures, a scripted model and no credentials.
2. Five locks must all be open before any PayPal call: mode is sandbox, the connect flag is on, an active approval row covers the scope, the kill switch is on, and credentials are present with a clean self check of the sending code.
3. Two key approval: the connect flag alone is not enough. A human inserts an approval row at a terminal with a scope, an amount cap per order (2000 minor units in the owner's sittings) and a call budget. The command refuses in CI.
4. Fail closed: no live value exists, boot refuses any value naming live or production, the sandbox address is one constant, and `corepack pnpm check:no-live-host` fails the build if a live PayPal host appears.
5. Secrets stay on the server (the only public variable is `NEXT_PUBLIC_UMS_ENV_LABEL`), and access to an article opens only after a verified payment and a delivery that is verified possible.

## Licence

Apache-2.0. See `LICENSE`. Dependency licences are listed in `THIRD-PARTY-NOTICES.md`, produced by `node scripts/licenses-report.mjs`. The audit found one production dependency with a copyleft licence, `@img/sharp-libvips-*` (LGPL-3.0-or-later, a prebuilt library that the image tool inside Next.js loads); it is recorded with a written reason in the script.

## Docs

`CLAUDE.md` (working rules), `docs/design/` (architecture, MVP plan, non functional requirements), `docs/decision-log.md`, `docs/evidence/` (what was observed in each sitting), `docs/owner/` (owner step guides), `docs/specs/` (one spec per task), `docs/PROVENANCE.md` (files adapted from an earlier simulation project).
