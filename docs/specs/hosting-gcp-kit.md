# Spec: Google Cloud deployment kit (GCP-1)

Task: scripts, container and checks so the owner can deploy the app to Cloud Run with Cloud SQL Postgres by pasting commands in Cloud Shell.
Package: `infra/gcp` (new), `scripts/check-hosting-gcp.mjs` and its test Owner: GCP-1 builder Reviewer: Opus, one round (D-048)
Branch: `feat/hosting-gcp-kit` Commit: `feat(hosting): <what> (GCP-1)` Decisions: D-037, D-043 to D-045, D-049, D-050.

Goal: one reviewed kit that, run by the owner with their own Google Cloud login, creates the project resources and deploys one Cloud Run instance wired to Cloud SQL, with the same safety posture as `render.yaml` and `pnpm check:hosting`.

Inputs: `render.yaml`, `scripts/check-hosting.mjs` and its test (the model for the new checker), `docs/design/hosting.md`, `docs/owner/MVPC-OWNER-STEPS.md` (reuse by reference; write only the host-specific differences), `packages/config/src/schema.ts` (the env names the app reads), D-049.
Outputs: `infra/gcp/Dockerfile` (Node 22.22.0, non-root, copies the built repo and starts `corepack pnpm --filter @umsbx/web start`; do not change `next.config.mjs`), `infra/gcp/setup.sh`, `infra/gcp/set-secret.sh`, `infra/gcp/deploy.sh`, `infra/gcp/service.yaml` (safe fixed env values and secret references only), `infra/gcp/monitoring.sh`, `scripts/check-hosting-gcp.mjs` + `scripts/check-hosting-gcp.test.ts`, a `check:hosting-gcp` script and its place in `ci`, `docs/owner/MVPC-OWNER-STEPS-GCP.md`, an appended section in `docs/design/hosting.md`.

Requirements:

1. Every script takes project id and region as arguments (placeholders in docs, never real values), is idempotent, `set -euo pipefail`, prints no secret, and refuses to run when `gcloud` has no active account.
2. `setup.sh`: enable Cloud Run, Cloud SQL Admin, Secret Manager, Artifact Registry, Cloud Build, Monitoring; create the Artifact Registry repo; create a Cloud SQL Postgres 16 instance (automatic backups, point in time recovery, deletion protection, no authorized networks, connections only through the Cloud SQL connector or Auth Proxy); create the database and user with a generated password stored only in Secret Manager as the `DATABASE_URL` secret in the socket form `postgres://USER:PASSWORD@/DB?host=/cloudsql/PROJECT:REGION:INSTANCE`; a runtime service account with only secret accessor and Cloud SQL client roles.
3. `set-secret.sh NAME`: reads the value with a hidden prompt from a terminal (refuse without one), stores a new Secret Manager version, prints only the name and version. Names allowed are the `sync: false` names of `render.yaml` minus `UMS_PUBLIC_ORIGIN` (which is not secret and goes in `service.yaml` after the first deploy prints the URL).
4. `deploy.sh TAG`: Cloud Build image, then `gcloud run deploy` from `service.yaml`: min instances 1, max instances 1, CPU always allocated (`--no-cpu-throttling`), 2 GiB, concurrency modest, startup probe `/healthz`, public ingress (webhooks need it), secrets by reference, `UMS_DB=postgres`, `UMS_PAYPAL_CONNECT=off`, `UMS_TRUSTED_PROXIES=1` (to be proven by the curl test in the owner steps; a wrong count is worse than 0), no `NODE_OPTIONS`, proxy or CA variable, no `UMS_MAINTENANCE_FLAG`, no auto deploy from Git.
5. `monitoring.sh`: uptime checks on `/healthz` and one buyer page every 5 minutes with an email alert to two addresses passed as arguments (C-13); a budget alert amount passed as an argument.
6. Checker: fails on any literal secret-shaped value, `UMS_PAYPAL_CONNECT` other than off, `UMS_DB` other than postgres, max instances other than 1, missing min instances 1 or `--no-cpu-throttling`, a live PayPal host name, non-ASCII or CR bytes, any `NODE_OPTIONS`/proxy/CA name, `--allow-unauthenticated` on anything but the app service, a script without `set -euo pipefail`. Tests prove each refusal with a one-line mutation of a clean kit.
7. Owner steps document: ordered, copy-paste commands for Cloud Shell, what to paste back (non-secret output only), the Auth Proxy commands for `safety:approve`, `safety:resume`, `safety:stop` at the owner's own terminal, the proxy depth curl test adapted from Step 3, the webhook registration and the learn window by reference to Steps 7 and following, backup restore (Cloud SQL clone or point in time recovery) for C-10, and an optional hardening note on an egress firewall (mark UNVERIFIED).

Acceptance tests (run; paste output):

- `bash -n` on every script; `corepack pnpm check:hosting-gcp` green; `corepack pnpm exec vitest run scripts/check-hosting-gcp` green with at least 10 named refusal cases.
- Every `gcloud` command and flag you wrote is validated against `gcloud <group> <command> --help` in this container (no login needed); list any you could not validate as UNVERIFIED in the document.
- If the Docker daemon answers, `docker build -f infra/gcp/Dockerfile .` runs; otherwise report it not run.
- `pnpm lint`, `format:check`, `check:isolation`, `check:no-live-host`, `check:secrets-names`, `check:hosting` (Render checker unchanged and green).

Do not: touch `packages/*` or `apps/*`; add a dependency; run `gcloud` with a login or contact any network or PayPal; write a real project id, account or secret anywhere; change the Render files.
Evidence for the PR: the commands above with output, the validated flag list, a cost line (runs, rounds, approximate tokens).
