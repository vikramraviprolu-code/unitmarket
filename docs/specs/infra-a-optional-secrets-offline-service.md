# Spec: optional secrets and an offline judge service in the Google Cloud kit (INFRA-A)

Task: map the four new config names as optional Secret Manager secrets, and prepare (never run) a second Cloud Run service for judges.
Package: `infra/gcp`, `scripts/check-hosting-gcp.mjs` with its test and fixtures, `docs/owner/DEPLOY-PREP-2026-11.md` Owner: builder (Sonnet) Reviewer: Opus
Branch: `feat/infra-a-deploy-kit` Commit: `feat(infra): <what> (INFRA-A)` Decisions: D-049, D-065 (assumptions 6, 16, 21 and 22 of `docs/owner/OVERNIGHT-ASSUMPTIONS.md`).

Goal: `deploy.sh` maps `UMS_PUBLISHER_PASSCODE_HASH`, `UMS_OFFER_MAX_MINOR`, `UMS_AI_ADAPTER` and `UMS_ANTHROPIC_API_KEY` only when each has an enabled version; an absent one leaves its feature off and never fails the deploy. `UMS_AI_ADAPTER` is skipped when `UMS_ANTHROPIC_API_KEY` has no value (the app refuses to boot on `claude` without a key). `service.yaml` is unchanged, so `UMS_PAYPAL_CONNECT` is `off` after every deploy. A second service, `unitmarket-offline`, is described by `service-offline.yaml` and deployed by a sibling script `deploy-offline.sh`: `UMS_MODE=offline`, `UMS_DB=pglite-memory`, min and max one instance, no PayPal name, no Cloud SQL, its own runtime account `ums-offline`, and four own secrets `UMS_OFFLINE_SESSION_SECRET`, `UMS_OFFLINE_APPROVAL_SECRET`, `UMS_OFFLINE_LINK_SECRET`, `UMS_OFFLINE_DEMO_PASSCODE_HASH` (mapped to the env names without `OFFLINE_`). The label comes from stored data: `NEXT_PUBLIC_UMS_ENV_LABEL` is not set there. Nothing is run: no gcloud, no deploy, no tag, no secret.

Inputs: `infra/gcp/*`, `scripts/check-hosting-gcp.mjs`, its test and fixtures, `packages/config/src/load.ts` (read only).
Outputs: `infra/gcp/deploy.sh`, `set-secret.sh`, `setup.sh` (containers and bindings for the new names), new `deploy-offline.sh` and `service-offline.yaml`; the guard, its test and fixtures (a byte for byte copy of the kit); a new `scripts/deploy-kit-stub.integration.test.ts` that runs both deploy scripts against a stub `gcloud` in a temporary git repository; `docs/owner/DEPLOY-PREP-2026-11.md`.

Guard rules added: `optional-secret` (a die on an optional name, or no optional loop), `offline-paypal`, `offline-secret`, `offline-shape` (no Cloud SQL, runtime account `$OFFLINE_SA`), and the existing rules now apply to each deploy script and each yaml. Everything refused before is still refused.

Acceptance (run, paste output):

- `corepack pnpm exec vitest run --maxWorkers=2 scripts/check-hosting-gcp.test.ts` : all pass, red before the change.
- `corepack pnpm exec vitest run --maxWorkers=2 scripts/deploy-kit-stub.integration.test.ts` : no optional value maps nothing and the deploy still runs; all four map; the adapter without the key is left out; the env file passed to the deploy holds `UMS_PAYPAL_CONNECT: 'off'`; the offline deploy maps only the four own secrets and refuses when one has no value.
- `corepack pnpm check:hosting-gcp` : `hosting-gcp ok`. `bash -n` on every script.
- `corepack pnpm lint`, `typecheck`, `format:check`, `check:isolation`, `check:no-live-host`, `check:secrets-names`, `check:hosting` and the six suites.

Do not: run gcloud (the test uses a stub on `PATH`); read any secret or env file; change `packages/*`, `apps/*` or `render.yaml`; add a dependency; set `UMS_PAYPAL_CONNECT` to anything but `off`.
Evidence: red and green output, cost line.
