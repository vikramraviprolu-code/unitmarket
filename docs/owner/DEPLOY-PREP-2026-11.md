# Deploy preparation for Sakthi, November 2026 (DOCS-B)

Status: DRAFT written on 30 Oct 2026 against `main` at commit `cb8eabe`. Nothing in this file has been run. No agent runs any
command below, creates a tag or deploys (D-066). A human runs every step. The sources are `infra/gcp/deploy.sh`,
`infra/gcp/service.yaml`, `docs/owner/MVPC-OWNER-STEPS-GCP.md` (Steps A, D, F, G, I and K) and `package.json`. Lines that start
with **TO FINALISE** depend on a lane that is not on `main` yet.

Placeholders used below, never filled in this file: `PROJECT_ID` (your Google Cloud project id), `REGION` (for example the one
printed by `setup.sh`), `TAG` (the reviewed tag). No project number, id, secret or credential is written here.

## Rules for this deploy

1. Never deploy during an owner sitting or while an order is in flight. A deploy always puts `UMS_PAYPAL_CONNECT` back to `off`,
   and Cloud Run starts the new revision before it stops the old one, so for a short time two instances can both run the job loop
   (`MVPC-OWNER-STEPS-GCP.md`, UNVERIFIED list).
2. This deploy does not turn the connection on. Turning it on is a separate human act with its own approval row (Step I item 5 of
   the GCP owner steps). It is not in this file. The D-062 approval row expires on 2026-11-03T12:00:00Z; after that the hosted
   app fails closed with checkout paused and nothing charged (D-056).
3. Never run `delete` or `--no-deletion-protection` on `unitmarket-sbx-pg`.
4. If any command prints a value that looks like a secret, stop. Rotate within the hour and note it in `docs/decision-log.md`.

## What the hosted app will NOT have after this deploy

`deploy.sh` maps only its fixed list of secret names (`SECRET_NAMES` in the script): `DATABASE_URL`, `PAYPAL_CLIENT_ID`,
`PAYPAL_CLIENT_SECRET`, `PAYPAL_WEBHOOK_ID`, `UMS_OUTBOUND_APPROVAL_REF`, `UMS_SESSION_SECRET`, `UMS_APPROVAL_SECRET`,
`UMS_LINK_SECRET`, `UMS_DEMO_PASSCODE_HASH`, `UMS_OWN_MERCHANT_ID` and `UMS_OPERATOR_TOTP_KEYS`. So, whatever the tag contains:

- Publisher personas. They need `UMS_PUBLISHER_PASSCODE_HASH`. Until a reviewed infra change maps it and the owner stores a value
  with `set-secret.sh`, the hosted publisher console stays off.
- The Claude adapter. It needs `UMS_AI_ADAPTER` and `UMS_ANTHROPIC_API_KEY`. Until the same change and a stored key, the hosted app
  uses the scripted model and calls no AI.
- `set-secret.sh` also lists allowed names in its `case`; the new names must be added there by the same reviewed change.

That change is the lane called INFRA-A in `docs/specs/overnight-plan.md` section 6 and `docs/owner/OVERNIGHT-ASSUMPTIONS.md` item 6.
It was not specced or built overnight. **TO FINALISE:** write and review INFRA-A before judging if the owners want these on the hosted
app, then set the secrets by hand (never in chat). Judges on the hosted URL will not see the publisher console until then.

## Steps

### 1. Confirm the reviewed commit and run the checks (your laptop)

1. Confirm with Vikram which commit on `main` is the reviewed one. Do not tag anything else.
2. In a clean checkout of that commit, run the whole offline check list and keep the output:

   ```
   corepack pnpm run ci
   ```

   It must end green. The overnight plan (`docs/specs/overnight-plan.md` section 3) records that the state suite has one known,
   expected failure. If you see a failure, write down the exact test name and have Vikram confirm it is that one; any other failure
   means stop and do not tag.

3. Read `infra/gcp/service.yaml` and confirm the line `UMS_PAYPAL_CONNECT: 'off'` is there. Then run:

   ```
   corepack pnpm check:hosting-gcp
   ```

   This check (also part of `ci`) fails if the file holds a secret name or value.

4. **TO FINALISE:** if the tag contains migration `0012_publisher_side.sql` (lane PUB-A1), the app is expected to apply a forward only
   migration to the live database when it first starts (not verified here), and the demo price revisions (lane PUB-B) write new offer versions on the first
   boot (`OVERNIGHT-ASSUMPTIONS.md` item 4). On `main` at the time of writing the newest migration is `0011_provider_order_state.sql`,
   so this item applies only after PUB-A1 has merged.

