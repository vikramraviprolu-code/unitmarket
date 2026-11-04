# Deploy to Google Cloud: copy and paste guide for Sakthi

Written for Sakthi. Every step is a block to paste, with one line saying what it does. Nothing here turns PayPal on: every deploy leaves `UMS_PAYPAL_CONNECT` off. The full reference is `docs/owner/DEPLOY-PREP-2026-11.md`.

Values used below (from decision D-049). Confirm them with Vikram if unsure:

- Project: `unitmarket-sbx-vr1`
- Region: `europe-west3`
- Commit to deploy: `e7560e7` (the final commit on main)
- Tag to create: `gcp-pub-1` (written here as `TAG`). Use a new name if `gcp-pub-1` already exists.

The coordinator has sent the "GO" message for this commit. Do not deploy while anyone is testing the hosted app.

## Part 1. Tag the reviewed commit (your laptop, in a clone of the repository)

What it does: checks you hold exactly the reviewed commit, then labels it so the deploy can find it.

```
git fetch origin
git checkout e7560e7
git status
git tag gcp-pub-1
git push origin gcp-pub-1
```

Expected: `git status` says "nothing to commit, working tree clean". Stop and ask if it says anything else.

## Part 2. Check the commit is healthy (your laptop, same folder)

What it does: runs the full offline check list. It takes about 15 minutes and needs Node 22.22.0 (`corepack pnpm` is fine). The coordinator already ran all six test suites and the browser tests on this build, so this part is a second check. Skip it only if you are short on time; do not skip Parts 3 to 6.

```
corepack pnpm install --frozen-lockfile
corepack pnpm run ci
```

Expected: it ends without red errors. If anything fails, copy the failing test name and paste it to the coordinator. Do not deploy.

## Part 3. Backup check (Cloud Shell)

What it does: shows the latest automatic database backup. This is your way back if the new database changes go wrong.

```
PROJECT_ID=unitmarket-sbx-vr1
REGION=europe-west3
gcloud sql backups list --instance=unitmarket-sbx-pg --project="$PROJECT_ID"
```

Expected: a successful backup less than a day old. Write down its time.

## Part 4. Get the code and check the secrets (Cloud Shell)

What it does: downloads the tagged code and lists secret NAMES only (never values).

```
git clone https://github.com/vikramraviprolu-code/unitmarket-sandbox.git
cd unitmarket-sandbox
git fetch --tags
git checkout gcp-pub-1
gcloud secrets list --project="$PROJECT_ID" --format='value(name)'
```

Expected: at least eleven names including `DATABASE_URL`. If you did this earlier, only run the last three lines inside the existing folder.

The repository is private. If `git clone` asks for a GitHub username and password, use your GitHub username and a personal access token as the password. Type it only at that prompt. Never paste it into this chat.

## Part 5. Deploy (Cloud Shell, same folder)

What it does: builds the image (about 10 minutes the first time) and deploys the service `unitmarket-sandbox`. The first start also applies database changes (migrations 0012 to 0015) and writes four demo price changes.

```
bash infra/gcp/deploy.sh "$PROJECT_ID" "$REGION" gcp-pub-1
```

Expected: the last lines read `deployed unitmarket-sandbox from tag gcp-pub-1 at commit ...` and `service URL: https://...`. Copy both lines.

If the output ends with a line starting `NOTE: UMS_PUBLIC_ORIGIN in service.yaml is not this URL`, tell the coordinator. Sign-in will be refused until that is fixed in a new tag. Do not edit files on the host.

## Part 6. Check it works (browser)

1. Open `<service URL>/signin`. Expected: the sign-in page.
2. Sign in as Buyer A with the demo passcode. Open `/discover`. Expected: the page loads. Do not start a purchase.
3. In a second window sign in as Operator (name, passcode, current code). Open `/ops`. Expected: the outbound gate block says PayPal calls are blocked.

## Part 7. Paste back to the coordinator

