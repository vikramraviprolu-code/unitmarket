# Owner steps: serve the hosted sandbox app at https://unitmarket.live (DOM-1)

Who runs this: Vikram, at his own terminal, signed in to `gcloud` with his own account. Claude does not run any of
these commands (no gcloud changes from a session). Nothing here contacts PayPal except Step 6, which is a dashboard
edit by Vikram.

Why a load balancer: Cloud Run domain mapping is not offered in `europe-west3`, where the service and the database
run (Google's list on 10 Nov 2026: asia-east1, asia-northeast1, asia-southeast1, europe-north1, europe-west1,
europe-west4, us-central1, us-east1, us-east4, us-west1). Firebase Hosting is not an option either: it forwards only
a cookie named `__session`, and our session cookie is `__Host-ums_s`. Google recommends a global external
Application Load Balancer for this case.

Cost: the forwarding rules cost $0.025 an hour for the first five (about $18.25 a month at 730 hours), plus $0.008
per GiB processed in each direction. The Google-managed certificate has no charge. Delete it after judging with
Step 9.

Order matters. Steps 1 to 5 are done while the app still answers on its `run.app` address. Only Step 7 deploys
the tag that sets `UMS_PUBLIC_ORIGIN: 'https://unitmarket.live'`; from that moment browser sign-in works only on
`https://unitmarket.live`, and the `run.app` address refuses it.

Every flag below was checked with `gcloud <command> --help` on 10 Nov 2026. Nothing was run against the project.

## Step 0: variables (1 min)

```
PROJECT_ID=unitmarket-sbx-vr1
REGION=europe-west3
SERVICE=unitmarket-sandbox
gcloud config set project "$PROJECT_ID"
gcloud services enable compute.googleapis.com
```

## Step 1: a fixed address (2 min)

```
gcloud compute addresses create unitmarket-live-ip --global --ip-version=IPV4 --network-tier=PREMIUM
gcloud compute addresses describe unitmarket-live-ip --global --format='value(address)'
```

Write down the address it prints. It is public and not a secret.

## Step 2: DNS at your registrar (5 min, then wait)

The domain is registered at Hostinger. In hPanel open **Domains**, choose `unitmarket.live`, then **DNS / Nameservers**,
then **DNS records**. The domain must use Hostinger nameservers for these records to count. Set one record:

| Type | Name                  | Value                   | TTL |
| ---- | --------------------- | ----------------------- | --- |
| A    | `@` (the bare domain) | the address from Step 1 | 300 |

Delete any other A or AAAA record for `@` (Hostinger adds a parking-page A record by default), and remove any redirect under **Redirects** for the domain. If the domain has a CAA record, it must
allow `pki.goog`, or Google cannot issue the certificate. Check from your Mac: `dig +short unitmarket.live A`
prints only the address from Step 1.

## Step 3: the certificate and the load balancer (10 min)

```
gcloud compute ssl-certificates create unitmarket-live-cert --global --domains=unitmarket.live

gcloud compute network-endpoint-groups create unitmarket-live-neg \
  --region="$REGION" --network-endpoint-type=serverless --cloud-run-service="$SERVICE"

gcloud compute backend-services create unitmarket-live-backend \
  --load-balancing-scheme=EXTERNAL_MANAGED --global

gcloud compute backend-services add-backend unitmarket-live-backend --global \
  --network-endpoint-group=unitmarket-live-neg --network-endpoint-group-region="$REGION"

gcloud compute url-maps create unitmarket-live-map --default-service=unitmarket-live-backend

gcloud compute target-https-proxies create unitmarket-live-proxy \
  --ssl-certificates=unitmarket-live-cert --url-map=unitmarket-live-map

gcloud compute forwarding-rules create unitmarket-live-https \
  --load-balancing-scheme=EXTERNAL_MANAGED --network-tier=PREMIUM --address=unitmarket-live-ip \
  --target-https-proxy=unitmarket-live-proxy --global --ports=443
```

This sets up HTTPS only. A browser that types `http://unitmarket.live` gets no answer; adding a port 80 redirect is
optional and not needed for judging.

## Step 4: wait for the certificate (up to about an hour after DNS points at the address)

```
gcloud compute ssl-certificates describe unitmarket-live-cert --global --format='value(managed.status,managed.domainStatus)'
```

Expected at the end: `ACTIVE` and `unitmarket.live=ACTIVE`. `PROVISIONING` means wait; `FAILED_NOT_VISIBLE` means
the A record of Step 2 is wrong or not yet visible.

Then open `https://unitmarket.live/signin`. Expected: the sign in page with the Sandbox label. Signing in still
fails here, because the app still expects the `run.app` origin. That is correct at this step.

## Step 5: the proxy depth check through the load balancer

The load balancer adds itself to `X-Forwarded-For`, so `UMS_TRUSTED_PROXIES` (today `'1'` in `service.yaml`, pinned
by the checker) may need to become `'2'`. Do Step G of `MVPC-OWNER-STEPS-GCP.md` with `HOST=unitmarket.live`. If
the count is not 1, do not go on: tell Claude the count, and a reviewed change sets it in `service.yaml` and in the
checker before Step 7. A wrong count is worse than 0: rate limits and logs would use the wrong address.

## Step 6: the PayPal sandbox webhook URL (PayPal developer dashboard, 5 min)

In the sandbox app's webhook settings, change the URL from `https://<run.app address>/api/webhooks/paypal` to
`https://unitmarket.live/api/webhooks/paypal`. Keep the same events. If the dashboard keeps the webhook id, nothing
else changes. If you have to create a new webhook instead, store its id with
`bash infra/gcp/set-secret.sh "$PROJECT_ID" "$REGION" PAYPAL_WEBHOOK_ID` before Step 7. The return and cancel URLs
need no dashboard change: the app builds them from `UMS_PUBLIC_ORIGIN` for each order.

## Step 7: deploy the tag that carries DOM-1

Only after Steps 4 and 5 pass, and the PR is merged on your word. Tag and deploy as usual (`deploy.sh` or
`corepack pnpm cloud:deploy <tag>`). The deploy prints
`custom domain: UMS_PUBLIC_ORIGIN is https://unitmarket.live; ...` instead of the old NOTE; that is expected.
`cloud doctor` prints `ok   custom domain https://unitmarket.live routes to <run.app address>`.

## Step 8: check (5 min)

1. Open `https://unitmarket.live/signin` and sign in as Buyer A. Expected: the buyer home page, Sandbox label.
2. Open a purchase up to the PayPal step (with the connection off it stops at "checkout paused"; with a sitting
   open, the PayPal return lands on `https://unitmarket.live/checkout/return?...`).
3. Update the Devpost "Try it out" link and any shared links to `https://unitmarket.live`.

## Step 9: roll back or remove

Roll back: deploy the previous tag (its `service.yaml` holds the `run.app` origin) and set the webhook URL back.
Remove after judging (stops the cost), in this order:

```
gcloud compute forwarding-rules delete unitmarket-live-https --global
gcloud compute target-https-proxies delete unitmarket-live-proxy
gcloud compute url-maps delete unitmarket-live-map
gcloud compute backend-services delete unitmarket-live-backend --global
gcloud compute network-endpoint-groups delete unitmarket-live-neg --region="$REGION"
gcloud compute ssl-certificates delete unitmarket-live-cert --global
gcloud compute addresses delete unitmarket-live-ip --global
```

These delete only the load balancer pieces. They never touch the Cloud Run service or the database
`unitmarket-sbx-pg`.
