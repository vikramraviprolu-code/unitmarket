# Restricted deployer token preflight (GCP-TOKEN)

Goal: let `infra/gcp/deploy.sh` use the D-099 proxy-injected access token without
requiring an account in gcloud's local credential store. A non-empty
`CLOUDSDK_AUTH_ACCESS_TOKEN` or an active account satisfies the initial check;
neither is proof of valid credentials. The existing GCP preflight calls still
check actual access before build/deploy. Never print or persist the token.

Scope: `infra/gcp/deploy.sh`, `scripts/deploy-kit-stub.integration.test.ts`,
`scripts/check-hosting-gcp.mjs`, `scripts/check-hosting-gcp.test.ts`, the matching
`scripts/__fixtures__/hosting-gcp/good/infra/gcp/deploy.sh.fixture`, this spec.
Other scripts retain their account-only guard. Required secret checks, optional
secret behavior, the reviewed-tag/clean-checkout checks and PayPal locks stay intact.

Acceptance: stub tests cover token-only, account-only, no credentials, empty token,
and failed required-secret lookup with a token. The hosting checker accepts the
exact token-or-account guard only in deploy.sh; it rejects a reversed token test,
an unconditional bypass, token-only guards and token printing.

Commands (Node 22.22.0, pnpm 10.34.7):

- `corepack pnpm exec vitest run --maxWorkers=2 scripts/deploy-kit-stub.integration.test.ts scripts/check-hosting-gcp.test.ts`: pass.
- `corepack pnpm check:hosting-gcp`: pass.
- `bash -n infra/gcp/deploy.sh`: pass.
- `corepack pnpm exec eslint --max-warnings 0 scripts/check-hosting-gcp.mjs scripts/check-hosting-gcp.test.ts scripts/deploy-kit-stub.integration.test.ts`: pass.

Cloud IAM is a separate owner-approved operation. This patch neither grants access
nor authorizes deployment. D-099 still requires tested main and all three lanes
merged. A comment-only branch is not an exception to that rule.
