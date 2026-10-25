# MVP-C owner steps (hosted webhooks and refunds)

For: Vikram, with Sakthi beside you or on a call. Time: about 2 to 3 hours in one sitting, plus the
host setup the day before. You type every command yourself in your own terminal, on your own machine.
The assistant never sees your credentials, never runs these steps and never holds a TOTP key.

This list proves the rows the offline gate could not: C-01 (a genuine webhook), the real halves of C-06
and C-07 (refunds executed and read back at PayPal), C-10 (restore drill, real part) and C-13 (uptime).
Read `docs/evidence/mvp-c-offline-gate-2026-10-25.md` first: it says what already passed offline and
which three items below are still open decisions. All rules of `docs/owner/SPIKE-RUNBOOK.md` ("What you
never share or paste anywhere", machine rules, refusal table) and of `docs/owner/MVPB-OWNER-STEPS.md`
apply here too. `docs/owner/MVPC-OWNER-NOTES.md` explains the operator keys.

Steps 6 and 11 use the maintenance mode of D-037 (lane CO-7b). Do not start the sitting until the
decisions in the decision log are recorded:

| Pending            | Where   | What is undecided                                                                                                                                                                                                              |
| ------------------ | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| O-C8               | Step 6  | Decided: D-037 option (a), maintenance mode, built in lane CO-7b. Step 6 has the commands.                                                                                                                                     |
| Cert pin           | Step 7  | How the webhook certificate pin is learned: Option A (a time-limited learn window, recorded in the decision log) or Option B (an owner-run fetch script). Until the pin is set the webhook answers 503 and stays off (ASM-64). |
| Backup on the host | Step 11 | Decided with O-C8 (D-037): run in maintenance mode with --maintenance. Step 11 has the commands.                                                                                                                               |

## Before the day (written approvals and host setup, no PayPal contact)

1. MVP-B is finished and `docs/evidence/` holds its sanitised results. The MVP-B approval row (D-035)
   expires on 2026-10-26; MVP-C needs a new reference because `approval_ref` is unique and append-only
   (ASM-51).
2. You have written to Sakthi, in your own words:
   - "I approve MVP-C sandbox calls: scope mvp_c_refunds, operations oauth_token, create_order,
     get_order, capture_order, get_capture, refund_capture, get_refund and fetch_webhook_cert, at most
     20 USD per order, 300 calls a day, valid until <date, at most 7 days ahead>."
   - How the O-C8 and certificate-pin decisions went (Steps 6 and 7), by name.
3. Sakthi has merged the decision-log rows and tells you the approval reference, called `D-0xx` below.
   Pull `main` and use a reviewed tag for the deploy (RLR-1).
4. Host prerequisites, all yours (the repository and the host are the only accounts you add):

| Id   | What                                                                                         | Done when                                                     |
| ---- | -------------------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| O-C1 | A GitHub remote for the repository (Render deploys from Git).                                | Sakthi can see the reviewed tag there.                        |
| O-C2 | A Render account, a card, the paid `starter` plan with a 1 GB disk (about USD 7.25 a month). | The dashboard offers the Blueprint import.                    |
| O-C3 | A webhook in the PayPal developer dashboard (Step 4).                                        | You hold its Webhook ID.                                      |
| O-C4 | The MVP-C approval row (Step 6).                                                             | `safety:status` or `/ops` shows the budget line.              |
| O-C5 | TOTP enrolment for Vikram and Sakthi (Step 1).                                               | Both can sign in to `/ops` with a code.                       |
| O-C6 | The waiver for real-Postgres race tests (ASM-55, PORT-1) is recorded.                        | A decision row names it.                                      |
| O-C7 | A spend alert and a reminder to cancel the host after 15 Dec 2026 (COST-4).                  | The reminder is in your calendar.                             |
| O-C8 | The approval-row path to the host (Step 6).                                                  | D-037 names option (a) and lane CO-7b is merged and deployed. |

## Step 0: machine check (5 min)

```
eval "$(fnm env)" && fnm use 22.22.0
node -v                                  # v22.22.0
corepack pnpm -v                         # 10.34.7
cd path/to/unitmarket-sandbox
git fetch --tags && git status --short   # prints nothing
git checkout <the reviewed tag>
corepack pnpm install --frozen-lockfile
corepack pnpm run ci                      # ends without an error (takes several minutes)
```

Off any VPN. A normal terminal window. No proxy variables. Run the first line in every NEW terminal
window.

## Step 1: enrol the operators' authenticator keys (O-C5, 10 min each, on each operator's own machine)

Vikram and Sakthi each do this on their own computer, in their own terminal. Nobody else, and never in
a cloud session: whoever holds a key can make the codes that unlock refunds.

```
corepack pnpm totp:enrol --operator vikram
```

(Sakthi types `--operator sakthi`.) It refuses without a real terminal, in CI and in an AI session.
Expected output: one line `<name>:<base32 secret>` and one `otpauth://` link.

1. Scan the link (or type the secret) into your authenticator app. The account is named
   `UnitMarket Sandbox`.
2. Copy only your own `<name>:<secret>` line. Sakthi sends Vikram his line over a private channel he
   already trusts for secrets (not a ticket, not a chat group, not this repository), or types it
   into the Render dashboard himself in Step 2.
3. The value for Render is the two lines joined with a comma, with no spaces:
   `vikram:<secret>,sakthi:<secret>`. Keep it in your password manager until Step 2.
4. Clear the terminal scrollback and the clipboard. Never paste the secret or the link anywhere else.
   Do not screenshot this step.

Check (after Step 3): signing in to `/ops` as `operator` with your name, the passcode and a current code
shows the refund form; signing in with no code shows no refund form.

## Step 2: deploy the Render blueprint (O-C2, 30 min)

`render.yaml` describes one web service, one instance, one 1 GB disk at `/var/data`, auto-deploy off.
`corepack pnpm check:hosting` (part of `ci`) already passed in Step 0.

1. In Render: New, Blueprint, connect the repository, pick the reviewed tag's branch. Pull-request
   previews stay OFF. Choose a region. Do not add `NODE_OPTIONS`, a proxy or a CA variable anywhere.
2. Render asks for a value for each name marked `sync: false`. Enter them in the dashboard only:

| Name                                                                                     | Where the value comes from                                                                                                                     |
| ---------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `PAYPAL_CLIENT_ID`, `PAYPAL_CLIENT_SECRET`                                               | The Sandbox tab of Apps and Credentials. The ROTATED secret, as in MVP-B.                                                                      |
| `UMS_SESSION_SECRET`, `UMS_APPROVAL_SECRET`, `UMS_LINK_SECRET`, `UMS_DEMO_PASSCODE_HASH` | `corepack pnpm owner:secrets` (type a passcode of at least 12 characters twice). Four `NAME=value` lines; the hash line starts with `scrypt:`. |
| `UMS_OPERATOR_TOTP_KEYS`                                                                 | Step 1, `vikram:<secret>,sakthi:<secret>`.                                                                                                     |
| `UMS_OUTBOUND_APPROVAL_REF`                                                              | `D-0xx`, the new MVP-C reference.                                                                                                              |
| `UMS_PUBLIC_ORIGIN`                                                                      | `https://<your-service>.onrender.com`, exactly, with no trailing slash.                                                                        |
| `PAYPAL_WEBHOOK_ID`                                                                      | Leave empty for now; Step 4 gives you the value. If Render insists on a value, enter the word `pending` and replace it in Step 4.              |

3. `UMS_PAYPAL_CONNECT` stays `off` (the file value). The check refuses `on` in the file; you flip it in
   the dashboard in Step 8 and only then. A later Blueprint sync puts it back to `off`, which is the safe
   direction.
4. Deploy manually from the reviewed tag. Never raise the instance count above 1: two processes must
   never share one PGlite folder.
5. Open `https://<your-service>.onrender.com/healthz`. Expected: `{"ok":true,"environment":"sandbox"}`.
   Screenshot: the Render service page (Events tab, deploy live) and the `/healthz` answer.

Render settings that cannot be checked offline and must be confirmed on import (write what you saw):
`runtime: node`, plan `starter`, `numInstances: 1`, `autoDeploy: false` (Render may call it
`autoDeployTrigger: off`; if so tell Sakthi, the checker and the file change together), health check
`/healthz`, disk `pglite-data` at `/var/data` of 1 GB, `NODE_VERSION` 22.22.0 available.

## Step 3: first sign-in, and the proxy depth check (ASM-57, 20 min)

Do this BEFORE the webhook is registered or switched on (hosting.md step 5).

1. In a Chrome Incognito window open `https://<your-service>.onrender.com` and sign in as `buyer-a` with
   your passcode. Then open `/ops`, sign in as `operator` with your name, the passcode and a current code.
   The "Outbound approval gate" block shows mode `sandbox` with the approval lock reading NO, "Calls left
   today" says `No active approval.`, and the Refunds section shows its form (without a code it says
   "Refunds need a sign-in with your authenticator code").
