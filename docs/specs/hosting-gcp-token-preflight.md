# Restricted deployer credentials and build identity (D-099)

Goal: let `infra/gcp/deploy.sh` use the D-099 proxy-injected access token without
requiring an account in gcloud's local credential store. A non-empty
`CLOUDSDK_AUTH_ACCESS_TOKEN` or an active account satisfies the initial check;
neither is proof of valid credentials. The existing GCP preflight calls still
check actual access before build/deploy. Never print or persist the token. Select
the existing `ums-builder` account explicitly for Cloud Build so it cannot fall
back to the default Compute account. Use `CLOUD_LOGGING_ONLY` and suppress client
log streaming; submission still waits for build success before deploying.

Scope: `infra/gcp/deploy.sh`, `scripts/deploy-kit-stub.integration.test.ts`,
`scripts/check-hosting-gcp.mjs`, `scripts/check-hosting-gcp.test.ts`, the matching
`scripts/__fixtures__/hosting-gcp/good/infra/gcp/deploy.sh.fixture`, this spec,
and the D-099 row in `docs/decision-log.md` recording the existing scoped grants.
Other scripts retain their account-only guard. Required secret checks, optional
secret behavior, the reviewed-tag/clean-checkout checks and PayPal locks stay intact.

Acceptance: stub tests cover token-only, account-only, no credentials, empty token,
and failed required-secret lookup with a token. The hosting checker accepts the
exact token-or-account guard only in deploy.sh; it rejects a reversed token test,
an unconditional bypass, token-only guards and token printing. Build-path stub
tests capture the generated configuration and verify the project-specific builder,
Cloud Logging, synchronous submission, the separate runtime identity and connection
off. A failed build prevents every Cloud Run call; an existing image skips building.

Commands (Node 22.22.0, pnpm 10.34.7):

- `corepack pnpm exec vitest run --maxWorkers=2 scripts/deploy-kit-stub.integration.test.ts scripts/check-hosting-gcp.test.ts`: pass.
- `corepack pnpm check:hosting-gcp`: pass.
- `bash -n infra/gcp/deploy.sh`: pass.
- `corepack pnpm exec eslint --max-warnings 0 scripts/check-hosting-gcp.mjs scripts/check-hosting-gcp.test.ts scripts/deploy-kit-stub.integration.test.ts`: pass.
- `corepack pnpm exec tsc -p scripts/tsconfig.json`: pass.
- `corepack pnpm check:isolation`, `check:no-live-host`, `check:secrets-names`, `check:hosting`: pass.

Prerequisites already verified in `unitmarket-sbx-vr1`: the deployer has
`roles/iam.serviceAccountUser` on `ums-builder`; the builder has bucket-scoped
`roles/storage.objectViewer`, repository-scoped `roles/artifactregistry.writer`,
and project-scoped `roles/logging.logWriter`. Build logs remain available to the
owner in Cloud Logging. Configuration follows Google's
[user-managed build account guidance](https://docs.cloud.google.com/build/docs/securing-builds/configure-user-specified-service-accounts).
Verify `--suppress-logs` with `gcloud builds submit --help` without contacting GCP.

Cloud IAM is a separate owner-approved operation. This patch neither grants access
nor authorizes deployment. D-099 still requires tested main and all three lanes
merged. A comment-only branch is not an exception to that rule.
