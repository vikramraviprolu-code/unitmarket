# Spec: the offline judge service uses the judge passcode (HARD-OFFLINE)

Task: give the offline service a fifth own secret so judges there get the judge passcode and can sign in buyer personas only.
Package: `infra/gcp`, `scripts/check-hosting-gcp.mjs` and tests, docs Owner: builder (Sonnet) Reviewer: Opus
Branch: `feat/hard-offline` Commit: `type(infra): <what> (HARD-OFFLINE)` Decisions: `OVERNIGHT-ASSUMPTIONS.md` items 22 and 24; open question 7 of `DEPLOY-PREP-2026-11.md`.

Goal: `unitmarket-offline` maps five own secrets. `UMS_OFFLINE_JUDGE_PASSCODE_HASH` (new) is mapped to `UMS_JUDGE_PASSCODE_HASH` and holds the hash of the judge passcode that judges receive. `UMS_OFFLINE_DEMO_PASSCODE_HASH` stays mapped to `UMS_DEMO_PASSCODE_HASH` (the app needs it for any sign in) but now holds a different, long random passcode that only the owners keep. Judges never receive it, so on the offline service they sign in Buyer A and Buyer B only and cannot open `/ops` or press Stop. `setup.sh` makes the new container and gives only `ums-offline` read access to it. The guard keeps refusing `ums-offline` bound to any PayPal or sandbox-service secret.

Inputs: `infra/gcp/*`, `scripts/check-hosting-gcp.mjs`, its fixtures. No env file is read, no gcloud run.
Outputs: the five offline names in `deploy-offline.sh`, `setup.sh`, `set-secret.sh`; the comments of `service-offline.yaml`; a new guard rule that pins the offline `SECRET_FLAGS` lines (rule `deploy-shape`); the fixtures (byte copies of the kit); guard and stub tests; `DEPLOY-PREP-2026-11.md`, `testing-instructions.md`, `judge-a-passcode.md` (names only).

Acceptance tests:

- `corepack pnpm exec vitest run --maxWorkers=2 scripts/check-hosting-gcp.test.ts scripts/deploy-kit-stub.integration.test.ts scripts/check-hosting.test.ts`: the offline deploy maps five secrets, the judge one to `UMS_JUDGE_PASSCODE_HASH`; refuses when any of the five has no value; new refusal cases fail for the judge name in a wrong list, mapped to a connect or mode name, bound to a non-offline secret, or the offline account bound outside its loop. Red first.
- `corepack pnpm check:hosting-gcp` prints `hosting-gcp ok`; `bash -n infra/gcp/*.sh`.
- `lint`, `typecheck`, `format:check`, `check:isolation`, `check:no-live-host`, `check:secrets-names`.

Do not: run gcloud; create a secret or account; put a passcode or hash value anywhere; touch app code; add a dependency.