### 2. Take a database backup first (Cloud Shell)

Cloud SQL keeps daily backups (7 kept) and point in time recovery (7 days of logs). Open Cloud Shell as yourself, then do Step A
of the GCP owner steps for the two values, and list the backups:

```
PROJECT_ID=<your project id>
REGION=<your region>
gcloud sql backups list --instance=unitmarket-sbx-pg --project="$PROJECT_ID"
```

Expected: a recent successful automatic backup (less than a day old). Write down its time. That backup and the point in time
window are your restore point. The kit has no command for an extra on demand backup; if you want one, check the command with
`gcloud sql backups --help` first and tell Vikram, since it is not covered by `deploy.sh` or the owner steps. A full restore drill
is Step K and costs a temporary clone; it is not needed before every deploy.

### 3. Create and push the reviewed tag (human only)

Vikram or Sakthi creates the tag on the reviewed commit and pushes it. No agent creates a tag overnight and this file gives no tag
command, because none is in the kit. The tag name must match what `deploy.sh` accepts: it starts with a letter or digit, then
letters, digits, `.`, `_` or `-`, at most 63 characters. Earlier tags were named like `gcp-mvpc-2` and `mvpd-sbx-1`; the
repository freeze tag in the decision list is `submission-1` (item 12) and should be a different tag from the deploy tag. Write
the chosen name down as `TAG`. Do not move a tag that was already deployed.

### 4. Get the code at the tag (Cloud Shell, Step A)

```
git clone <the repository URL Sakthi gives you> unitmarket-sandbox
cd unitmarket-sandbox
git fetch --tags
git checkout TAG
```

If you already have the clone, run only the last two lines inside it. `deploy.sh` refuses unless HEAD is exactly the tag and the
working tree is clean.

### 5. Check that every secret has a value (Step D)

```
gcloud secrets list --project="$PROJECT_ID" --format='value(name)'
```

Expected: eleven names, the ten secrets above and `DATABASE_URL`. This shows names only, never values. `deploy.sh` checks the
same and stops with the missing names if any has no enabled version.

### 6. Deploy (Step F)

```
bash infra/gcp/deploy.sh "$PROJECT_ID" "$REGION" TAG
```

It builds the image with Cloud Build if no image exists for that tag and commit (about 10 minutes the first time) and deploys the
service `unitmarket-sandbox` as one instance, CPU always allocated, public ingress, secrets mapped by name, with the fixed values of
`service.yaml`. Copy these two lines from the end of the output (they hold no secret):

- `deployed unitmarket-sandbox from tag TAG at commit <12 characters>`
- `service URL: <address>`

If the output ends with a line starting `NOTE: UMS_PUBLIC_ORIGIN in service.yaml is not this URL`, browser sign in is refused until a
reviewed change sets the origin to the printed address and a new tag is deployed (Step E of the GCP owner steps). Tell Vikram; do
not edit the file on the host.

### 7. First checks after the deploy

1. Open `<service URL>/signin` in a browser (not `/healthz`: Google reserves it on `run.app` addresses). Expected: the sign in page,
   HTTP 200.
2. Sign in as Buyer A with the demo passcode and open `/discover`. Expected: the page loads. Do not start a purchase: the connection
   is off.
3. Sign in as Operator in a second window (name, passcode and current code) and open `/ops`. Expected: the outbound gate block
   shows that PayPal calls are blocked, and the connect lock is not open. This is how you see that the deploy left the connection off.
4. The first boot logs `maintenance.unconfigured` once. That is expected (D-044).
5. Check the switch and approval state in the database through the Auth Proxy. This is Step I items 1 to 3 of the GCP owner steps,
   copied here in order. On your own machine, in a second window start the proxy and leave it open:

   ```
   gcloud auth login
   gcloud auth application-default login
   gcloud config set project <your project id>
   cloud-sql-proxy --port 5433 <PROJECT_ID>:<REGION>:unitmarket-sbx-pg
   ```

   In the first window, in the repository at the tag, rebuild and read the connection value without printing it:

   ```
   corepack pnpm --filter @umsbx/web build
   RAW="$(gcloud secrets versions access latest --secret=DATABASE_URL)"
   export DATABASE_URL="$(printf '%s' "$RAW" | sed 's#@/\([^?]*\)?host=[^ ]*#@127.0.0.1:5433/\1#')"
   unset RAW
   export UMS_DB=postgres
   env -u UMS_PAYPAL_CONNECT corepack pnpm safety:status
   ```

   Your `.env.local` from earlier sittings supplies the other settings (Step I item 3); do not put `DATABASE_URL` in it.
   Expected: `mode=sandbox connect=off db=postgres`. Here the prefix removes only `UMS_PAYPAL_CONNECT`, because on every other
   command the full prefix `env -u DATABASE_URL -u UMS_DB -u UMS_PAYPAL_CONNECT` is right, but this one check needs `DATABASE_URL`
   and `UMS_DB` on purpose (they point at the hosted database). The `connect=` word here is what your own terminal reads; the
   service's real flag is the one you saw on `/ops` in item 3 and in `service.yaml`.

