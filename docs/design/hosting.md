# Hosting options: UnitMarket PayPal sandbox demo (Next.js 15 / Node 22)

Read on 2026-10-21 from official pages (vendor docs and pricing pages). Prices USD, excl. tax. Anything marked UNVERIFIED was not confirmed on an official page. Need window: about 8 weeks, to 15 Dec 2026.

Needs: (1) one long-lived Node process, 30 s job loop; (2) persistent disk for PGlite; (3) inbound HTTPS 443, stable URL, for PayPal sandbox webhooks; (4) server-side env secrets; (5) low cost; (6) Git or container deploy.

## Table

| Option | Fits 6 needs | Cost per month (est.) | Setup effort | Main risk |
|---|---|---|---|---|
| Render paid web service + persistent disk | Yes (disk needs a paid plan; one instance only) | $7 plan (0.5 CPU, 512 MB) + $0.25/GB disk = about $7.25. $25 plan (1 CPU, 2 GB) if memory is short | Low: connect Git, tick Advanced > Disk, set env | 512 MB RAM may be too small for Next.js + PGlite. Each deploy has a few seconds of downtime (disk blocks zero-downtime deploys) |
| Render Free web service | No: sleeps after 15 min idle, filesystem wiped, no disk | $0 | Low | Sleeping app misses the 30 s loop; wakeup takes about 1 min |
| Fly.io Machine + volume | Yes | shared-cpu-1x 1 GB $6.70 + 1 GB volume $0.15 = about $7 (256 MB $2.19, 512 MB $3.69) | Medium: flyctl, Dockerfile or fly launch, volume, fly.toml | Volume is on one host with no replication; no free tier, card needed; you run the container yourself |
| Railway Hobby + volume | Yes (one volume per service, no replicas) | $5 plan incl. $5 usage; RAM $10/GB-mo, CPU $20/vCPU-mo. About $8-12 for 1 GB always-on | Low | Usage billing is variable; redeploy has brief downtime; Hobby volume limit 5 GB |
| Hostinger VPS (KVM 1: 1 vCPU, 50 GB NVMe, listed 4 GB RAM) | Yes (root, SSH, any port, you add TLS) | Page shows $6.49/mo promo (long prepaid term; renews $11.99). Month-to-month price UNVERIFIED | High: Linux, Node 22, systemd, Caddy/Nginx, certs, firewall, patching | Prepaid long terms are wasteful for 8 weeks (30-day money-back shown). You own security and uptime |
| Hostinger Node.js web apps (Business/"Unlimited" or Cloud Startup) | Partly/likely no: Next.js and env vars yes, restart yes; no SSH npm; deploy files overwritten; no documented persistent disk or 30 s background loop | $3.99-$7.99/mo shown on 48-month prepaid terms | Low | Persistent disk and loop not documented (UNVERIFIED). Risky for PGlite. Heavy prepay |
| Vercel Hobby | No: serverless; read-only FS, writable /tmp up to 500 MB, ephemeral; cron once per day, +-59 min | $0 | Low | Hobby is non-commercial only. Loop and disk impossible |
| Vercel Pro | No for needs 1-2: cron min 1 per minute (not 30 s), function max 300 s default | $20/mo + usage | Low | Still no persistent disk or long-lived process. Daemons (beta): no inbound HTTP, no persistent disk |
| Google Cloud Compute Engine VM | Yes (VM, persistent disk, any port; you add TLS) | Always-free: 1 e2-micro (non-preemptible) + 30 GB standard disk, US regions only (us-west1, us-central1, us-east1). e2-micro is 1 GB RAM (UNVERIFIED on page). Paid e2-small about $12 (UNVERIFIED, not on a fetched official page) | High: VM, Node, TLS, firewall, static IP | 1 GB RAM tight for Next.js + PGlite. Free tier needs a billing account. Static external IPv4 may be billed (UNVERIFIED) |
| Google Cloud Run | Partly/no: min instances keep an instance warm, but volumes are Cloud Storage FUSE (no file locking), NFS (needs Filestore) or in-memory (lost on stop). No local persistent disk | Instance-based billing (CPU always on): 1 vCPU + 1 GiB about $50/mo list (0.000018/vCPU-s + 0.000002/GiB-s, 2.59M s; free tier 240k vCPU-s, 450k GiB-s). Own calculation | Medium | PGlite on FUSE/NFS risks corruption. Request-based billing throttles CPU when idle, so the 30 s loop stops (inference from docs) |
| Google App Engine | No/UNVERIFIED: standard environment has no persistent writable disk; free tier is F1/B1 hours | n/a | Medium | Not checked in depth; not a fit for local disk DB |

