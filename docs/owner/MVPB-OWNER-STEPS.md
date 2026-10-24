# MVP-B owner steps (amendment to the spike runbook)

For: Vikram (Sakthi beside you, or on a call). Time: about 2 hours. You type every command yourself
in your own terminal, on your own machine (ASM-40 option A). The assistant never sees your
credentials and never runs these steps.

These commands become valid when lanes BU-1, BU-2, BU-3 and BU-6 have merged (see
`docs/design/mvpb-unseal-and-mvpc-offline.md`). Until then, only step 0 can run. Lane BU-6 re-checked
every command below against the code it merged with (the `corepack pnpm` commands start plain `node`
processes with no `--import` or `--require` flag, which sandbox mode would refuse). All rules of `docs/owner/SPIKE-RUNBOOK.md` ("What you
never share or paste anywhere", machine rules, refusal table) apply here too.

## Before the day (written approvals, no computer needed)

1. Part R of the spike runbook is done and the evidence form is with Sakthi. Above all we need the
   Business account's receiving preference for USD. If it says "ask me" or "block", decide first:
   change the preference in the sandbox account, or ask for a US account pair (D-023).
2. You have written to Sakthi, in your own words, three things:
   - "I approve the unseal: the app may build the sandbox transport behind the five locks, and my
     terminal counts as the second factor for `safety:resume`."
   - "I approve MVP-B sandbox calls: scope mvp_b_polling, at most 20 USD per order, 300 calls a day,
     valid until <date, at most 7 days ahead>."
   - "Spike Part W is replaced by this session" (or: "I will run Part W separately").
3. Sakthi has merged the decision-log rows for these and tells you the approval reference, for
   example `D-026`. Pull `main`.

## Step 0: machine check (5 min)

```
eval "$(fnm env)" && fnm use 22.22.0
node -v                                  # v22.22.0
corepack pnpm -v                         # 10.34.7
cd path/to/unitmarket-sandbox
git status --short                       # prints nothing
corepack pnpm install --frozen-lockfile
corepack pnpm run ci                      # ends without an error (takes several minutes)
```

Off any VPN. A normal terminal window, not an editor panel. No proxy variables set.

**Run the first line (`eval "$(fnm env)" && fnm use 22.22.0`) in every NEW terminal window.** A new
window starts without it and would use the wrong Node version. You open new windows for steps 2, 3, 6
and 7, so type it first in each of them, then `cd` to the repository folder.

## Step 1: settings file (10 min)

1. Make a data folder outside the repository: `mkdir -p ~/unitmarket-sbx-data`
2. Generate the app secrets: `corepack pnpm owner:secrets`. Type a demo passcode twice when asked
   (at least 12 characters; you will type it to sign in). It prints four `NAME=value` lines.
3. Create `.env.local` in the repository folder with a text editor (this file is ignored by git).
   Paste the four lines from step 2, then add these lines with your values:

```
UMS_MODE=sandbox
UMS_PAYPAL_CONNECT=on
UMS_OUTBOUND_APPROVAL_REF=D-026
UMS_OUTBOUND_SCOPE=mvp_b_polling
UMS_OWN_MERCHANT_ID=<merchant id of your sandbox Business account, 13 characters A-Z and 0-9>
UMS_DB=pglite-disk
UMS_PGLITE_DIR=/Users/<you>/unitmarket-sbx-data
UMS_PUBLIC_ORIGIN=http://localhost:3000
NEXT_PUBLIC_UMS_ENV_LABEL=Sandbox
NEXT_TELEMETRY_DISABLED=1
PAYPAL_CLIENT_ID=<paste from the Sandbox tab of Apps & Credentials>
PAYPAL_CLIENT_SECRET=<the ROTATED secret, pasted after clicking Show>
```

4. `PAYPAL_CLIENT_SECRET` must be the ROTATED (new) client secret, not the one from before the
   rotation. The old one no longer works and a wrong secret only shows up as a refusal from PayPal.
5. `UMS_OWN_MERCHANT_ID` (D-028) is the payee of the one MVP-B publisher: your own sandbox Business
   account (Account details in the developer dashboard). It is
   not a secret, but it is never committed and never pasted into a chat or a document except its last 4
   characters. On first start the app gives the publisher "Harbour Ledger" this id; the order then
   goes to PayPal without a payee, so PayPal pays the account of your app. If you change the value
   later, use a fresh data folder: a stored id is never overwritten.
6. Save and close the editor. Never print this file (`cat`, screenshots) and never paste it anywhere.
   Clear the clipboard.

## Step 2: approval row and switch (app not running) (5 min)

```
corepack pnpm safety:approve --operator vikram --ref D-026 --scope mvp_b_polling \
  --ops oauth_token,create_order,get_order,capture_order,get_capture \
  --max-amount 2000 --max-calls 300 --valid-until <YYYY-MM-DDT23:59:00Z> --approved-by vikram
```

Type `mvp_b_polling` when asked. Then:

```
corepack pnpm safety:resume --operator vikram --reason "MVP-B session"
corepack pnpm safety:status
```

`safety:status` must show a `budget D-026: 300 of 300 calls left today` line (the row is active) and
`switch paypal_outbound=on`.

`safety:resume` (like `safety:approve` and `safety:stop`) opens the database, and the app holds it with the
single-opener lock: stop the app, run the command, restart the app.

## Step 2b: payee check, before anything else is created (D-028, 5 min)

This is the first create of the whole window and it runs before the purchase in step 4. App not
running. Lane BU-7 left the payee out of `create_order` because the payee is our own account, so the
only proof that PayPal treats the order as ours is to read the created order back:

1. Create one order for the MVP-B publisher with the same body the app sends (the payee left out).
2. GET that order and look at `purchase_units[].payee.merchant_id`.
3. It must equal your `UMS_OWN_MERCHANT_ID`, exactly (compare the last 4 characters on screen; the
   program compares the whole value and prints only "payee echo: own id" or "payee echo: STOP").

Pass condition: `payee echo: own id`. Anything else (no payee, another id, an error) means STOP: do
not go on to step 3, do not retry with another body, do not edit the settings to make it pass. Write
down the printed line and tell Sakthi. This step and its stop rule are fixed by D-028.

The command (the first case of the conformance run, alone). In a new terminal window: the `fnm` line
of step 0, `cd` to the repository folder, then:

```
UMS_SANDBOX_TESTS=1 corepack pnpm sandbox:conformance --only payee-echo
```

It needs: your complete `.env.local` (step 1, with the rotated client secret and
`UMS_OWN_MERCHANT_ID`), the approval row and the switch on (step 2), the app NOT running, and a real
terminal (it refuses in CI, in an AI session, or without `UMS_SANDBOX_TESTS=1`). It sends the token
request, one create and one read, prints `payee echo: own id` or `payee echo: STOP`, and writes its
folder under `~/unitmarket-sandbox-run/<date>/` (so step 6 writes `<date>-2`).

## Step 3: build and start the app (5 min)

Next.js reads `.env.local` from the app's own folder, not from the repository root. Copy the file
once (both copies are ignored by git; delete the copy in step 7): `cp .env.local apps/web/.env.local`.

```
corepack pnpm --filter @umsbx/web build
corepack pnpm --filter @umsbx/web start
```

Leave this window open. Open `http://localhost:3000/ops` and sign in as `operator`. The gate block
must show all five locks open and the transport line `sandbox (approved)`. If any lock shows
missing, stop (Ctrl-C) and tell Sakthi.

**Emergency stop, at any time:** the "Stop PayPal now" button on `/ops`, or Ctrl-C in this window.

## Step 4: one real purchase (B-01, B-08, B-09) (15 min)

1. In a private browser window open `http://localhost:3000`, sign in as `buyer-a` with your passcode.
2. Open the first offer, choose an access option, tick the terms, press Approve.
3. You are sent to the PayPal sandbox page. Check the address bar starts with
   `https://www.sandbox.paypal.com`. Log in as the sandbox **Personal** account and approve.
4. You come back. The page says "Confirming payment", then the library shows the item with a
   five-day window. Open the receipt.
5. Screenshot: the library entry and the receipt (they show only the last 6 characters of ids). Do
   not screenshot an address bar that contains `token=`.
6. In the developer dashboard (Sandbox), open the Business account's activity and screenshot the
   transaction row cropped to date, amount and status.

## Step 5: kill switch in the middle (B-06) (10 min)

1. Start a second purchase as `buyer-a` and approve at PayPal, but do not come back yet: leave the
   PayPal tab open on its last page.
2. On `/ops` press "Stop PayPal now" (reason: "B-06 test").
3. Now let PayPal return you. The page must say "Payments paused". Nothing was captured.
4. Stop the app (Ctrl-C), run `corepack pnpm safety:resume --operator vikram --reason "B-06 resume"`,
   start it again with only the second command of step 3 (`start`; no rebuild is needed). Within a minute the order completes with one capture. Screenshot the
   library entry.

## Step 6: conformance run (B-02, B-03, B-04, B-07) (20 min)

Stop the app first (Ctrl-C): the suite and the app cannot share the data folder.

```
UMS_SANDBOX_TESTS=1 corepack pnpm sandbox:conformance
```

Type it yourself in your own terminal window. It refuses without a terminal, in CI and in an AI
session. It reads `.env.local` (the same file as the app) and uses the same five locks as the app: with
any lock missing it stops at the first call and says which one, before anything is sent.

When it prints "Open this link in a browser signed in as the sandbox Personal account, approve, then
come back", open that link and approve. It does this twice (two orders). Approve promptly: it waits
up to 6 minutes for each and reads the order every 3 seconds, and every one of those reads counts
toward the 300 calls a day of the gate budget (the suite stops with `budget` if it runs out). At the end it prints the folder it wrote (`~/unitmarket-sandbox-run/<date>/`) with
`summary.md` and `calls.json`. If you ran step 2b today, that folder already exists, so this run's
folder is `<date>-2`. The first case alone (the payee check of step 2b) is
`UMS_SANDBOX_TESTS=1 corepack pnpm sandbox:conformance --only payee-echo`.

## Step 7: finish (5 min)

```
corepack pnpm safety:stop --operator vikram --reason "end of MVP-B session"
corepack pnpm safety:status            # switch paypal_outbound=off
```

Close the terminal. Clear the clipboard. Delete `apps/web/.env.local` (the copy of step 3). Leave
`.env.local` in place or delete it; never copy it anywhere else.

## What to bring back to Sakthi

1. The line printed by step 2b (`payee echo: own id`). `summary.md` and `calls.json` from `~/unitmarket-sandbox-run/<date>/`. Open each once and check:
   no email address, no name, no long random string that looks like a token.
2. The screenshots from steps 4, 5 and the dashboard row.
3. The text output of the two `safety:status` runs (it holds no secret).
4. One line per step: done, skipped, or what you saw instead.
5. Anything that surprised you, especially: a capture that stayed "pending", a refusal word, a lock
   shown missing.

Sakthi turns `calls.json` into `sandbox-recording` fixtures with `pnpm record:fixtures` in a
reviewed pull request (B-13). Not covered today: B-05 (abandonment after 24 h, fixture only), 207
and 202 answers (fixture only until MVP-D), refunds and webhooks (MVP-C).
