# Spec: a judge passcode that signs in buyers only (JUDGE-A)

Task: add a separate judge passcode that opens the buyer personas and nothing else, so a judge can use the demo but cannot open `/ops` or press Stop.
Package: `packages/config`, `apps/web` (sign-in in `composition.server.ts`), `infra/gcp`, `scripts/check-hosting-gcp.mjs`, docs Owner: builder (Sonnet) Reviewer: Opus
Branch: `feat/judge-a-passcode` Commit: `feat(web): <what> (JUDGE-A)` Decisions: `OVERNIGHT-ASSUMPTIONS.md` items 22 and 24; decision items 22 and 24.

Goal: one new optional name, `UMS_JUDGE_PASSCODE_HASH` (config field `judge_passcode_hash`, default null). It has the same shape as `UMS_DEMO_PASSCODE_HASH`, and a boot refuses (`equal_secrets`, naming the variable only) when it equals the demo hash or the publisher hash, in either separator form. In `signIn`: when the judge hash is set, the judge passcode verifies for `buyer-a` and `buyer-b` only; `operator` and the three publisher personas never verify against it. The demo passcode keeps working for buyers and the operator as before (owners decide later whether to unset it on the hosted app). The publisher passcode still verifies for publisher personas only. With the judge hash unset, sign-in behaves exactly as today. Timing: an unknown persona, or a persona whose hash is unset, costs one verification (against the demo hash). A buyer persona with the judge hash set always runs both verifications, with no early return, so a right demo passcode and a right judge passcode cost the same. Rate limits are untouched. The demo hash must still be set (the existing early return stays); the sign-in page is unchanged, judges type the judge passcode in the one buyer field.

Offline judge service: first left unchanged, then closed by `docs/specs/infra-hard-offline.md` (HARD-OFFLINE): `deploy-offline.sh` now maps five own secrets, and the fifth, `UMS_OFFLINE_JUDGE_PASSCODE_HASH`, reaches the app as `UMS_JUDGE_PASSCODE_HASH`. The stored demo hash there is a separate passcode the owners keep private.

Inputs: `packages/config/src/{schema,load}.ts`, `apps/web/composition.server.ts`, `infra/gcp/*.sh`, `scripts/check-hosting-gcp.mjs` and its fixtures. No env file is read.
Outputs: config field, name in `ENV_NAMES`, `.env.example` (name, empty), `signIn` change, the name in the optional lists of `deploy.sh`, `setup.sh`, `set-secret.sh`, the guard and the fixtures (byte copies of the kit), the exclusion list in `scripts/check-hosting.test.ts`, `docs/owner/DEPLOY-PREP-2026-11.md`, `docs/submission/testing-instructions.md`. Optional list order: publisher hash, judge hash, offer cap, adapter, key.

Acceptance tests (run, paste the counts):

- `corepack pnpm exec vitest run --maxWorkers=2 packages/config/src/judge-passcode.test.ts` : default null; blank is null; both forms accepted; malformed, equal to demo and equal to publisher refused naming the variable only. Red first.
- `corepack pnpm exec vitest run --maxWorkers=2 apps/web/src/judge-passcode.adversarial.test.ts` : judge passcode signs in `buyer-a` and `buyer-b`; refused for `operator` and every publisher persona; publisher passcode refused for buyers; demo passcode unchanged for buyers and operator; judge hash unset changes nothing; unknown persona costs one verification; the failure body is the same for every refusal. Red first.
- `corepack pnpm exec vitest run --maxWorkers=2 scripts/check-hosting-gcp.test.ts scripts/deploy-kit-stub.integration.test.ts scripts/check-hosting.test.ts` : the judge name is optional, mapped only with a value, and a guard case fails when a kit file drops it.
- `corepack pnpm check:hosting-gcp` prints `hosting-gcp ok`; `bash -n infra/gcp/*.sh`.
- `lint`, `typecheck`, `format:check`, `check:isolation`, `check:no-live-host`, `check:secrets-names`, `corepack pnpm --filter @umsbx/web build`.

Do not: read any env file; run gcloud or any sandbox call; change a contract or the sign-in page; add a dependency; put a passcode or hash value anywhere.
Evidence: red and green output, cost line.