2. Check the proxy depth. `UMS_TRUSTED_PROXIES=1` in `render.yaml` assumes exactly one proxy appends to
   `X-Forwarded-For` (ASM-57, unverified). Method: from a machine whose public address you know, make
   one request to `/healthz`. In the Render request log read the raw `X-Forwarded-For` of that request,
   or temporarily log it, and count the entries the platform appended. One entry appended means 1 is
   right. Remove any temporary logging afterwards.
3. Write down the count. A wrong count is worse than 0:
   - more proxies than 1: every client shares one limiter bucket, so an attacker's 60 refusals a minute
     would make the webhook limiter turn PayPal's valid deliveries away with 429;
   - fewer than 1: a client chooses its own bucket and the limiter stays empty.
     If the count is not 1, STOP: do not register the webhook. Tell Sakthi. The value is corrected in
     `render.yaml` through review (the checker pins `1`), not in the dashboard.
4. Screenshot (crop out your address): the log line count, and `/ops` with the refund form.

## Step 4: register the webhook at PayPal (O-C3, 10 min)

1. Developer dashboard, Apps and Credentials, Sandbox, your app, Webhooks, Add Webhook.
2. Webhook URL: `https://<your-service>.onrender.com/api/webhooks/paypal`.
3. Events (these and no others): `PAYMENT.CAPTURE.COMPLETED`, `PAYMENT.CAPTURE.PENDING`,
   `PAYMENT.CAPTURE.DECLINED`, `PAYMENT.CAPTURE.DENIED`, `PAYMENT.CAPTURE.REFUNDED`,
   `PAYMENT.CAPTURE.REVERSED`, `CHECKOUT.ORDER.APPROVED`, `CHECKOUT.PAYMENT-APPROVAL.REVERSED`.