- The two lines from Part 5
- What you saw on `/signin` and `/ops`
- The backup time from Part 3

Never paste a secret value, a passcode or a TOTP code.

## If something goes wrong

Do not delete anything. Stop and paste the last 20 lines of the output to the coordinator. The plain way back is to run Part 5 again with the tag that was serving before. The database changes are not undone by an older tag. If that matters, Vikram restores from the Part 3 backup.

## Not part of this guide (separate, later)

The publisher passcode, the judge passcode, the Claude key and the offline judge service each need secret values that only you or Vikram can type. Say so when you are ready for those steps.

## Second deploy: tag `gcp-pub-2` (publisher screens, operator home, Apply form)

Commit to deploy: `d6698da`. It adds no new database migration, so it changes no tables. Tag it exactly as in Part 1, with the new name. The optional secrets you stored for the first deploy are kept. Do not deploy while anyone is testing the hosted app.

Where to run it: Part 1 on a laptop that has the repository (Vikram's) or in Cloud Shell if your GitHub account can push tags. Then the rest in Cloud Shell.

```
git fetch origin
git checkout d6698da
git status
git tag gcp-pub-2
git push origin gcp-pub-2
```

Then in Cloud Shell, in the repository folder:

```
PROJECT_ID=unitmarket-sbx-vr1
REGION=europe-west3
gcloud sql backups list --instance=unitmarket-sbx-pg --project="$PROJECT_ID"
git fetch --tags
git checkout gcp-pub-2
bash infra/gcp/deploy.sh "$PROJECT_ID" "$REGION" gcp-pub-2
```

Expected: the backup list shows a successful backup less than a day old. The deploy output shows `on: UMS_PUBLISHER_PASSCODE_HASH` and `on: UMS_JUDGE_PASSCODE_HASH`, and ends with `deployed unitmarket-sandbox from tag gcp-pub-2`. The NOTE about the other address is the same as before. Keep using `https://unitmarket-sandbox-626887286871.europe-west3.run.app`.

Checks in the browser (Chrome):

1. Sign in as a publisher with the publisher passcode. The home page shows the publisher name, four figure tiles, an account panel and four cards.
2. Open Your offers. Cards with cover initials and filter tabs.
3. Sign in as Operator with the name, passcode and current code, then open Operations. Switch cards, a kill switch panel, and `paypal_outbound` shown as Off with the words "Off: no PayPal calls".
4. Open Publishers. Applicants queue, publisher cards.
5. Apply check (needed before anyone is told about the Apply link): open `/apply` on the hosted address, apply as "Test Applicant (fake)", country GB, note "test only". Expected: "Application received" with a reference. If it says "We cannot take new applications right now", the hosted proxy count is wrong: tell the coordinator and do not share the link. Then reject that applicant in Operations, Publishers, with the reason "test".

Paste back: the deploy output's last two lines and what you saw in checks 1 to 5. Never paste a passcode.

## Starting the PayPal sandbox gateway (works with the environment guard)

Run this only at the owner's own terminal, never in Cloud Shell or an AI session, and only after the deploy. A deploy always leaves the connection off, so do it after the deploy, not before. The approval basis is D-062 (see the decision log for its limits and end date).

Window 1 (leave open):

```
cloud-sql-proxy --port 5433 unitmarket-sbx-vr1:europe-west3:unitmarket-sbx-pg
```

Window 2, in the repository folder. The guard refuses a terminal that holds `DATABASE_URL` or `UMS_DB` and differs from `.env.local`, so the file is changed for a few minutes and restored afterwards:

```
git checkout gcp-pub-2
RAW="$(gcloud secrets versions access latest --secret=DATABASE_URL --project=unitmarket-sbx-vr1)"
export DATABASE_URL="$(printf '%s' "$RAW" | sed 's#@/\([^?]*\)?host=[^ ]*#@127.0.0.1:5433/\1#')"
unset RAW
cp .env.local .env.local.bak
grep -v -E '^(UMS_DB|UMS_PGLITE_DIR|DATABASE_URL|UMS_PAYPAL_CONNECT|UMS_OUTBOUND_APPROVAL_REF)=' .env.local.bak > .env.local
printf 'UMS_DB=postgres\nDATABASE_URL=%s\nUMS_OUTBOUND_APPROVAL_REF=D-062\n' "$DATABASE_URL" >> .env.local
unset DATABASE_URL UMS_DB
grep -E '^(UMS_MODE|UMS_OUTBOUND_SCOPE)=' .env.local
corepack pnpm safety:status
```

Expected: `UMS_MODE=sandbox`, `UMS_OUTBOUND_SCOPE=mvp_c_refunds`, and `mode=sandbox connect=off db=postgres`. Before the approval, the status says no active approval. Check that the live app looks for the same reference (it prints only MATCH or DIFFERENT):

```
[ "$(gcloud secrets versions access latest --secret=UMS_OUTBOUND_APPROVAL_REF --project=unitmarket-sbx-vr1)" = "D-062" ] && echo MATCH || echo DIFFERENT
```

Insert the approval and turn the switch on. Each asks you to type `mvp_c_refunds`:

```
corepack pnpm safety:approve --operator vikram --ref D-062 --scope mvp_c_refunds \
  --ops oauth_token,create_order,get_order,capture_order,get_capture \
  --max-amount 2000 --max-calls 120 --valid-until 2026-11-03T12:00:00Z --approved-by vikram
corepack pnpm safety:resume --operator vikram --reason "tester sitting"
```

Restore and close, always:

```
mv .env.local.bak .env.local
unset DATABASE_URL UMS_DB
```

Then press Ctrl+C in the proxy window. In Cloud Shell set the flag, wait for the new revision, and check Operations (switch On, calls left):

```
gcloud run services update unitmarket-sandbox --region=europe-west3 --project=unitmarket-sbx-vr1 --update-env-vars=UMS_PAYPAL_CONNECT=on
```

To stop at any time: the "Stop PayPal now" button on Operations, or the same flag command with `UMS_PAYPAL_CONNECT=off`. The approval ends on 2026-11-03 at 12:00 UTC.

## Third deploy: tag `gcp-pub-3` (landing page, buyer accounts, Start button, tabs, both skins)

Commit to deploy: the coordinator gives you the exact hash in the chat message that sends you here. Put it in `COMMIT` below. This deploy adds **one database migration (0016, the buyer accounts table)**. It applies by itself at first start and only adds a table, so nothing existing changes. The backup check in step 2 is therefore not optional. Do not deploy while anyone is testing the hosted app. A deploy leaves the PayPal connection off, as always.

Step 1. Tag it (laptop with the repository, or Cloud Shell if your account can push tags):

```
COMMIT=PUT-THE-HASH-FROM-THE-CHAT-HERE
git fetch origin
git checkout "$COMMIT"
git status
git tag gcp-pub-3
git push origin gcp-pub-3
```

Expected: `git status` says nothing to commit. If `git tag` says the tag exists, stop and tell the coordinator.

Step 2. Backup check, then deploy (Cloud Shell, in the repository folder):

```
PROJECT_ID=unitmarket-sbx-vr1
REGION=europe-west3
gcloud sql backups list --instance=unitmarket-sbx-pg --project="$PROJECT_ID"
git fetch --tags
git checkout gcp-pub-3
bash infra/gcp/deploy.sh "$PROJECT_ID" "$REGION" gcp-pub-3
```

Expected: a successful backup less than a day old, and the output ends with `deployed unitmarket-sandbox from tag gcp-pub-3`. Keep using `https://unitmarket-sandbox-626887286871.europe-west3.run.app`.

Step 3. Checks in the browser (Chrome), in this order:

1. Open the address. A landing page shows three doors: Buyer, Seller, Operator. Use the Appearance switch in the header: both skins (Bright Market and Deep Harbour) change the page at once.
2. Buyer door, then Create account. Make a test buyer such as `test.buyer1` with a password of 12 or more characters (a few ordinary words is fine). Expected: you land on your account page. Sign out, then sign in again with the same name and password.
3. Seller door. It explains that sellers apply and the owners handle applications by hand. The Apply link still works (use "Test Applicant (fake)" as before, then reject it in Operations, Publishers).
4. Operator door. Sign in with name, passcode and current authenticator code. Open Operations. Section tabs run across the top. Beside "Stop PayPal now" there is a Start PayPal box. With the switch off and the Cloud Run flag off, Start must say what is missing and must not start anything.
5. Persona sign-in (for judges) still works from the buyer page.

Step 4. Proxy depth check (needed before anyone is told about the sign-up link): run `docs/design/hosting.md` step 5 against the hosted address (the exact `curl` commands are in `docs/owner/MVPC-OWNER-STEPS.md` Step 3). It uses the made-up persona `buyer-b`, so no real secret is typed. If any result differs from the document, do not share the sign-up link and tell the coordinator.

Step 5. Starting PayPal with the new button (after a deploy the connection is off). Approval D-062 must still be active (ends 2026-11-03 12:00 UTC). In Cloud Shell turn the Cloud Run flag on:

```
gcloud run services update unitmarket-sandbox --region=europe-west3 --project=unitmarket-sbx-vr1 --update-env-vars=UMS_PAYPAL_CONNECT=on
```

Then, as operator, open Operations and use Start PayPal: type the reason, the scope name `mvp_c_refunds` and the current authenticator code. Expected: the switch card reads On with the calls left. The approval row itself is still inserted only at the owner's own terminal (see the section above). To stop: the "Stop PayPal now" button, or the same flag command with `UMS_PAYPAL_CONNECT=off`.

If a buyer forgets a password: an operator at their own terminal (same database setup as the PayPal start section above) runs `corepack pnpm accounts:reset-password --username THE-NAME --operator vikram`, which asks for the new password twice (nothing is shown on screen). Nothing is ever sent by email.

Paste back: the deploy output's last two lines and what you saw in checks 1 to 5 and Step 4. Never paste a passcode or password.

## Fourth deploy: tag `gcp-pub-4` (header layout fix, clearer Operations wording)

Same steps as the third deploy, with the new tag. It adds **no database migration**, so nothing in the database changes. The deploy still leaves PayPal off. Do not deploy while anyone is testing.

Commit to deploy: the coordinator gives you the exact hash in the chat message that sends you here.

Step 1 (laptop with the repository):

```
COMMIT=PUT-THE-HASH-FROM-THE-CHAT-HERE
git fetch origin
git checkout "$COMMIT"
git status
git tag gcp-pub-4
git push origin gcp-pub-4
```

Step 2 (Cloud Shell, inside the `unitmarket-sandbox` folder):

```
PROJECT_ID=unitmarket-sbx-vr1
REGION=europe-west3
gcloud sql backups list --instance=unitmarket-sbx-pg --project="$PROJECT_ID"
git fetch --tags
git checkout gcp-pub-4
git log --oneline -1
bash infra/gcp/deploy.sh "$PROJECT_ID" "$REGION" gcp-pub-4
```

Expected: a successful backup less than a day old, `git log` shows the commit from the chat, and the output ends with `deployed unitmarket-sandbox from tag gcp-pub-4`. Keep using `https://unitmarket-sandbox-626887286871.europe-west3.run.app`.

Checks in the browser:

1. Sign in as a buyer. The header shows one clean row of links on a wide window, two clean rows on a medium window, and a readable stack on a phone. Try both skins.
2. Operations: with the switch Off the badge reads "Off: no PayPal calls". Do not press Start unless you mean to start PayPal. If the switch is On while the Cloud Run flag is off, the badge reads "On, flag off: no PayPal calls go out".
3. The sign-in and buyer accounts you made on the third deploy still work.

Paste back: the last two lines of the deploy output and what you saw. Never paste a passcode or password.

## Fifth deploy: tag `gcp-pub-5` (page edges line up, equal card widths, Operations tabs wrap)

Same steps as the fourth deploy, with the new tag. It adds **no database migration**. The deploy still leaves PayPal off. Do not deploy while anyone is testing.

Commit to deploy: the coordinator gives you the exact hash in the chat message that sends you here.

Step 1 (laptop with the repository):

```
COMMIT=PUT-THE-HASH-FROM-THE-CHAT-HERE
git fetch origin
git checkout "$COMMIT"
git status
git tag gcp-pub-5
git push origin gcp-pub-5
```

Step 2 (Cloud Shell, inside the `unitmarket-sandbox` folder):

```
PROJECT_ID=unitmarket-sbx-vr1
REGION=europe-west3
gcloud config set account unitmarket@raviprolu.com
gcloud config set project "$PROJECT_ID"
gcloud sql backups list --instance=unitmarket-sbx-pg --project="$PROJECT_ID"
git fetch --tags
git checkout gcp-pub-5
git log --oneline -1
bash infra/gcp/deploy.sh "$PROJECT_ID" "$REGION" gcp-pub-5
```

The two `gcloud config set` lines fix the "no active account selected" error some Cloud Shell sessions show. If the deploy still stops on that error, run them and run the deploy line again: it keeps the built image.

Expected: a successful backup less than a day old, `git log` shows the commit from the chat, and the output ends with `deployed unitmarket-sandbox from tag gcp-pub-5`. Keep using `https://unitmarket-sandbox-626887286871.europe-west3.run.app`.

Checks in the browser (try both skins):

1. On a wide window the "UnitMarket" name in the header starts at the same left edge as the page content and the footer. The right end of the header lines up with the page too.
2. Account page (signed in as a buyer account): the heading card, the password card and the sign-out card are the same width and start at the same left edge. The sign-up and sign-in pages look the same way.
3. Operations: the section tabs wrap onto more rows when the window is narrow. There is no sideways scrolling. Every tab is visible. The bar scrolls away with the page (it is no longer stuck under the header).
4. Operations still reads "Off: no PayPal calls" with the switch Off.

Paste back: the last two lines of the deploy output and what you saw. Never paste a passcode or password.

## Sixth deploy: tag `gcp-pub-6` (the hosted scope may move pounds, offer list follows corridors, seed lock)

Same steps as the fifth deploy, with the new tag. It adds **no database migration**. It carries four changes: the sealed transport allows `GBP` as well as `USD` for the hosted scope (EUR, JPY and XAU stay refused); the public offer list follows the enabled corridors; the boot seed takes a lock so two simultaneous starts cannot both seed (D-077); the Start route's 500 answer is typed (no behaviour change). The deploy still leaves PayPal off, and the pounds corridor is still switched off in the database, so buyers see no change until the owner step below. Do not deploy while anyone is testing.

Commit to deploy: the coordinator gives you the exact hash in the chat message that sends you here.

Step 1 (laptop with the repository):

```
COMMIT=PUT-THE-HASH-FROM-THE-CHAT-HERE
git fetch origin
git checkout "$COMMIT"
git status
git tag gcp-pub-6
git push origin gcp-pub-6
```

Step 2 (Cloud Shell, inside the `unitmarket-sandbox` folder):

```
PROJECT_ID=unitmarket-sbx-vr1
REGION=europe-west3
gcloud config set account unitmarket@raviprolu.com
gcloud config set project "$PROJECT_ID"
gcloud sql backups list --instance=unitmarket-sbx-pg --project="$PROJECT_ID"
git fetch --tags
git checkout gcp-pub-6
git log --oneline -1
bash infra/gcp/deploy.sh "$PROJECT_ID" "$REGION" gcp-pub-6
```

Expected: a successful backup less than a day old, `git log` shows the commit from the chat, and the output ends with `deployed unitmarket-sandbox from tag gcp-pub-6`.

Check in the browser: sign in, open Find articles and Operations. Everything looks as on `gcp-pub-5`, and Operations reads "Off: no PayPal calls". The app boots with no error.

### The real UK purchase (owner steps, after the deploy, one sitting)

1. Vikram checks in the PayPal sandbox dashboard that the owner's business account can receive pounds (GBP). Stop here if it cannot.
2. Vikram switches the pounds corridor on, at his own terminal through the Auth Proxy, as for the Northfield statement:

   ```
   psql "$LIVE" -c "update corridors set enabled = true where id = 'gb-gbp'"
   ```

   It prints `UPDATE 1`. To undo it: the same statement with `enabled = false`.

3. A UK buyer: on the sign-up page create a throwaway buyer account and give the country `GB`.
4. A new approval row for the sitting, written first in `docs/decision-log.md`: follow "Starting the PayPal sandbox gateway" above with a new reference of Vikram's choosing in place of `D-062`. The secret `UMS_OUTBOUND_APPROVAL_REF` must hold the same reference before the flag is set (the MATCH check in that section).
5. Start on Operations, set the flag on, and as the UK buyer buy the Northfield article "An allotment diary for a cold March" (£1.50). On the PayPal page check the amount, pay, and look for the article in the library. Then press Stop and set the flag off.

Paste back: the deploy output, the `UPDATE 1`, and a screenshot of the PayPal page and the library. Never paste a passcode or password.

## Seventh deploy: tag `gcp-pub-7` (USD, EUR and GBP everywhere, prices in the buyer's currency, exchange rates, awaiting seller acceptance, reporting totals)

Same steps as the sixth deploy, with the new tag. It adds **two database migrations**, so check the backup first:

- `0017_fx_rates`: the exchange rate table (append only, one sample row dated 2026-11-03).
- `0018_buyer_display_currency`: one optional column on buyers for the "Show prices in" setting.

What the deploy carries (decisions D-083 to D-087, plan `docs/specs/multi-currency-v2.md`):

- USD, EUR and GBP work for every offer and every approval. A buyer from any country may buy any enabled offer.
- Buyers see prices in their own currency as an estimate ("about", with the rate date), with the binding price in the seller's currency beside it. The setting is on the account page. If no usable rate exists, the seller's currency shows alone and nothing is blocked.
- The app fetches the daily rates from the European Central Bank on demand (at most once per six hours, 3 second limit). No firewall or allow-list step is needed: this project has no Cloud Run egress firewall. If a VPC egress firewall is ever added, `www.ecb.europa.eu` must be allowed. Until the first real fetch the pages say "sample rate of 3 Nov 2026" for seven days, then show the seller's currency alone.
- A payment that PayPal holds as pending shows "Awaiting seller acceptance", with two seller choices (wait, or list an offer in another currency). Nothing is converted for the seller.
- Operations has a new section "Totals by currency" (sales, refunds and exposure per currency, and a reporting view in USD, EUR and GBP).
- A German euro corridor (`de-eur`) and a fictional German seller (Rheinwerft Kurier) with three articles are seeded, switched off.
- The deploy still leaves PayPal off. Do not deploy while anyone is testing.

Commit to deploy: the coordinator gives you the exact hash in the chat message that sends you here.

Step 1 (laptop with the repository):

```
COMMIT=PUT-THE-HASH-FROM-THE-CHAT-HERE
git fetch origin
git checkout "$COMMIT"
git status
git tag gcp-pub-7
git push origin gcp-pub-7
```

Step 2 (Cloud Shell, inside the `unitmarket-sandbox` folder):

```
PROJECT_ID=unitmarket-sbx-vr1
REGION=europe-west3
gcloud config set account unitmarket@raviprolu.com
gcloud config set project "$PROJECT_ID"
gcloud sql backups list --instance=unitmarket-sbx-pg --project="$PROJECT_ID"
git fetch --tags
git checkout gcp-pub-7
git log --oneline -1
bash infra/gcp/deploy.sh "$PROJECT_ID" "$REGION" gcp-pub-7
```

Expected: a successful backup less than a day old, `git log` shows the commit from the chat, and the output ends with `deployed unitmarket-sandbox from tag gcp-pub-7`.

Check in the browser, in this order:

1. Home page and Find articles load. Prices look as on `gcp-pub-6` for a US buyer on US dollar offers.
2. Account page: a "Price display" block with a "Show prices in" choice. Pick "Euros (EUR)", save, open an article: the price reads "about €…" with a "Binding: $…" line and a rate date or "sample rate of 3 Nov 2026". Put the choice back to automatic.
3. Operations: switch reads "Off: no PayPal calls"; the new section "Totals by currency" shows rows or "No sales, refunds or held payments yet."; nothing else changed.
4. The app boots with no error in the Cloud Run logs.

Paste back: the deploy output and a screenshot of the article page with the "Binding" line. Never paste a passcode or password.

### Optional owner step: switch the pounds and euro corridors on (one statement each, at the owner's terminal through the Auth Proxy)

Only after the dashboard checks below. Both are off by default; offers in that currency then show in Find articles. No money moves until a purchase is made with PayPal on.

```
psql "$LIVE" -c "update corridors set enabled = true where id = 'gb-gbp'"
psql "$LIVE" -c "update corridors set enabled = true where id = 'de-eur'"
```

Each prints `UPDATE 1`. To undo: the same statement with `enabled = false`.

Dashboard checks first (Vikram, PayPal sandbox dashboard, Business account): its country, which currencies it can hold, whether it can receive GBP and EUR, its receiving preference (a setting that makes PayPal hold a payment in an unlisted currency as pending), and where past USD payments landed. Stop if it cannot receive the currency.

### Proposed approval for a GBP and EUR sitting (NOT inserted, not approved)

This is a proposal for Vikram to read. Nothing here has been run. A real sandbox purchase in pounds or euros needs Vikram's explicit "approve" at his own terminal, the decision row below written first in `docs/decision-log.md`, and then the approval row inserted by him with `safety:approve`.

Decision row text to propose (reference `D-082`; the cap has no currency, so it means the same figure in any allowed currency, D-086):

> D-082. Owner approval basis for the multi-currency sandbox sitting. Scope `mvp_c_refunds`, operations `oauth_token`, `create_order`, `get_order`, `capture_order`, `get_capture`, for orders in GBP and EUR (and USD) only, 500 minor units per PayPal order (£5.00, €5.00 or $5.00), 40 calls, valid for four hours from the insertion (write the exact UTC end time into the row), no refunds, no named payee, hosted app only, no overlap with another sitting. Approved by `vikram`.

Command to run at Vikram's terminal, after the "Starting the PayPal sandbox gateway" steps above with `D-082` as the reference (replace `END-UTC` with the end time written in the row):

```
corepack pnpm safety:approve --operator vikram --ref D-082 --scope mvp_c_refunds \
  --ops oauth_token,create_order,get_order,capture_order,get_capture \
  --max-amount 500 --max-calls 40 --valid-until END-UTC --approved-by vikram
```

The sitting itself: a buyer account with country `GB` buys the Northfield article "An allotment diary for a cold March" (£1.50); a buyer account with country `DE` buys one Rheinwerft Kurier article (€1.50 to €2.00). The buyer sees the price in the seller's currency as the binding amount. If PayPal holds the capture as pending, the screens read "Awaiting seller acceptance" (the receiving preference on the Business account decides this; it is the case D-083 plans for). Then press Stop and set the flag off, as above.

## Starting the PayPal sandbox gateway under D-090 (owner's own terminal only)

The approval basis is D-090: scope `mvp_c_refunds`, the five operations, USD, EUR and GBP, 500 minor units an order, 40 calls, four hours from the insertion, no refunds, no named payee. Run this only at the owner's own terminal, never in Cloud Shell or an AI session, and never paste a passcode, secret or order number into a chat. A deploy always leaves the connection off, so do this after the deploy you want to test on.

Step 1 (Cloud Shell): make the app look for the new reference. The flag step below starts a new revision that reads it.

```
gcloud config set project unitmarket-sbx-vr1
printf 'D-090' | gcloud secrets versions add UMS_OUTBOUND_APPROVAL_REF --data-file=- --project=unitmarket-sbx-vr1
```

Step 2, window 1 on the owner's terminal (leave open):

```
cloud-sql-proxy --port 5433 unitmarket-sbx-vr1:europe-west3:unitmarket-sbx-pg
```

Step 3, window 2, in the repository folder. The environment guard refuses a terminal that holds `DATABASE_URL` or `UMS_DB` and differs from `.env.local`, so the file is changed for a few minutes and restored afterwards:

```
git fetch --tags
git checkout gcp-pub-9
RAW="$(gcloud secrets versions access latest --secret=DATABASE_URL --project=unitmarket-sbx-vr1)"
export DATABASE_URL="$(printf '%s' "$RAW" | sed 's#@/\([^?]*\)?host=[^ ]*#@127.0.0.1:5433/\1#')"
unset RAW
cp .env.local .env.local.bak
grep -v -E '^(UMS_DB|UMS_PGLITE_DIR|DATABASE_URL|UMS_PAYPAL_CONNECT|UMS_OUTBOUND_APPROVAL_REF)=' .env.local.bak > .env.local
printf 'UMS_DB=postgres\nDATABASE_URL=%s\nUMS_OUTBOUND_APPROVAL_REF=D-090\n' "$DATABASE_URL" >> .env.local
unset DATABASE_URL UMS_DB
grep -E '^(UMS_MODE|UMS_OUTBOUND_SCOPE)=' .env.local
corepack pnpm safety:status
```

Expected: `UMS_MODE=sandbox`, `UMS_OUTBOUND_SCOPE=mvp_c_refunds`, and `mode=sandbox connect=off db=postgres`. Before the approval the status says no active approval. Check that the live app looks for the same reference (it prints only MATCH or DIFFERENT):

```
[ "$(gcloud secrets versions access latest --secret=UMS_OUTBOUND_APPROVAL_REF --project=unitmarket-sbx-vr1)" = "D-090" ] && echo MATCH || echo DIFFERENT
```

Step 4: insert the approval and turn the switch on. Each asks you to type `mvp_c_refunds`. The end time is four hours from now (Mac):

```
END=$(date -u -v+4H +%Y-%m-%dT%H:%M:%SZ); echo "$END"
corepack pnpm safety:approve --operator vikram --ref D-090 --scope mvp_c_refunds \
  --ops oauth_token,create_order,get_order,capture_order,get_capture \
  --max-amount 500 --max-calls 40 --valid-until "$END" --approved-by vikram
corepack pnpm safety:resume --operator vikram --reason "tester sitting D-090"
```

Write the printed `END` time down: it goes into the decision log as D-092 with the insertion time.

Step 5: restore and close, always:

```
mv .env.local.bak .env.local
unset DATABASE_URL UMS_DB
```

Then press Ctrl+C in the proxy window.

Step 6 (Cloud Shell): set the flag, wait for the new revision, and check Operations (switch On, calls left, "Approval reference set: yes", L3 yes):

```
gcloud run services update unitmarket-sandbox --region=europe-west3 --project=unitmarket-sbx-vr1 --update-env-vars=UMS_PAYPAL_CONNECT=on
```

To stop at any time: the "Stop PayPal now" button on Operations, or the same flag command with `UMS_PAYPAL_CONNECT=off`. The approval ends four hours after the insertion.

Pounds and euros: those offers appear only after the corridors are switched on with the two SQL statements in the seventh deploy section, and only after the PayPal dashboard checks. Dollar purchases need neither.
