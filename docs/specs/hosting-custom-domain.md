# Spec: serve the sandbox app at https://unitmarket.live (DOM-1)

Task: make the repository ready to serve the hosted sandbox app at `https://unitmarket.live` instead of its `run.app` address.
Package: `infra/gcp` (service.yaml, deploy.sh, lib/cloud-lib.sh), `scripts/check-hosting-gcp.mjs` and its test and fixtures, `scripts/cloud-kit-support.ts`, `scripts/cloud-kit.integration.test.ts` and `scripts/deploy-kit-stub.integration.test.ts`, `README.md`, `docs/submission/submission-text.md`, a new owner runbook `docs/owner/CUSTOM-DOMAIN-UNITMARKET-LIVE.md`. Owner: Claude (Opus). Reviewer: Vikram.
Branch: `claude/project-thread-kfdob9` (no merge, no deploy until Vikram says so). Commit: `feat(hosting): <what> (DOM-1)`.

Goal: one value, `UMS_PUBLIC_ORIGIN` in `infra/gcp/service.yaml`, already drives the sign-in origin check (`packages/security/src/csrf.ts`), the PayPal return and cancel URLs (`domain/payments/src/checkout.ts`) and the MCP discovery URL. After this change it holds `https://unitmarket.live`, the checker accepts that exact origin for the sandbox service only, and the deploy and doctor scripts report the custom domain truthfully instead of claiming sign-in is refused. No application code changes.

Facts this spec relies on (checked 10 Nov 2026):
- Cloud Run domain mapping is not offered in `europe-west3` (Google lists asia-east1, asia-northeast1, asia-southeast1, europe-north1, europe-west1, europe-west4, us-central1, us-east1, us-east4, us-west1). The runbook therefore uses a global external Application Load Balancer with a serverless network endpoint group.
- Firebase Hosting forwards only the `__session` cookie; our session cookie is `__Host-ums_s` (`packages/security/src/session.ts`), so Firebase Hosting is not an option.

Requirements (tests first):
1. Checker: `UMS_PUBLIC_ORIGIN` in `service.yaml` may be the placeholder, an https `run.app` origin, or exactly `https://unitmarket.live`. Refused: any other host (including `www.unitmarket.live`), a path, plain http. `service-offline.yaml` keeps the old rule (placeholder or run.app only).
2. `service.yaml` holds `UMS_PUBLIC_ORIGIN: 'https://unitmarket.live'`; the good fixture equals the real kit byte for byte.
3. `deploy.sh`: when the origin is not a `run.app` origin, print `custom domain: UMS_PUBLIC_ORIGIN is <origin>; browser sign-in works only there, and the load balancer must route it to this service.` instead of the "sign-in is refused" NOTE.
4. `cloud doctor`: origin equal to the service address: ok (unchanged); a non-`run.app` origin: ok line naming the custom domain and the service address; a different `run.app` origin: the existing `origin mismatch` warning.
5. Test support: the fake service address is the real `run.app` address, not the value read from `service.yaml`; a scenario may set the origin in its copy of `service.yaml`. Edited test (spec change 4): `reports an origin mismatch ...` now sets a `run.app` origin, because the real kit no longer holds one.
6. README and submission text name `https://unitmarket.live` as the hosted demo address.

Acceptance (run, paste output):
- `corepack pnpm check:hosting-gcp` exits 0.
- `corepack pnpm exec vitest run scripts/check-hosting-gcp.test.ts scripts/cloud-kit.integration.test.ts scripts/deploy-kit-stub.integration.test.ts` all pass, including the new cases.
- `bash -n infra/gcp/deploy.sh infra/gcp/lib/cloud-lib.sh` exits 0.
- `corepack pnpm lint`, `corepack pnpm typecheck`, `corepack pnpm format:check`, `corepack pnpm check:no-live-host`, `corepack pnpm check:secrets-names` exit 0.
- `git grep -n "unitmarket-sandbox-626887286871" -- README.md docs/submission` prints nothing.

Do not: touch `packages/*`, `apps/*` or `domain/*`; run gcloud or contact PayPal; add a dependency; change `service-offline.yaml`; merge or deploy.
Evidence: command output in the PR.