6. When done, stop the proxy with Ctrl+C, then run:

   ```
   unset DATABASE_URL
   ```

   Also run `unset UMS_DB` and close the window, so a later local command cannot reach the hosted database (D-059).

### 8. Record the result

Paste back to Vikram (non secret): the `deployed ...` and `service URL:` lines, the `/signin` status, the `/ops` gate line, the
`safety:status` line and the backup time from step 2. Add a row to `docs/decision-log.md` only through a normal reviewed commit.

## Rollback

There is no rollback command in the kit. The plain way is to run step 6 again with the previous tag, the one that was serving
before. Sakthi knows which it is; do not guess. **TO FINALISE:** a forward only migration (0012) is not undone by an older tag;
whether the older code runs on the newer schema has not been checked. If it matters, restore from the step 2 backup with Vikram
(Step K, and ask before changing `DATABASE_URL`).

## After the deploy: what is still human only

Turning the connection on for the judging windows (three rows of seven days, starting 30 Nov, 7 Dec and 14 Dec; decision item 21)
needs a new written approval basis in `docs/decision-log.md`, a new approval row inserted by the owner at a terminal, and Step I item 5.
None of that is in this file. After 15 Dec, cancel the project as in Step L of the GCP owner steps.

## Where each command comes from

| Command or file                                                        | Source                                                                     |
| ---------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| `corepack pnpm run ci`                                                 | `package.json` script `ci`                                                 |
| `corepack pnpm check:hosting-gcp`                                      | `package.json` script `check:hosting-gcp`                                  |
| `corepack pnpm --filter @umsbx/web build`                              | `MVPC-OWNER-STEPS-GCP.md` Step I item 3                                    |
| `PROJECT_ID=...`, `REGION=...`                                         | `MVPC-OWNER-STEPS-GCP.md` Step A item 4                                    |
| `gcloud sql backups list --instance=unitmarket-sbx-pg --project=...`   | `MVPC-OWNER-STEPS-GCP.md` Step K item 1                                    |
| `git clone`, `cd`, `git fetch --tags`, `git checkout TAG`              | `MVPC-OWNER-STEPS-GCP.md` Step A item 3                                    |
| `gcloud secrets list --project=... --format='value(name)'`             | `MVPC-OWNER-STEPS-GCP.md` Step D                                           |
| `bash infra/gcp/deploy.sh "$PROJECT_ID" "$REGION" TAG`                 | `MVPC-OWNER-STEPS-GCP.md` Step F; usage line of `infra/gcp/deploy.sh`      |
| `gcloud auth login`, `application-default login`, `config set project` | `MVPC-OWNER-STEPS-GCP.md` Step I item 1                                    |
| `cloud-sql-proxy --port 5433 ...`                                      | `MVPC-OWNER-STEPS-GCP.md` Step I item 2                                    |
| `RAW=...`, `export DATABASE_URL=...`, `unset RAW`, `export UMS_DB=...` | `MVPC-OWNER-STEPS-GCP.md` Step I item 3                                    |
| `corepack pnpm safety:status`                                          | `package.json` script `safety:status`; Step I item 3 for the expected line |
| `env -u UMS_PAYPAL_CONNECT` (shortened prefix, see step 7.5)           | `docs/design/threat-model.md` row 19 (full prefix); shortened by this file |
| `unset DATABASE_URL`                                                   | `MVPC-OWNER-STEPS-GCP.md` Step I item 7                                    |
| `unset UMS_DB`                                                         | added by this file for D-059; not in the owner steps                       |

## Open questions for the owners

1. Is the shortened prefix in step 7.5 acceptable, or should the status check be skipped in favour of `/ops` only?
2. Which tag name is used for the deploy, and which tag is serving now (needed for rollback)?
3. Is INFRA-A (publisher secret, Claude adapter secrets) wanted before judging? Without it the hosted app shows neither.
4. Does an extra on demand backup matter before migration 0012? The kit has no command for it.
