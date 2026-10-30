# Testing instructions for judges: draft for the owners (DOCS-B)

Status: DRAFT, updated on 30 Oct 2026 against `main` at commit `a897c69` (first written at `cb8eabe`). The owners approve every word (decision item 69).
Paste the block between the two rules below into the Devpost testing instructions field. Credentials appear only as the
placeholders shown; the real values go into the Devpost form and nowhere else (decision items 22 and 24). Lines that start with
**TO FINALISE** mark something that is not true yet or needs a person; remove or complete them before pasting.

---

## UnitMarket Sandbox: how to test

UnitMarket lets a reader buy only the article they need. An agent finds articles that fit a stated need and a price ceiling and
composes a pack within those limits. A human approves every payment. Payments use the PayPal sandbox: sandbox accounts only, no real
money. All publishers and articles are fictional.

There are two ways to test. Path A needs nothing but this repository and runs on your computer. Path B uses our hosted app.

### Path A: run it from the repository (about ten minutes, no credentials)

This path uses the Dry run: the same app and the same buyer journey with a pretend PayPal. It never contacts PayPal and needs no
account. Every page says "Dry run" in its label.

You need Node 22.22.0 (the `.nvmrc` file) and Corepack. Run the commands in a normal terminal window.

```sh
corepack pnpm install --frozen-lockfile
corepack pnpm owner:secrets
```

`owner:secrets` asks you to choose a demo passcode of at least 12 characters, twice, and prints four `NAME=value` lines. It needs a
real terminal. Create the file `apps/web/.env.local` (git ignores it), paste the four lines into it, and add these three lines:

```sh
UMS_MODE=offline
UMS_PUBLIC_ORIGIN=http://localhost:3000
NEXT_TELEMETRY_DISABLED=1
```

Then build and start the app:

```sh
corepack pnpm --filter @umsbx/web build
corepack pnpm --filter @umsbx/web start
```

Open `http://localhost:3000`. The page `http://localhost:3000/healthz` answers `{"ok":true,"environment":"dryrun"}`.

Optional checks, also offline:

```sh
corepack pnpm test:unit
corepack pnpm test:e2e
corepack pnpm check:no-live-host
corepack pnpm check:secrets-names
```

`test:e2e` runs the browser journeys; build the app first. The six test suites are `test:unit`, `test:state`, `test:contract`,
`test:integration`, `test:adversarial` and `test:golden`. The whole offline check list is `corepack pnpm run ci` (several minutes).

These Path A commands match the README on `main` and the scripts in `package.json`. **TO FINALISE (human only):** before
submission, a person must run this path from a fresh clone of the public repository on a clean machine, time it, and fix any step
that fails. Nobody has done that yet.

### Path B: the hosted app

URL: `<hosted demo URL: from the Cloud Run deploy output, filled in at submission>`

Sign in at `/signin`. Choose Buyer A or Buyer B, then enter the judge passcode.

- Judge passcode (env name `UMS_JUDGE_PASSCODE_HASH` on the host; the value is in the Devpost form only):
  `<judge passcode: in the Devpost form only>`. It signs in Buyer A and Buyer B only. Operator and publisher sign-ins refuse it.
- Sandbox buyer login for the PayPal approval page: `<sandbox buyer login: in the Devpost form only>`

When hosted payments are live. The hosted app makes real PayPal sandbox calls only in three windows of seven days each, starting
30 Nov, 7 Dec and 14 Dec 2026 (decision item 21), and only while the owners have switched the connection on. Outside those windows
the connection is off and the app does not call PayPal.

**TO FINALISE (decision item 23, human only):** the plan says that outside the windows a judge always has a working purchase. On
the hosted sandbox service this is not so: its label reads "Sandbox", and with the connection off the outbound gate refuses PayPal
calls, so a purchase does not complete (D-056: checkout paused, nothing charged). The deploy kit now has a second service, the
offline judge service (`infra/gcp/deploy-offline.sh`), which runs in offline mode with in memory data, no PayPal and the label
"Dry run" from stored data. It is prepared and not deployed. If a person deploys it, add its URL here as Path B2 and say that a
purchase completes there at any time. If not, word this section as "outside the windows, browse only; use Path A for a full
purchase". Until one of these is done, tell judges to use Path A for a purchase.

How to tell Sandbox from Dry run. Every page shows a label. "Sandbox" means the app is allowed to talk to the PayPal sandbox.
"Dry run" means a pretend PayPal and no contact at all. The label comes from the stored environment of the order, not from a fixed
string, and the receipt carries the same word. In a Dry run, PayPal pages are replaced by an in app page headed "Dry run: no
PayPal".

### What to try, by persona

The sign in page offers these personas. On Path A all use the demo passcode you made. On Path B judges get the judge passcode, which opens the buyer personas only; the operator and publisher personas are for the owners.

Buyer A or Buyer B (the main journey, about three minutes):

1. Open `/discover`. Type a need and a ceiling, for example `harbour charges and the quayside market, under $5`, and choose Find
   articles.