4. Save. Copy the **Webhook ID** into Render as `PAYPAL_WEBHOOK_ID` (dashboard only; it is not printed
   anywhere else) and redeploy the same tag. The app verifies each delivery against this id.
5. Screenshot: the webhook list row with the Webhook ID hidden.

The app answers 503 to every delivery for now (the pin is empty and no approval exists). PayPal retries
for 3 days, so nothing is lost.

## Step 5: stop here until the three decisions are recorded

Confirm with Sakthi that lane CO-7b (maintenance mode, D-037) is merged and deployed for Steps 6 and 11.
If not, you can still do the local fallback at the end of this file.

## Step 6: the approval row and the switch on the host (O-C8, D-037, 25 min)

Why this is needed: `safety:approve` and `safety:resume` open the PGlite folder on the Render disk, and
the running app holds it (the single-opener lock), so both refuse while the app runs normally. The fix is
the maintenance mode of decision D-037 (lane CO-7b): while a flag file exists, the app starts without
opening the database, without the job loop and without any PayPal transport, so the two commands can run
in the Render shell. You make the flag and remove it yourself, in the Render shell. Nothing in the app
creates or removes it, and the app cannot reach PayPal while it exists.

Before you start: Steps 1 to 4 are done, the service is deployed from the reviewed tag with that tag's
`render.yaml` (it carries `UMS_MAINTENANCE_FLAG=/var/data/ums-maintenance`), and
`UMS_OUTBOUND_APPROVAL_REF` in the dashboard is the new reference `D-0xx`. `UMS_PAYPAL_CONNECT` stays
`off`. You type everything yourself. Do not paste a command through a script or a pipe: the tools check
for a real terminal and a person (see 4).

1. Make the flag. Render dashboard, your service, **Shell** tab (this opens a shell on the running
   instance). Type:

   ```
   touch /var/data/ums-maintenance
   ls -l /var/data
   ```

   Expected: a line for `ums-maintenance` (size 0) next to `pglite`.

