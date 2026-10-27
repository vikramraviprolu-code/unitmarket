# MVP-C owner steps on Google Cloud (GCP-1, D-049)

For: Vikram, with Sakthi beside you or on a call. This file replaces only the host-specific steps of
`docs/owner/MVPC-OWNER-STEPS.md` (Render, Steps 2, 6, 8 and 11 there). Everything else in that file
holds as written: the approvals before the day, Step 0 (machine check), Step 1 (operator keys), Step 3
(proxy depth), Steps 4, 7, 9, 10 (webhook, learn window, genuine delivery, refunds), Step 12 (uptime)
and Step 13 (finish). Where this file says "Step N" without a name, it means that file. The rules of
`docs/owner/SPIKE-RUNBOOK.md` ("What you never share or paste anywhere") apply.

Who does what: you run the commands in Cloud Shell with your own Google login. The assistant never sees
your Google login, never runs gcloud and never holds a secret (D-049). Whatever you paste back is
non-secret output only. The kit is in `infra/gcp` and is checked by `corepack pnpm check:hosting-gcp`
(part of `ci`).

Placeholders: `PROJECT_ID` is your Google Cloud project id and `REGION` a region such as `europe-west1`.
Neither is written in the repository. `TAG` is the reviewed tag Sakthi tells you.

## What this builds