2. Tick the terms of purchase, select one article from each publisher and choose Buy selected together.
3. Read the approval page: one block per publisher, the line "2 payments", the frozen price and its countdown. Choose Continue to
   payment.
4. On the PayPal approval page (Path B in a live window) or the pretend page (Dry run), approve payment 1 of 2, see "Step 2 of 2",
   then approve payment 2 of 2. In a live window, log in to PayPal with the sandbox buyer login above.
5. Open the order page, then the library and the receipt. Each article shows ready only after the payment is verified.

Operator (safety gate, about two minutes, best on Path A):

1. Sign in as Operator. On Path A leave the operator name and the code empty: with no authenticator keys set, an operator signs in
   with the passcode alone and cannot refund or turn a switch on.
2. Open `/ops`. See the five locks of the outbound gate, the Stop PayPal now button, the calls left today, the orders and the
   invariants. Press Stop only on your own Path A copy. On the hosted app, Stop turns payments off for everyone, so please look and
   do not press it.
3. Refunds need an authenticator code held by the owners, so they are not part of the judge instructions.

The judge passcode (`UMS_JUDGE_PASSCODE_HASH`, JUDGE-A, merged) signs in Buyer A and Buyer B only, so a judge cannot reach `/ops`
or Stop with it. Anyone who holds the demo passcode still can, without a code when no authenticator keys are set (accepted risk,
D-040), so keep the demo passcode out of the Devpost form. The owners decide whether judges are told about the `/ops` page at all.
The offline judge service works the same way (HARD-OFFLINE): it holds its own judge hash (`UMS_OFFLINE_JUDGE_PASSCODE_HASH`,
mapped to `UMS_JUDGE_PASSCODE_HASH`), so the passcode judges receive there signs in Buyer A and Buyer B only. Its demo hash
(`UMS_OFFLINE_DEMO_PASSCODE_HASH`) is a separate passcode that only the owners keep.

Publisher:

- On `main` the sign in page offers three publishers: Harbour Ledger, Quayside Gazette and Northfield Quarterly. They use their own
  passcode (`UMS_PUBLISHER_PASSCODE_HASH`), not the demo or judge passcode; without it they refuse. A publisher sees a home page, its
  offers with a revise and a withdraw action (new versions, within a price cap), a sales page and a statement page, and can ask for
  a payee change that an operator checks. On Path A, make the publisher passcode as the README describes. **TO FINALISE (deploy,
  human only):** the publisher area appears on the hosted app only after a person deploys it and stores the publisher secret
  (`docs/owner/DEPLOY-PREP-2026-11.md`). Judges are not given the publisher passcode.

Other things to look at, on Path A: the Appearance control in the footer (Bright Market and Deep Harbour), the in app reader on
an article you own, and the four draft legal pages linked from the footer.

### What is real and what is not

- Real: the PayPal sandbox calls in Path B live windows (a pack of two articles is two separate sandbox payments), the safety gate,
  the ledger, the receipts and the checks that run offline.
- Fixture: the Dry run PayPal and the recorded responses.
- Fictional: the publishers, the articles and the buyers. Sandbox accounts only.
- Today both publishers are paid into one sandbox test account; multi-merchant payout not demonstrated. **TO FINALISE:** replace
  this line only if the Quayside test order has been proven (decision items 28 and 30).
- No commission in this demo; planned 20 percent, not implemented.
- Publishers are fictional. UnitMarket never holds a publisher's money and uses no payout service; the design pays each publisher
  directly through PayPal, which is not demonstrated with a second account. Payee checks are done by an operator, not by PayPal
  onboarding.
- Refunds are decided by an operator. PayPal keeps its original fee on a refund. No tax is calculated and no tax invoice is issued
  in this demo.
- Simulation and dry run results prove modelled cases only, not PayPal compatibility.
- The footer links four draft legal pages, including publisher terms in plain English. They are drafts for owner approval and are
  not legal advice. A privacy export and delete script is merged (`pnpm privacy:export`, `pnpm privacy:delete`). It runs only from the owner's
  terminal.
- AI: by default the pack is composed by a scripted model and no AI call is made. The Claude adapter is merged but off by default,
  and no real AI call has ever been made with it. **TO FINALISE (AI-A, human only):** if a person switches the adapter on for the
  hosted app and makes one real call, say so here and name the spend cap and the scripted fall back.

### Help

If a page shows an error, note the time and the reference on the page and tell us in the Devpost comments. The app holds no real
personal data. Please do not enter real payment details anywhere; PayPal sandbox logins are fake.

---

## Notes for the owners (not for the Devpost form)

1. The placeholders `<judge passcode: in the Devpost form only>` and `<sandbox buyer login: in the Devpost form only>` must be
   replaced inside the form, never in this file or the repository. Rotate both after judging (items 22 and 24).
2. The rules ask for complete instructions and any test credentials; keep the form text and this file in step.
3. Paths A and B were not run by the drafter. Nothing here was verified against a hosted URL or a running app.
4. The hosted URL contains no secret, but it is not written here: it comes from the deploy output.