2. Restart the service so it boots in maintenance mode (Render dashboard: the service's menu, **Restart
   service**; the shell closes, that is expected). Wait for the restart, then open
   `https://<your-service>.onrender.com/healthz`. Expected:

   ```
   {"ok":true,"environment":"sandbox","maintenance":true}
   ```

   Any other page answers `503` with the code `maintenance`. If `/healthz` does not say
   `"maintenance":true`, stop: the flag is not where the app looks, or the restart did not happen. Do
   not go on. Screenshot the `/healthz` answer.

3. Open the **Shell** tab again. If `ls package.json` does not find the repository, `cd` to the folder
   Render opened for you at deploy (Render's usual place is `/opt/render/project/src`; not checked here).
   Check that the tool sees the database free and no approval yet:

   ```
   corepack pnpm safety:status
   ```

   Expected: a line `mode=sandbox connect=off db=pglite-disk`, six `switch ...` lines with
   `paypal_outbound=off`, and `budget: no active approval for the configured reference`. If it says
   `The UnitMarket app (pid ...) holds this database`, the app is not in maintenance mode: go back to 2.

4. Insert the approval row. Replace `<YYYY-MM-DDT23:59:00Z>` with a date at most 7 days ahead, and use
   your `D-0xx`:

   ```
   corepack pnpm safety:approve --operator vikram --ref D-0xx --scope mvp_c_refunds \
     --ops oauth_token,create_order,get_order,capture_order,get_capture,refund_capture,get_refund,fetch_webhook_cert \
     --max-amount 2000 --max-calls 300 --valid-until <YYYY-MM-DDT23:59:00Z> --approved-by vikram
   ```

   Expected: one line `Approving oauth_token, create_order, ... up to 2000 minor units, 300 calls a
day, until <date>.`, then the question `Type the scope name (mvp_c_refunds) to confirm:`. Type
   `mvp_c_refunds` and press Enter. Expected: `approval D-0xx recorded`.

   If it prints `safety: refused: not_a_tty`, the Render shell does not give the tool a terminal. Stop.
   Do not work around it (no pipe, no `script`, no here-document). Tell Sakthi; nothing was written.
   Whether Render's web shell passes this check on your plan has not been checked.

5. Turn the switch on:

   ```
   corepack pnpm safety:resume --operator vikram --reason "MVP-C session"
   ```

   Expected: `Turning paypal_outbound on for approval D-0xx: scope mvp_c_refunds, 300 calls a day, up to
2000 minor units per order.`, then the same question; type `mvp_c_refunds`. Expected:
   `paypal_outbound is now on for mvp_c_refunds under approval D-0xx`.

6. Check, and screenshot (it holds no secret):

   ```
   corepack pnpm safety:status
   ```

   Expected: `switch paypal_outbound=on` and
   `budget D-0xx: 300 of 300 calls left today; per-order cap 2000 minor; valid until <date>; operations ...`.
   `connect=off` is still right: the connect flag is Step 8.

7. Remove the flag and restart. In the same shell:

   ```
   rm /var/data/ums-maintenance
   ls -l /var/data
   ```

   Expected: only `pglite` (and anything you put there yourself). Restart the service as in 2. Then
   `/healthz` must answer `{"ok":true,"environment":"sandbox"}` with no `maintenance` field. If it still says
   `"maintenance":true`, the flag is still there or the restart did not happen.

What stays true throughout: the app made no PayPal call while the flag existed, the approval row is
append-only and bounded by the scope, amount, call budget and date you typed, the connect flag is still
`off`, and the kill switch and the other locks are as before. Do not set `UMS_PAYPAL_CONNECT=on` before
Steps 3, 4 and 7 are done.

If something goes wrong, the safe way out is always the same: leave the flag in place (the app does
nothing), tell Sakthi what the last command printed, and do not retry with other flags.

## Step 7: the webhook certificate pin , DECISION PENDING

Facts: the code carries the pin as constants (`EXPECTED_CERT_SUBJECTS`, empty in the repository). While it
is empty the webhook stays off under the MVP-C scope (ASM-64), so a first genuine delivery cannot teach
the app anything unless one of the two options below exists. Hosted MVP-C needs the exact certificate
host, subject CN and issuer DN pinned. Nothing in the repository builds either option.

| Option | What it would be                                                                                                                                                                                                                                                                                                                                           | Decision         |
| ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------- |
| A      | A time-limited **learn window** recorded in the decision log: for a stated period (for example 30 minutes, with a reference `D-0xx`) the app records the host, subject CN and issuer DN of the certificate that signed the first verified delivery, then turns the window off. The values are then committed as constants through a reviewed pull request. | DECISION PENDING |
| B      | An **owner-run fetch script**: at your own terminal you run a script that fetches the certificate URL PayPal names in the first delivery, prints the host, subject CN and issuer DN, and writes nothing else. You give the printed values to Sakthi, who commits them as constants through a reviewed pull request.                                        | DECISION PENDING |

Either way, the order is: learn the values once, commit them as constants in a reviewed pull request,
redeploy the reviewed tag, and only then does the webhook accept deliveries. The assistant does not
choose between A and B and builds neither. Write the decision here when it exists:
`D-0xx = option ___`.

After the pin is committed and deployed, check from `/ops` or the Render log that the first delivery that
arrives is not answered `disabled` (the log line `webhook.delivery` shows `outcome` and `verdict`).

## Step 8: switch the connection on (5 min)

Only when Steps 3, 4, 6 and 7 are done.

1. Render dashboard, Environment: set `UMS_PAYPAL_CONNECT` to `on`. Save and let it redeploy.
2. Open `/ops`. All five locks open; transport `sandbox (approved)`; `paypal_outbound` on.
3. **Emergency stop at any time:** the "Stop PayPal now" button on `/ops` (an operator without a code can
   press it), or set `UMS_PAYPAL_CONNECT` back to `off` in the dashboard.

## Step 9: one genuine webhook delivery (C-01, 15 min)

1. In a Chrome Incognito window sign in as `buyer-a`, open the first offer, choose an online option,
   tick the terms, press Approve. Check the address bar starts with `https://www.sandbox.paypal.com`,
   log in as the sandbox Personal account and approve. You return; the library shows the item.
2. PayPal now sends `CHECKOUT.ORDER.APPROVED` and `PAYMENT.CAPTURE.COMPLETED` to the webhook.
3. Expected in the Render log: `webhook.delivery` lines with `http: 200`, `verdict: verified` and an
   `outcome` of `enqueued` (or `no_op` if the order was already settled). It never says the order is paid
   on its own account: the order was already `paid` from the buyer's return, and the delivery only made one
   read-back due. Between them the log shows at most one read-back per order within a minute.
4. In the PayPal dashboard, Webhooks events (Sandbox): each delivery to your URL shows `200`.
5. Screenshot: the dashboard delivery list (status 200), the library entry and the receipt. Copy the
   log lines `webhook.delivery` as text (they hold no body, no signature, no id). If a delivery shows
   `disabled`, `unverifiable` or 400, write down which and stop: that is the finding, not a failure to hide.

## Step 10: a real partial refund and the remainder, with MFA (C-06, C-07 real halves, 25 min)

1. As `buyer-a` buy a second online item (or use the one from Step 9).
2. In a second Incognito window sign in at `/ops` as `operator` with YOUR name, the passcode and a
   current authenticator code. Without the code the refund form does not appear and the route answers 403.
3. Refund part of it: on the unit's card enter an amount below the price (for example 1.50 of 4.50) and a
   reason of at least 3 characters, then press the button. Expected: state `completed`, unit `partially_refunded`. The buyer's
   library says "Partially refunded: your access continues"; the receipt is version 2 with one refund line.
4. On another small refund press the button twice quickly: only one refund happens (the second press is
   the same request, or the page is already updating).
5. Refund the rest (leave the amount empty, "the rest"). Expected: unit `refunded`, library "Refunded:
   access has ended", the receipt is version 3 with two refund lines, the item can no longer be opened.
6. For the keep-and-download item: buy it, refund it in full once. Expected: "Refunded: links have
   stopped. The copy you downloaded cannot be recalled." and a receipt of version 2.
7. In the PayPal sandbox dashboard open the Business account's activity: each refund is listed against the
   capture. Screenshot it cropped to date, amount and status.
8. Back in the library, the read-back is the proof: nothing is shown as refunded before PayPal's own answer.
9. Within a minute or two the webhook should also deliver `PAYMENT.CAPTURE.REFUNDED`: the log shows
   `webhook.delivery`, and the access stays revoked (a replay never gives it back).

If a refund is refused, copy the plain-words message exactly; it is data.

## Step 11: backup and restore drill (C-10, 30 min)

Offline drill (works today, on your laptop, no host, no PayPal):

```
corepack pnpm vitest run --project integration scripts/restore.integration.test.ts
```

Expected: all tests pass (tarball restore and logical-export restore both give the same row counts and
ledger sums; a changed byte in either file refuses; a non-empty target refuses).

Hosted drill, in the Render shell, with the app in maintenance mode: Step 6 items 1 and 2 done, and
/healthz says "maintenance":true. If it does not, stop.

```
node scripts/backup.mjs --dir /var/data/pglite --out /var/data/backup-<YYYYMMDD> --maintenance
node scripts/restore.mjs --from /var/data/backup-<YYYYMMDD> --dir /var/data/pglite-drill --maintenance
```

Both must end without refused, and the restore's row counts must equal the backup's. The drill restores
into a new folder and never replaces /var/data/pglite. Afterwards run
`rm -rf /var/data/pglite-drill /var/data/backup-<YYYYMMDD>` (the backup holds session data), then
`rm /var/data/ums-maintenance` and restart as in Step 6 item 7. A real recovery (swapping the folder) is a
separate procedure: ask Sakthi. A restored database has paypal_outbound off, so Step 6 items 5 and 6 must
be repeated.

Pass condition from C-10: the latest dump restores to a fresh host within 30 minutes, the logical export
restores into stock Postgres, and the orders match PayPal read-backs. Approval rows are kept in a restore
and a live one makes it refuse unless you say so.

Write what you did and how long it took. Never copy a backup anywhere shared: it holds session data.

## Step 12: uptime check (C-13, 10 min)

Add one external uptime monitor (any service you trust; a free one is enough) that fetches
`https://<your-service>.onrender.com/healthz` and one buyer page every 5 minutes and alerts BOTH of
you. Screenshot the monitor's settings page (no tokens) and, a day later, its report. REL-1 is 99.5
percent a month.

## Step 13: finish (10 min)

1. Press "Stop PayPal now" on `/ops` (reason "end of MVP-C session"), then set `UMS_PAYPAL_CONNECT` back
   to `off` in the Render dashboard and let it redeploy.
2. Confirm `/ops` shows `paypal_outbound` off and the transport line not approved.
3. Close the terminals, clear the clipboard and the scrollback. If any secret was ever pasted somewhere
   it should not have been, rotate it within the hour and note it in `docs/decision-log.md` (Credentials
   rule).
4. Check the cost alert and the cancel-by reminder (15 Dec 2026).

## What to bring back to Sakthi

1. A line per step: done, skipped, or what you saw instead; the numbers asked for in Steps 3, 6, 7 and 11.
2. The Step 3 proxy count. If it was not 1, stop and bring only that.
3. The `webhook.delivery` log lines (text) from Steps 9 and 10, and the dashboard delivery list.
4. The screenshots named above. Do not screenshot an address bar that contains `token=`, the
   Step 1 output, the Environment page of Render, or any page showing a client id or secret.
5. The text of the Step 8 and Step 13 `/ops` gate blocks.
6. Anything that surprised you, especially: a delivery answered other than 200, a refund word you
   did not expect, a lock shown missing, a restore that took longer than 30 minutes.

Sakthi records the results in the gate report's owner-window rows and, if the first genuine delivery
taught the certificate host, subject and issuer, turns them into the pin constants in a reviewed pull
request.

## Local fallback for the refund rows only (no host, no webhook)

If the host decisions are late, C-06 and C-07 can be proven on your laptop exactly like MVP-B, with
scope `mvp_c_refunds`: follow `docs/owner/MVPB-OWNER-STEPS.md` Steps 1 to 4 (settings file, approval row
with `--scope mvp_c_refunds` and the operations from the approvals above, `safety:resume`, build and
start) with `UMS_OPERATOR_TOTP_KEYS` in your `.env.local`, then do Step 10 of this file against
`http://localhost:3000`. C-01 (the webhook) and C-13 (uptime) cannot be proven this way.