## Per-platform notes

- Hostinger: Node.js web apps run on Business (5 apps) and Cloud plans (10 apps). VPS and dedicated plans run Node by manual CLI setup. On web-app plans npm cannot be run over SSH, and files in hbuilds/ and public_html are overwritten each deploy. Supported Node versions: 18, 20, 22 (default), 24. Env vars are set in the dashboard. Node limits page does not list numbers for process or storage.
- Vercel Hobby: "restricted to non-commercial personal use only". Commercial means any deployment used for financial gain of anyone involved, including requesting or processing payment from visitors. A PayPal sandbox demo moves no real money, but a hackathon with prizes is a grey area. Ask Vercel support if you want Vercel at all.
- Google Cloud: Free Trial is $300 for 90 days, then resources stop unless upgraded to a Paid billing account. Free Tier has no end date but limits change with 30 days' notice. If the owner already has a paid account, the free e2-micro is a $0 option.
- Render Free: 750 free instance hours per month; free Postgres expires after 30 days. Not relevant to PGlite.
- Fly.io: volume default 1 GB, snapshots daily (5 days kept), volume attaches to one Machine. Free trial: up to 2 hours of runtime or 7 days. Card required after that.
- Railway: Trial/Free volume 0.5 GB; Hobby 5 GB. Subscription is prepaid-style flat fee and usage is deducted from it.

## Recommendation

1. Best now (PGlite on disk): Render paid web service ($7 plan, 1 GB disk, about $7.25/mo). Lowest effort: Git deploy, managed TLS on a stable onrender.com URL, env vars in dashboard, SSH on paid plans. Start on the $7 plan; if the app runs out of memory, move to the $25 plan for the demo period (about $50 for 8 weeks). Run exactly one instance and mount the PGlite data directory inside the disk mount path.
2. Best once Supabase replaces the disk: same Render service with the disk removed (still needs a long-lived process for the 30 s loop). Do not move to Vercel: Hobby cron is daily and non-commercial only, Pro cron is per-minute at best.
3. Fallback: Fly.io (shared-cpu-1x 1 GB + 1 GB volume, about $7/mo). Second fallback: Google Cloud e2-micro or a Hostinger KVM VPS, only if the team accepts Linux ops work.

## Owner must set up himself

- Account on the chosen host, billing card (Render, Fly, Railway all need a card for paid use).
- Connect the GitHub repo to the host (Sakthi reviews and merges per repo rules).
- Optional custom domain and DNS. Not required: the host-provided HTTPS URL works for PayPal webhooks (port 443, UNVERIFIED for each host but standard).
- Register the webhook URL in the PayPal sandbox app himself (Vikram holds sandbox access).
- Set a spend alert or manual reminder to cancel after 15 Dec 2026. Avoid long prepaid terms.

## We must NOT do

- Put live PayPal credentials anywhere. Sandbox credentials only, as host env vars, never in the repo, logs or PRs (CLAUDE.md credentials rule).
- Skip webhook signature verification because the URL is public.
- Run two instances against one PGlite directory, or deploy with the data directory outside the mounted disk path.
- Use Render Free (data wiped, sleeps) or Vercel Hobby for this.
- Put PGlite on Cloud Storage FUSE or NFS.
- Start any phase 3 sandbox hosting before Vikram's explicit go (repo rule: this phase is simulation only).
- Prepay long terms for an 8-week need.

## Deploying (Render blueprint, CO-7)

`render.yaml` at the repository root describes the one web service: Node 22.22.0, plan starter, one instance, auto-deploy off, a 1 GB disk at `/var/data`, `UMS_PGLITE_DIR=/var/data/pglite`, health check `/healthz`. It holds env variable names and safe fixed values only. `pnpm check:hosting` (part of `pnpm ci`) fails on any unsafe setting. The file must be printable ASCII plus LF: the checker reads it the way Render does only if no CR, NEL, LS or PS byte can hide text in a comment.

