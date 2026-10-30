# Deploy to Google Cloud: copy and paste guide for Sakthi

Written for Sakthi. Every step is a block to paste, with one line saying what it does. Nothing here turns PayPal on: every deploy leaves `UMS_PAYPAL_CONNECT` off. The full reference is `docs/owner/DEPLOY-PREP-2026-11.md`.

Values used below (from decision D-049). Confirm them with Vikram if unsure:

- Project: `unitmarket-sbx-vr1`
- Region: `europe-west3`
- Commit to deploy: the one the coordinator names in the "GO" message (written here as `COMMIT`)
- Tag to create: `gcp-pub-1` (written here as `TAG`). Use a new name if `gcp-pub-1` already exists.

Do not start until the coordinator has sent the "GO" message. Do not deploy while anyone is testing the hosted app.

## Part 1. Tag the reviewed commit (your laptop, in a clone of the repository)

What it does: checks you hold exactly the reviewed commit, then labels it so the deploy can find it.

```
git fetch origin
git checkout COMMIT
git status
git tag gcp-pub-1
git push origin gcp-pub-1
```

Expected: `git status` says "nothing to commit, working tree clean". Stop and ask if it says anything else.

## Part 2. Check the commit is healthy (your laptop, same folder)

What it does: runs the full offline check list. It takes about 15 minutes and needs Node 22.22.0 (`corepack pnpm` is fine).

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
