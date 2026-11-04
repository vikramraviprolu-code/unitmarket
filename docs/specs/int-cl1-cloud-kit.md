# INT-CL1: cloud kit, phase 1

Task: One command each for cloud doctor, status, up, down, restart, deploy and logs, plus a public health route.
Package: `infra/gcp`, `scripts/check-hosting-gcp.mjs`, one route in `apps/web`. Builder: Sonnet 5.5 high. Reviewer: Opus 5.5 gate.
Items: cloud plan items 1 to 11, 21 points. Needs decision V4. Source: `/mnt/project-files/cloud-ops/cloud-start-stop-plan.md` sections 3.1, 4, 5.

## Goal

`infra/gcp/cloud.sh` with verbs `doctor`, `status [--json]`, `up`, `down`, `restart`, `deploy <tag>`, `logs`, all names from `infra/gcp/stack.env`, all idempotent, all with `--dry-run`, with the exit contract 0 ok, 1 failed, 2 refused, 64 usage. `down` sets `UMS_PAYPAL_CONNECT=off` first, never deletes, and warns when the newest backup is older than 24 hours. `GET /api/health` answers `ok`, `environment`, `revision`, `db` only. `check:hosting-gcp` fails if any kit file other than a future gateway helper writes `UMS_PAYPAL_CONNECT=on`, or contains `delete` or `--no-deletion-protection`. A one-page runbook replaces the copy-paste guide. Agents only run it against a fake `gcloud` (D-049).

## Outputs

New: `infra/gcp/cloud.sh`, `infra/gcp/stack.env`, `infra/gcp/lib/cloud-lib.sh`, `apps/web/src/app/api/health/route.ts`, `docs/owner/CLOUD-RUNBOOK.md`, tests. Changed: `scripts/check-hosting-gcp.mjs`, `package.json` (`cloud:*` scripts), route inventory.

## Acceptance tests (commit 1: tests only, run red)

| Item | Test file | Command | Expected |
|---|---|---|---|
| 1 to 8 | `scripts/cloud-kit.integration.test.ts` (fake `gcloud` on PATH, pattern of `deploy-kit-stub.integration.test.ts`) | `pnpm test:integration -- cloud-kit` | Each verb issues the expected `gcloud` calls in order; `down` sets the flag off before anything else; a second `up` prints "already up", exit 0; refused preconditions exit 2 with one `cloud:` line; `--dry-run` issues no mutating call |
| 9 | `apps/web/src/health.contract.test.ts` | `pnpm test:contract -- health` | Four fields only; no switch, flag or approval detail |
| 10 | `scripts/check-hosting-gcp.test.ts` | `pnpm test -- check-hosting-gcp` | A fixture writing the flag on, or containing `delete`, fails |
| 11 | review | | Runbook under one page, every command copyable |

## Do not

Run `gcloud` for real; add a cloud permission; touch the PayPal gateway steps; read secret values.

Branch: `feat/int-cl1-cloud-kit`. Commit: `feat(infra): one-command cloud kit and health route (INT-CL1)`.