1. The owner connects the repository to Render and imports the blueprint (a paid plan is needed for the disk).
2. The owner enters a value in the dashboard for every `sync: false` name: `PAYPAL_CLIENT_ID`, `PAYPAL_CLIENT_SECRET`, `PAYPAL_WEBHOOK_ID`, `UMS_OUTBOUND_APPROVAL_REF`, `UMS_SESSION_SECRET`, `UMS_APPROVAL_SECRET`, `UMS_LINK_SECRET`, `UMS_DEMO_PASSCODE_HASH`, `UMS_OPERATOR_TOTP_KEYS`, `UMS_PUBLIC_ORIGIN`. No value goes into the repository, a chat or a PR.
3. `UMS_PAYPAL_CONNECT` stays `off` in the file; the owner flips it to `on` in the dashboard only after the approval row exists. The check refuses `on` in the file. OPEN (O-C8, CO-7b): how the approval row gets into the hosted PGlite database is not decided. `safety:approve` and `safety:resume` open the PGlite directory, which the running app already holds. Running them in a Render shell while the app is up would put two processes on one directory, which this design forbids. Until O-C8 is answered, no hosted call can be approved.
4. Deploy manually from a reviewed tag (RLR-1). Never raise `numInstances`: two processes must not share one PGlite directory.
5. After the first deploy, confirm `UMS_TRUSTED_PROXIES=1` (ASM-57) with a test from outside, using `curl`, because the app keeps only a keyed hash of the client address, never the raw `X-Forwarded-For`, so a log check cannot be carried out and a temporary log line would be a code change. The sign-in limiter allows 5 wrong passcodes per address and persona in 15 minutes, then answers 429; its bucket key is the entry the setting picks from `X-Forwarded-For`, so the answers show what the setting trusts. Use the persona `buyer-b` and a made-up passcode, so no real secret is typed and `buyer-a` and the operator are not locked out. `HOST` is the host name only; every request carries `Origin: https://$HOST` (the CSRF check) and a JSON body `{"persona":"buyer-b","passcode":"not-the-passcode-0000"}`. (a) From machine A make 5 wrong sign-ins: 401 each; the 6th must answer 429. (b) Repeat the request from A with a forged `X-Forwarded-For: 198.51.100.7`: it must still answer 429, otherwise the setting trusts an entry the client wrote (the count is too high, or the platform appends nothing) and a client picks its own bucket. (c) From a second network (a phone hotspot) make one wrong sign-in inside the same 15 minutes: it must answer 401, not 429, otherwise all clients share one bucket (more proxies than the count). The exact commands are in `docs/owner/MVPC-OWNER-STEPS.md` Step 3. Any other result: the count is wrong. A wrong count is worse than 0. The web app never passes the socket address, so with `0` every client lands in the soft `no-address` bucket, where the right passcode still signs in. The harmful case is a nonzero count below the real depth (for example `1` when Render appends 2 entries): every client then gets the edge proxy's address as its bucket, and the D-022 strict lockout locks everyone out. A count above the real depth lets a client choose its own bucket by writing the entry read from the right. A wrong count is corrected in `render.yaml` through review (the checker pins `1`), because a dashboard edit is reverted by Blueprint auto-sync. The depth must be right before the webhook is registered or switched on, because the webhook limiter has two more failure modes (CO-3): (a) more than one proxy while the count is 1: all clients share one bucket, so an attacker's 60 refusals a minute make the peek turn away PayPal's valid deliveries with 429 (money is safe: PayPal retries for 3 days and polling reconciles); (b) no proxy appends `X-Forwarded-For` while the count is 1: the client picks its own bucket key, the limiter stays empty and the audit log grows at request rate.

Render settings and field names the owner must confirm on import (not verifiable offline):

- `runtime: node`; `plan: starter` (512 MB RAM: watch Next.js, PGlite and the job loop together; `NODE_OPTIONS` cannot tune memory because boot refuses it, so the only lever is the next plan up, and the checker pins `starter` until the file is changed in review).
- `numInstances: 1`.
- `autoDeploy: false`. Render may prefer `autoDeployTrigger: off`; the checker refuses that key, so verify at import and change both together if needed.
- `healthCheckPath: /healthz`.
- `disk.name` (`pglite-data`), `disk.mountPath` (`/var/data`), `disk.sizeGB` (1).
- `envVars[].sync: false` prompts for a value only on the first Blueprint creation; a name added later needs its value set in the dashboard.
- `NODE_VERSION` takes precedence over `.nvmrc`, and 22.22.0 is an available version.
- Blueprint auto-sync resets dashboard edits to the file. `UMS_PAYPAL_CONNECT` therefore goes back to `off` after a sync, which is the safe direction.
- Pull-request previews are OFF: a preview would run PR code with the sandbox secrets.
- No `NODE_OPTIONS`, proxy or CA variable in the dashboard or in an environment group.
- Region (not set in the file; the owner chooses).