One Cloud Run service `unitmarket-sandbox`: exactly one instance (min 1, max 1), CPU always allocated,
2 GiB, public HTTPS (PayPal's webhooks must reach it; the app verifies every delivery itself). One Cloud
SQL for PostgreSQL 16 instance with daily backups, point in time recovery, deletion protection, no
authorized networks, reached only through the Cloud SQL connector. Secrets in Secret Manager, mapped to
the service by name. A runtime service account that can read those secrets and use Cloud SQL, nothing
else. Maintenance mode (D-037) is not used on this host: the operator commands run at your own terminal
through the Cloud SQL Auth Proxy (Step I).

Cost, own estimate, UNVERIFIED: a Cloud Run instance that is always on with 1 vCPU and 2 GiB is roughly
USD 55 a month at list price, the `db-g1-small` database roughly USD 30. Check the pricing calculator
before you start. Section "Cancel" below ends it.

## Step A: before you start (15 min)

1. A Google Cloud project with billing linked (console, Billing). Note the project id.
2. Open Cloud Shell (the terminal icon in the console), signed in as yourself.
3. Get the code at the reviewed tag:

   ```
   git clone <the repository URL Sakthi gives you> unitmarket-sandbox
   cd unitmarket-sandbox
   git fetch --tags
   git checkout TAG
   ```

4. Set the two values for this window (nothing secret):

   ```
   PROJECT_ID=<your project id>
   REGION=<your region>
   ```

   Run these two lines again in every new Cloud Shell window.

## Step B: create the resources (setup.sh, 15 min)

The Postgres adapter and the Postgres wiring (lanes PG-1 and PG-2) are merged on main, so the app can start on Postgres. `setup.sh` starts the database (about USD 30 a month), so run it when you are ready to deploy.

```
bash infra/gcp/setup.sh "$PROJECT_ID" "$REGION"
```

It enables the APIs, creates the image repository, the runtime service account, the empty secret
containers, the database instance (about 10 minutes), the database and its user, and stores a generated
password only inside the `DATABASE_URL` secret. It is safe to run again. If it says billing is not
linked, link it and run it again.

Paste back (non-secret): the `setup done` block it prints (region, sql connection, runtime account name,
image repository, expected service URL). If any step failed: the last 10 lines.

## Step C: store the secrets (set-secret.sh, 15 min)

Nine names. For each, run the line, then type the value twice at the hidden prompt. Nothing is shown. It
refuses without a real terminal, so do not pipe into it.

```
bash infra/gcp/set-secret.sh "$PROJECT_ID" "$REGION" PAYPAL_CLIENT_ID
bash infra/gcp/set-secret.sh "$PROJECT_ID" "$REGION" PAYPAL_CLIENT_SECRET
bash infra/gcp/set-secret.sh "$PROJECT_ID" "$REGION" PAYPAL_WEBHOOK_ID
bash infra/gcp/set-secret.sh "$PROJECT_ID" "$REGION" UMS_OUTBOUND_APPROVAL_REF
bash infra/gcp/set-secret.sh "$PROJECT_ID" "$REGION" UMS_SESSION_SECRET
bash infra/gcp/set-secret.sh "$PROJECT_ID" "$REGION" UMS_APPROVAL_SECRET
bash infra/gcp/set-secret.sh "$PROJECT_ID" "$REGION" UMS_LINK_SECRET
bash infra/gcp/set-secret.sh "$PROJECT_ID" "$REGION" UMS_DEMO_PASSCODE_HASH
bash infra/gcp/set-secret.sh "$PROJECT_ID" "$REGION" UMS_OPERATOR_TOTP_KEYS
```

Where each value comes from is the table in Step 2 of the Render file, with these differences:
`PAYPAL_WEBHOOK_ID` is the word `pending` until Step 4 gives you the real id (then run the same line again
with the real value and redeploy, Step F); `UMS_PUBLIC_ORIGIN` is not stored here, it is a plain value in
`infra/gcp/service.yaml` (Step E). The four server secrets and the passcode hash come from
`corepack pnpm owner:secrets` run on your own machine, never in Cloud Shell history you cannot clear.
`UMS_OPERATOR_TOTP_KEYS` is one secret holding every operator's entry joined by a comma. Per the Step 1
rule no entry travels to the other operator: this sitting stores your own entry only
(`vikram:<secret>`). Sakthi can still use Stop, which needs no code.

Paste back: the lines `stored: <NAME> version <n>` (name and number only).

## Step D: check the secrets exist (no values shown)

```
gcloud secrets list --project="$PROJECT_ID" --format='value(name)'
```

Expected: ten names, the nine above and `DATABASE_URL`.

## Step E: the service address (reviewed change, before the first deploy)

`infra/gcp/service.yaml` holds `UMS_PUBLIC_ORIGIN: 'https://pending.invalid'`. The app refuses browser
sign-in while the origin does not match the address in the browser (the CSRF check), so the real address
goes in through a reviewed change, then a new reviewed tag.

1. Take the expected service URL from the `setup done` block (UNVERIFIED form:
   `https://unitmarket-sandbox-<project number>.<region>.run.app`, no trailing slash).
2. Tell Sakthi. He sets that value in `infra/gcp/service.yaml` through a pull request
   (`corepack pnpm check:hosting-gcp` accepts a `run.app` origin), merges, and tags. `git fetch --tags`
   and `git checkout NEWTAG`.
3. If the first deploy prints a different URL, the deploy tells you so; repeat steps 2 and 3 with the
   printed one.

## Step F: deploy (deploy.sh, 15 min)

```
bash infra/gcp/deploy.sh "$PROJECT_ID" "$REGION" TAG
```

It refuses unless the checkout is exactly the tag, clean, every secret has a value and the database is
running. Then Cloud Build builds the image (about 10 minutes the first time) and Cloud Run deploys it
from `service.yaml`, with `UMS_PAYPAL_CONNECT=off`. Open `https://<service URL>/healthz`. Expected:
`{"ok":true,"environment":"sandbox"}`. The app logs `maintenance.unconfigured` once at boot; that is
expected (D-044).

Redeploying the same tag keeps the image and makes a new revision, which also picks up a changed secret.
A redeploy always puts `UMS_PAYPAL_CONNECT` back to `off`.

Paste back: the `deployed ...` and `service URL:` lines, and the `/healthz` answer.

If the build stops with a permission error naming the Compute Engine default service account, UNVERIFIED
fix (grants the build roles to that account in your own project; run once, then run deploy.sh again):

```
PROJECT_NUMBER="$(gcloud projects describe "$PROJECT_ID" --format='value(projectNumber)')"
gcloud projects add-iam-policy-binding "$PROJECT_ID" \
  --member="serviceAccount:${PROJECT_NUMBER}-compute@developer.gserviceaccount.com" \
  --role=roles/cloudbuild.builds.builder --condition=None
```

If Cloud Run refuses `--allow-unauthenticated`, an organisation policy forbids public services; tell
Sakthi, do not work around it.

## Step G: first sign-in and the proxy depth check (Step 3)

Do Step 3 as written with `HOST=<the service host name, no https://>` (the part of the URL after
`https://`). Cloud Run's front end adds the caller's address to `X-Forwarded-For`; whether that is
exactly one entry has not been checked, which is why `UMS_TRUSTED_PROXIES` is `1` only until this test
passes. If (a), (b) or (c) gives another answer, do not register the webhook: tell Sakthi what each
printed. The count is corrected in `infra/gcp/service.yaml` through review (the checker pins `1`) and
deployed with a new tag.

## Step H: uptime and budget alerts (monitoring.sh, C-13, 10 min)

```
bash infra/gcp/monitoring.sh "$PROJECT_ID" "$REGION" <your e-mail> <Sakthi's e-mail> <monthly budget>
```

Two uptime checks every 5 minutes (`/healthz` and the buyer home page `/`), an alert policy for each that
e-mails both of you, and a monthly budget alert at 50, 90 and 100 percent of the amount you give (a plain
number in your billing currency, for example 60). The e-mail addresses go on the command line; they are
not stored in the repository. Screenshot the Monitoring uptime page (no tokens); a day later, its report.

## Step I: the operator commands through the Auth Proxy (replaces Steps 6 and 8, 25 min)

`safety:approve`, `safety:resume` and `safety:stop` write to the hosted database, so they run at YOUR
terminal on YOUR machine (not Cloud Shell, not an AI session) through the Cloud SQL Auth Proxy. There is
no maintenance mode on this host (D-049): the app keeps running while you work, and the approval row
and the kill switch live in the database, so the running app sees them. They refuse without a terminal.
Whether the approval row is picked up without a restart depends on the Postgres adapter (PG-1), not
checked here.

1. Install the Cloud SQL Auth Proxy v2 and sign in as yourself, on your own machine:

   ```
   gcloud auth login
   gcloud auth application-default login
   gcloud config set project <your project id>
   ```

   Download the proxy from the official Cloud SQL Auth Proxy page and put it on your path (UNVERIFIED:
   release file names change; follow that page).

2. Start the proxy in a second terminal window. It listens on 127.0.0.1 only and stays open:

   ```
   cloud-sql-proxy --port 5433 <PROJECT_ID>:<REGION>:unitmarket-sbx-pg
   ```

3. In the first window, in the repository at the reviewed tag, build the connection value from the
   secret without printing it, and keep it in this shell only:

   ```
   RAW="$(gcloud secrets versions access latest --secret=DATABASE_URL)"
   export DATABASE_URL="$(printf '%s' "$RAW" | sed 's#@/\([^?]*\)?host=[^ ]*#@127.0.0.1:5433/\1#')"
   unset RAW
   export UMS_DB=postgres
   ```

   Your `.env.local` from MVP-B supplies the rest (mode `sandbox`, the session, approval and link
   secrets, `UMS_OUTBOUND_SCOPE=mvp_c_refunds`, and the same operator key entries). Do not put
   `DATABASE_URL` in `.env.local`. Check with `corepack pnpm safety:status`; expected: `mode=sandbox
connect=off db=postgres`.

4. Insert the approval row and turn the switch on: run the commands of Step 6 items 4 and 5 of the Render
   file unchanged (`safety:approve ...`, then `safety:resume ...`; type the scope name when asked). Skip
   its items 1 to 3 and 7 (flag, restart, maintenance): there is no flag here.
5. Connection on (Step 8, items 1 and 2), only when Step G, Step 4 and items 4 above are done:

   ```
   gcloud run services update unitmarket-sandbox --region="$REGION" --project="$PROJECT_ID" \
     --update-env-vars=UMS_PAYPAL_CONNECT=on
   ```

   Open `/ops`: all five locks open, transport `sandbox (approved)`.

6. Stop, at any time: the "Stop PayPal now" button on `/ops`, or at your terminal
   `corepack pnpm safety:stop --operator vikram --reason "<why>"`, or set the connection off:

   ```
   gcloud run services update unitmarket-sandbox --region="$REGION" --project="$PROJECT_ID" \
     --update-env-vars=UMS_PAYPAL_CONNECT=off
   ```

7. When done, stop the proxy (Ctrl+C) and close the window; the shell variable disappears with it.

## Step J: webhook and learn window (Steps 4 and 7)

Step 4 as written, with the webhook URL `https://<service URL>/api/webhooks/paypal`. Then store the real
id (`set-secret.sh ... PAYPAL_WEBHOOK_ID`) and redeploy the same tag (Step F).

Step 7 as written, with these host-specific commands instead of the Render dashboard (UTC time of the
form `2026-10-26T18:30:00Z`, at most 60 minutes ahead, D-043):

```
gcloud run services update unitmarket-sandbox --region="$REGION" --project="$PROJECT_ID" \
  --update-env-vars=UMS_WEBHOOK_CERT_LEARN_UNTIL=<UTC time>
gcloud run services logs read unitmarket-sandbox --region="$REGION" --project="$PROJECT_ID" --limit=100
gcloud run services update unitmarket-sandbox --region="$REGION" --project="$PROJECT_ID" \
  --remove-env-vars=UMS_WEBHOOK_CERT_LEARN_UNTIL
```

The second command shows the `webhook.cert_learned` log line to copy (text, no secret). Remove the
variable straight after (the third command); a redeploy from `service.yaml` also removes it, because the
kit never sets it. Steps 9 and 10 as written; read the `webhook.delivery` lines with the second command.

## Step K: backup and restore drill (replaces Step 11, C-10, 30 min)

Cloud SQL keeps daily backups (7 kept) and point in time recovery (7 days of logs). The drill restores
into a NEW instance and never touches the running one.

1. List backups: `gcloud sql backups list --instance=unitmarket-sbx-pg --project="$PROJECT_ID"`
2. Clone to a new instance at a past time (UTC, after the instance was created, at least a few minutes
   ago):

   ```
   gcloud sql instances clone unitmarket-sbx-pg unitmarket-sbx-restore \
     --point-in-time=<UTC time like 2026-10-26T12:00:00Z> --project="$PROJECT_ID"
   ```

   Write down the minutes it took. The pass condition (C-10) is a restore within 30 minutes.

3. Check the copy: start the Auth Proxy (Step I item 2) on the clone `<PROJECT_ID>:<REGION>:unitmarket-sbx-restore`
   with `--port 5434`, then compare row counts of the main tables with the live database. The ledger
   sums and the orders must match PayPal read-backs, as in the offline drill
   (`corepack pnpm vitest run --project integration scripts/restore.integration.test.ts`, which you can
   still run on your laptop).
4. Delete the clone (it holds the same data and costs money):

   ```
   gcloud sql instances patch unitmarket-sbx-restore --no-deletion-protection --project="$PROJECT_ID"
   gcloud sql instances delete unitmarket-sbx-restore --project="$PROJECT_ID"
   ```

   If the first command is refused because the clone has no protection, run only the second.

A real recovery (making the app use a restored instance) changes the `DATABASE_URL` secret and the Cloud
SQL connection in the deploy: ask Sakthi, do not improvise. A restored database has the switch off, so
Step I items 4 and 5 are repeated.

Write what you did and how long it took. A backup or a clone holds session data: never copy it anywhere.

## Step L: finish and cancel (replaces Step 13, 15 min)

1. Press "Stop PayPal now" on `/ops` (reason "end of MVP-C session"), then set the connection off (Step I
   item 6).
2. Confirm `/ops` shows `paypal_outbound` off.
3. Close the terminals and the proxy. If a secret was ever pasted somewhere it should not have been,
   rotate it within the hour (`set-secret.sh` stores a new version; redeploy) and note it in
   `docs/decision-log.md`.
4. Cancel after 15 Dec 2026, or earlier when judging no longer needs it. The database has deletion
   protection, so the plain way is to shut the whole project down in the console (Settings, Shut down),
   which stops all charges after the retention days. Keep the reminder in your calendar.

## What to bring back to Sakthi

1. The pasted non-secret blocks of Steps B, C, F and H.
2. The Step G (Step 3) proxy count answers. If the count was not 1, bring only that.
3. The `webhook.cert_learned` and `webhook.delivery` log lines (text).
4. The Step K minutes and anything that surprised you.
5. Screenshots as in the Render file, except there is no Render dashboard; do not screenshot the Secret
   Manager value pages, the Cloud Run Variables and Secrets tab with values, or an address bar with a token.

## Optional hardening: restrict outbound traffic (UNVERIFIED, not part of the kit)

Cloud Run can send its outbound traffic through a VPC (Direct VPC egress or a Serverless VPC Access
connector) so that firewall rules allow only the hosts the app needs (PayPal's sandbox API and Google
APIs) and deny the rest. Nothing in this kit does it: it needs a network, a subnet and DNS-name firewall
rules, none of which could be checked offline, and a wrong rule would make the app unable to reach
PayPal or Cloud SQL. The app already refuses to call anything but the one sandbox host (transport lock).
Decide with Sakthi after the sitting if it is worth the extra setup.

## UNVERIFIED list (could not be checked offline; the commands exist in this container's help)

Every gcloud command and flag name in `infra/gcp` and in this file was checked against
`gcloud <command> --help` in a container with no login. Not checkable offline, so UNVERIFIED:

- Flag values and output field names: `--validate-ssl=true`, `--status-codes=200`,
  `value(billingAccountName)`, `value(billingEnabled)`, `value(state)`, `value(status.url)`, the filter
  keys `displayName`/`display_name`, `labels.email_address` and `state=ENABLED`.
- `gcloud beta monitoring channels create` and `list` (the beta component; Cloud Shell has it): the
  channel label `email_address` and `--type=email`.
- The alert policy file written by `monitoring.sh` (field names of the Monitoring API), the
  `gcr.io/cloud-builders/docker` build step in `deploy.sh`, and the budget filter `projects/<id>`.
- `--tier=db-g1-small` with `--edition=ENTERPRISE` in your region, and that the database user can create
  tables in the `public` schema (if the first boot logs a permission error, paste it to Sakthi).
- The deterministic service URL form in Step E, and Cloud Run's `X-Forwarded-For` depth (Step G).
- The Auth Proxy download and its flags, and how the Postgres adapter handles the approval row (Step I).
- That a deploy never overlaps two instances: Cloud Run starts the new revision before it stops the old
  one, so for a short time two instances (one per revision) can both run the job loop. Deploy only when
  no payment is in flight, and tell Sakthi if you see two sets of job log lines.
- Costs in "What this builds".
- `setup.sh` hands the generated database password to `gcloud sql users create` as an argument for a few
  seconds (its other form is an interactive prompt). On Cloud Shell only you can see the process list. It
  is never printed or stored outside Secret Manager. Both commands run with `CLOUDSDK_CORE_DISABLE_FILE_LOGGING=1`
  because gcloud otherwise writes every argument, password included, to `~/.config/gcloud/logs`. If you ran an
  earlier copy of `setup.sh` without that setting, delete `~/.config/gcloud/logs` in Cloud Shell and reset the
  password (delete the `DATABASE_URL` secret versions and run `setup.sh` again).
- Any `gcloud` default prompt: scripts never log in; if gcloud asks to install a component, answer yes.
- Docker build: not run here (no daemon in the build container); the first Cloud Build run is the first
  test of `infra/gcp/Dockerfile`.
