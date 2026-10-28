# MVP-C owner steps (hosted webhooks and refunds)

For: Vikram, with Sakthi beside you or on a call. Time: about 2 to 3 hours in one sitting, plus the
host setup the day before. You type every command yourself in your own terminal, on your own machine.
The assistant never sees your credentials, never runs these steps and never holds a TOTP key.

This list proves the rows the offline gate could not: C-01 (a genuine webhook), the real halves of C-06
and C-07 (refunds executed and read back at PayPal), C-10 (restore drill, real part) and C-13 (uptime).
Read `docs/evidence/mvp-c-offline-gate-2026-10-25.md` first: it says what already passed offline and
which items were open decisions (all recorded now, see the table below). All rules of `docs/owner/SPIKE-RUNBOOK.md` ("What you
never share or paste anywhere", machine rules, refusal table) and of `docs/owner/MVPB-OWNER-STEPS.md`
apply here too. `docs/owner/MVPC-OWNER-NOTES.md` explains the operator keys.

Every decision this sitting depends on is recorded in `docs/decision-log.md`: O-C8 is D-037 (maintenance
mode, lane CO-7b, Steps 6 and 11), the certificate pin is D-038 (a learn-only window, lane CO-1d, Step 7),
and the accepted items are D-039 and D-040. Do not start the sitting until Sakthi confirms those lanes are
merged and deployed:

| Decision           | Where   | Status                                                                                                                                                                                                                                              |
| ------------------ | ------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| O-C8               | Step 6  | Decided: D-037 option (a), maintenance mode, built in lane CO-7b. Step 6 has the commands.                                                                                                                                                          |
| Cert pin           | Step 7  | Decided: D-038, a learn-only window, built in lane CO-1d. It needs the approval row (Step 6) and the connection (Step 8, items 1 and 2) first, because the app reads the certificate through the same locked connection as every other PayPal call. |
| Backup on the host | Step 11 | Decided with O-C8 (D-037): run in maintenance mode with --maintenance. Step 11 has the commands.                                                                                                                                                    |

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
window. After every later `git pull`, rebuild before you start the app locally:
`corepack pnpm --filter @umsbx/web build` (a stale build gives an internal 500). Use `http://localhost:3000`,
not the machine's network address.

If you host on Google Cloud, `docs/owner/MVPC-OWNER-STEPS-GCP.md` replaces Steps 2, 6, 8, 11 and 13 of this
document (it says which of its own steps does so) and adapts Steps 3, 4 and 7; Steps 1, 9, 10 and 12 still
apply as written.

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
2. Copy only your own `<name>:<secret>` line. No key line ever travels to the other operator: not by
   chat, e-mail, a ticket, a group message or this repository. Each operator types their own entry into
   the host settings (Step 2), nobody else's.
3. `UMS_OPERATOR_TOTP_KEYS` in Render holds the entries joined by a comma, with no spaces:
   `vikram:<secret>,sakthi:<secret>`. Build it one entry at a time, each by its owner. Vikram creates the
   value with his own entry only. Sakthi then opens the same variable in the Render dashboard himself,
   under his own Render login (if the plan lets Vikram add a second login), and appends
   `,sakthi:<secret>`. If Sakthi has no Render login, he adds his entry at Vikram's machine in person, with no screen share or recording running; otherwise the value holds Vikram's entry only for this sitting (Sakthi can still use Stop, which needs no code). Anyone who can open the service's Environment page can read the whole value, so that page is
   for the two operators only.
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
| `UMS_OPERATOR_TOTP_KEYS`                                                                 | Step 1: each operator enters their own `<name>:<secret>` entry; entries are joined by a comma.                                                 |
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
2. Check the proxy depth (ASM-57) with a test from outside, using `curl`. The depth must be right
   BEFORE the webhook is registered in Step 4: a wrong count lets one client fill the limiter bucket that
   PayPal's own deliveries share, or lets a client choose its own bucket. `UMS_TRUSTED_PROXIES=1` in
   `render.yaml` assumes exactly one proxy appends to `X-Forwarded-For`. The test uses the sign-in limiter
   (5 wrong passcodes per address and persona, then 429; one attempt comes back every 3 minutes, all 5 after 15 minutes) and the persona `buyer-b`, so
   `buyer-a` and the operator are not locked out. Put only the host name in the variable, no
   `https://`. The passcode value below is a made-up wrong one; never type the real passcode here.

   ```
   HOST=<your-service>.onrender.com
   ```

   (a) From machine A (your laptop on its usual network), make 5 wrong sign-ins and then a 6th:

   ```
   for i in 1 2 3 4 5 6; do
     curl -sS -o /dev/null -w "wrong sign-in $i: %{http_code}\n" -X POST "https://$HOST/api/session" \
       -H "Origin: https://$HOST" -H "Content-Type: application/json" \
       --data '{"persona":"buyer-b","passcode":"not-the-passcode-0000"}'
   done
   ```

   Expected: `401` five times, then `429` for the 6th. If the 6th is still `401`, the limiter is not
   counting. If a `429` comes before the 6th, other clients share your bucket (or you ran this less than 15 minutes ago). If you see `403`,
   `UMS_PUBLIC_ORIGIN` does not match the host name. In every such case STOP and tell Sakthi.

   (b) Straight after (a), within 3 minutes of its first request (later, a returned attempt answers 401 for that reason alone), from machine A again, send the 6th request with a forged
   `X-Forwarded-For` that you wrote yourself:

   ```
   curl -sS -o /dev/null -w "forged header: %{http_code}\n" -X POST "https://$HOST/api/session" \
     -H "Origin: https://$HOST" -H "Content-Type: application/json" \
     -H "X-Forwarded-For: 198.51.100.7" \
     --data '{"persona":"buyer-b","passcode":"not-the-passcode-0000"}'
   ```

   Expected: `429`. If it answers `401`, the setting trusts an entry your client wrote, so a client
   can pick its own bucket (the count is too high, or the platform appends nothing). STOP.

   (c) From a second network (your phone's hotspot: join machine B or your laptop to it, so the public
   address is not the one used in (a)), run one wrong sign-in, also within 3 minutes of the first request of (a) (the same reason):

   ```
   curl -sS -o /dev/null -w "second network: %{http_code}\n" -X POST "https://$HOST/api/session" \
     -H "Origin: https://$HOST" -H "Content-Type: application/json" \
     --data '{"persona":"buyer-b","passcode":"not-the-passcode-0000"}'
   ```

   Expected: `401`, not `429`. If it answers `429`, every client shares one bucket (more proxies than
   the count): an attacker could fill it and PayPal's valid deliveries would be turned away. STOP.

3. If (a), (b) and (c) all gave the expected codes, 1 is right and you go on. If any did not, do NOT
   register the webhook. Tell Sakthi what each of the three printed. The value is corrected in
   `render.yaml` through review (the checker pins `1`), not in the dashboard. The `buyer-b` bucket frees
   itself after 15 minutes; Step 4 does not depend on it.
4. Screenshot (crop out your address): the terminal with the three results, and `/ops` with the refund
   form. The output holds no secret and no address.

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

## Step 5: stop here until the decided lanes are merged and deployed

Confirm with Sakthi that lane CO-7b (maintenance mode, D-037) is merged and deployed for Steps 6 and 11,
and that lane CO-1d (the certificate learn window, D-038) is merged and deployed for Step 7. If not, you
can still do the local fallback at the end of this file.

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

## Step 7: the webhook certificate pin (D-038, learn only, 30 to 45 min)

Facts: the code carries the pin as a constant, `EXPECTED_CERT_PINS`: the exact certificate host, the
subject and the issuer. It is empty in the repository. While it is not complete the webhook answers 503
`disabled` to every delivery and does nothing (ASM-64), so a real delivery could never teach the app the
pin. D-038 adds a **learn window** for this one job. While it is open:

- every delivery to the webhook is answered 503 and **acts on nothing**: it is not verified, no event is
  stored, no read-back is scheduled, no order or money row changes;
- the app fetches the certificate the delivery names (only a `*.sandbox.paypal.com` certificate address,
  through the same locked connection, within the same call budget) and writes down only its host, path,
  subject, issuer, validity dates and SHA-256 fingerprint: one audit row and one log line,
  `webhook.cert_learned`. Never the body, the signature, the delivery id or anything after a `?`;
- the certificate is described, never trusted. The values count only after Sakthi commits them as the
  pin in a reviewed pull request and the reviewed tag is deployed (ASM-71).

Needs: Steps 2, 3, 4 and 6 done, and the connection on (Step 8, items 1 and 2: `UMS_PAYPAL_CONNECT=on`,
`/ops` shows all five locks open). The only PayPal call this step causes is the fetch of one certificate.

1. Decide the end of the window. It must be a UTC time of the form `2026-10-25T18:30:00Z`, no more than 24
   hours after the app starts. Sixty minutes ahead is plenty. Check your clock with `date -u` and write the
   time down.
2. Render dashboard, Environment: add `UMS_WEBHOOK_CERT_LEARN_UNTIL` with that time. Save and let it
   redeploy. If the time is malformed, more than 24 hours ahead, or the app is not in sandbox mode, the
   app does not start and the log has a line containing `invalid_value` and
   `UMS_WEBHOOK_CERT_LEARN_UNTIL` (the value is never printed): fix the time and redeploy. Open `/healthz` as in Step 2.
3. Send exactly one delivery. Either use the PayPal developer dashboard (Webhooks, Webhooks simulator,
   Sandbox, your webhook URL, event `CHECKOUT.ORDER.APPROVED`, Send Test), or start a real sandbox
   purchase as in Step 9 and let PayPal deliver. The dashboard shows `503` for the delivery. That is the
   expected answer, not a failure.
4. Read the result in the Render log (Logs tab). Expect exactly one line with `"msg":"webhook.cert_learned"`
   holding `host`, `path`, `subject_cn`, `subject`, `issuer`, `valid_from`, `valid_to` and
   `fingerprint_sha256`, and one `webhook.delivery` line with `http: 503`, `outcome: learning`,
   `learn: recorded`. The same facts are in the database as one `audit_log` row (action
   `webhook.cert_learned`, actor system); the `/ops` page does not list audit rows and the Render disk cannot
   be opened while the app runs, so the log line is how you read it here. `learn: known` means the same
   certificate was recorded already; `nothing` means no certificate could be read (check the locks and that the address in the delivery is a sandbox certificate address, fix what is wrong, then WAIT 10 MINUTES before sending again: a failed address is remembered for that long); `switch_off` means the webhook
   switch is off; `error` means the row could not be written (send one more delivery). Copy the log
   line as text; it holds no secret.
5. Check before you go on: the `host` ends in `.sandbox.paypal.com`, and only one certificate (one
   `fingerprint_sha256`) appears. If a second, different certificate appears, or the host is not what you
   expect, STOP and tell Sakthi: that is the finding. The app records at most 8 certificates and one row
   for each. The `subject` and `issuer` must contain no `sha256:` and no `[redacted]`; if the log says
   `webhook.cert_learn_unrecordable` instead, STOP and tell Sakthi (the app would have recorded a changed value, so it records nothing).
6. Close the window now: delete `UMS_WEBHOOK_CERT_LEARN_UNTIL` in the Render Environment and redeploy.
   Do not wait for the end time. It also closes by itself at the end time, but while it is open the app
   does not process any delivery, so it must not stay set after the pin is deployed.
7. Give Sakthi the `webhook.cert_learned` line. In a reviewed pull request (spec, tests, `corepack pnpm run ci`)
   he sets `EXPECTED_CERT_PINS` in `packages/paypal/src/webhook-cert.ts` to one entry with the logged
   `host`, `subject` and `issuer`, exactly as written, then merges. Deploy the reviewed tag (RLR-1).
   Until that is deployed the webhook still answers 503 `disabled`; PayPal retries for 3 days.
8. After the deploy, check the Render log: the next delivery is not `disabled` and not `learning`
   (the log line `webhook.delivery` shows `outcome` and `verdict`). A delivery from the simulator may fail
   the signature check because it is not a real event: the real proof is Step 9.

Write down: the end time you used, whether the log showed `learn: recorded`, the `host`, and the time you
removed the variable. If the certificate PayPal uses for the simulator differs from the one for real
events, the second one shows as a second `fingerprint_sha256` the next time you open a window; that is
unverified until Step 9 has run.

## Step 8: switch the connection on (5 min)

Only when Steps 3, 4 and 6 are done. Items 1 and 2 come before Step 7 (the certificate fetch needs the
connection); the rest waits until Step 7 is deployed.

1. Render dashboard, Environment: set `UMS_PAYPAL_CONNECT` to `on`. Save and let it redeploy.
2. Open `/ops`. All five locks open; transport `sandbox (approved)`; `paypal_outbound` on.
3. **Emergency stop at any time:** the "Stop PayPal now" button on `/ops` (an operator without a code can
   press it), or set `UMS_PAYPAL_CONNECT` back to `off` in the dashboard.

## Step 9: one genuine webhook delivery (C-01, 15 min)

Needs Step 7 finished: the pin is deployed and `UMS_WEBHOOK_CERT_LEARN_UNTIL` is removed (while the window is
open, every delivery is answered 503 `learning` and nothing is processed).

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
   `disabled`, `learning`, `unverifiable` or 400, write down which and stop: that is the finding, not a failure to hide.

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
   to `off` in the host settings (Render dashboard, or on Google Cloud the next deploy resets it to `off`)
   and let it redeploy. From your own terminal you can also run
   `corepack pnpm safety:stop --operator <name> --reason "end of MVP-C session"`.
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

Sakthi records the results in the gate report's owner-window rows. The pin constants come from the Step 7
learn window and are committed in a reviewed pull request.

## Local fallback for the refund rows only (no host, no webhook)

If the host decisions are late, C-06 and C-07 can be proven on your laptop exactly like MVP-B, with
scope `mvp_c_refunds`: follow `docs/owner/MVPB-OWNER-STEPS.md` Steps 1 to 4 (settings file, approval row
with `--scope mvp_c_refunds` and the operations from the approvals above, `safety:resume`, build and
start) with `UMS_OPERATOR_TOTP_KEYS` in your `.env.local`, then do Step 10 of this file against
`http://localhost:3000`. C-01 (the webhook) and C-13 (uptime) cannot be proven this way.
