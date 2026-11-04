# INT-CL1: cloud kit, phase 1, round 3 (passed 12 of 12, with build notes N1 to N4)

Task: One command each for cloud doctor, status, up, down, restart, deploy and logs; a revision on the public status route; guard rules that allow exactly this and nothing more.
Package: `infra/gcp`, `scripts/check-hosting-gcp.mjs`, `packages/config`, `apps/web` (status route). Builder: Sonnet 5.5 high. Reviewer: Opus 5.5 gate.
Items: cloud plan items 1 to 11, 21 points. Decision V4, plus a decision-log row amending D-049 (F10). Source: `/mnt/project-files/cloud-ops/cloud-start-stop-plan.md` sections 3.1, 4, 5. Round 2 answers `cl1-scorecard.md` F1 to F13.

## Goal

`infra/gcp/cloud.sh` has seven verbs: `doctor`, `status [--json]`, `up`, `down`, `restart`, `deploy <tag>` and `logs`.
- All names come from `infra/gcp/stack.env`, which is parsed as strict `KEY=value` lines and never `source`d.
- Every verb is idempotent and takes `--dry-run`, which makes only `describe` and `list` calls.
- Exit codes: 0 ok, 1 failed, 2 refused, 64 usage. With no terminal, every prompt refuses with exit 2.
- **No verb sets `UMS_PAYPAL_CONNECT` on.**

`down`:
- Its first mutating call sets `UMS_PAYPAL_CONNECT=off`.
- It asks for the typed service name unless `--yes` is given.
- It warns when the newest backup is older than 24 hours.
- It sets min 0, ingress `internal` and SQL `NEVER`, and never deletes anything.

`up` restores the running pair `--min-instances=1 --max-instances=1`, `--no-cpu-throttling`, ingress `all` and SQL `ALWAYS`.

`deploy`:
- It needs a backup at most 24 hours old, unless `--accept-old-backup` is given.
- It refuses a dirty tree.
- It never creates or moves a git tag, and never fetches or checks out. HEAD must already be exactly at `<tag>` (`git describe --exact-match --tags HEAD`), or it exits 2.

`doctor` prints the two `gcloud config set` lines for the owner to paste, and never runs them.

The public `GET /api/v1/status` gains `revision` and `db`, additively (F11).

A runbook of at most 60 lines replaces the copy-paste guide. Agents run the kit only against a fake `gcloud` (D-049).

## Status route (F11)

There is no new `/api/health`. `GET /api/v1/status` (public, in OpenAPI) answers 200 `{ok: true, environment, revision, db, maintenance?}`.
- `revision` is the Cloud Run `K_REVISION` value read by `packages/config`, or `null` off Cloud Run.
- `db` is `"up"`, or `"closed"` in maintenance mode; `maintenance: true` is kept as today.
- An unhealthy app still answers 503 `unhealthy`.
- No switch, flag or approval detail is added.
`up`, `deploy` and CTL.2 probe this route. `/healthz` is unchanged.

## `status --json` shape (F4)

The shape is the one agreed in cloud plan 3.1 and used by CTL.2, with one field changed (R2-4). It is pinned in `scripts/__fixtures__/cloud-status.json`, which CTL.2 reads too:

```json
{"checked_at": "...", "project": "...", "services": [
  {"name": "web", "state": "up", "revision": "...", "url": "...", "last_changed_at": "...", "last_error": null},
  {"name": "job_loop", "state": "up", "runs_in": "web", "last_changed_at": "...", "last_error": null},
  {"name": "database", "state": "up", "tier": "...", "newest_backup_at": "...", "last_changed_at": "...", "last_error": null},
  {"name": "offline_judge", "state": "absent", "last_error": null},
  {"name": "paypal_gateway", "state": "off", "flag": "off", "approval_ref_set": true, "last_changed_at": "..."}
]}
```

- `state` is one of `up`, `down`, `starting`, `stopping`, `error` and `absent`; `paypal_gateway.state` is `on` or `off`, the Cloud Run flag only.
- `job_loop` mirrors `web`, because the loop runs inside the app. `offline_judge` reports the real state from describing `unitmarket-offline` (`deploy-offline.sh` still exists), and is `absent` only when that service does not exist; it is never hard-coded (N1).
- `approval_ref_set` replaces the plan's `approval_ref_matches`. It is true when the secret has an enabled version (names only, as `deploy.sh` `has_secret_value` does), and no secret value is read.
- Exit 1 when any service is `down` or `error`.

## Guard changes (F1, F2, F3), each with a red fixture

| Rule (`check-hosting-gcp.mjs`) | Change |
|---|---|
| `kit-files` (155-158) | `KIT` gains `cloud.sh`, `stack.env`, `lib/cloud-lib.sh`; the guard reads that one subfolder; every per-file rule (bytes, strict-mode, account-guard, live-value and the rest) applies to them |
| `env-flags` (300) | allows exactly `--update-env-vars=UMS_PAYPAL_CONNECT=off` in `lib/cloud-lib.sh` only. Must fail: `...=on`, `UMS_MODE=x`, `UMS_PAYPAL_CONNECT=off,UMS_MODE=x`, `--remove-env-vars=UMS_PAYPAL_CONNECT`, `--clear-env-vars`, `UMS_PAYPAL_CONNECT=${ON}`, the flag split over a line continuation |
| `min-instances`, `max-instances` (262-263) | min `0` or `1` and max `1`, in `lib/cloud-lib.sh` only. Must fail: `--min-instances=2`, `--max-instances=2` |
| `cpu-throttling` (272) | `--no-cpu-throttling` also allowed in `lib/cloud-lib.sh` |
| `scaling` (267) | unchanged: `--scaling` stays barred |
| `literal-project` (478) | unchanged: doctor prints the config lines and does not run them |
| new `no-delete` | `\bdelete\b` in any statement that runs `gcloud`, `gsutil`, `rm` or `git` fails. Echo text is not a statement, so `monitoring.sh:132` passes. Must fail: `gcloud run services "$VERB"` with `VERB=delete` set in the file |
| `sql-protection` (362) | kept: `--no-deletion-protection` stays barred |
| `paypal-connect` (220-226) | kept, with no exception for any helper; a gateway lane adds its own under its own decision |

Builder trap: `live-value` fails any kit line containing the word "live" (for example "the live URL"), so the kit must avoid that word.

## Outputs (only these files)

New:
- `infra/gcp/cloud.sh`, `infra/gcp/stack.env`, `infra/gcp/lib/cloud-lib.sh`
- `docs/owner/CLOUD-RUNBOOK.md`
- `scripts/__fixtures__/cloud-status.json`
- the tests below

Changed:
- `scripts/check-hosting-gcp.mjs`, `scripts/check-hosting-gcp.test.ts`
- `packages/config/src/load.ts` and `packages/config/src/schema.ts` (`revision` from `K_REVISION`; `K_REVISION` added to `ENV_NAMES`, R2-3)
- `.env.example` (`K_REVISION=` name only; `ENV_NAMES` must equal it exactly, `schema.ts:85`)
- `packages/contracts/src/v1.ts` (`StatusSchema` at line 560 is `.strict()`: add `revision: string | null` and `db: 'up' | 'closed'`; the summary at line 992 becomes "the /healthz body plus revision and db", R2-1)
- `apps/web/src/app/api/v1/ops.contract.test.ts` (case O5, lines 143 to 151, becomes "the /healthz body plus `revision` and `db`, still with no switch, outbound or lock field"; the assertion is moved, not weakened, R2-2)
- `apps/web/composition.server.ts` (`health()` returns `revision`)
- `apps/web/src/api-v1/ops.ts` (`status` body), `docs/api/openapi-v1.json`
- `package.json` (`cloud:doctor`, `cloud:status`, `cloud:up`, `cloud:down`, `cloud:restart`, `cloud:deploy`, `cloud:logs`, and nothing else)
- `docs/owner/SAKTHI-DEPLOY-COPYPASTE.md` (body becomes a pointer to the runbook)
- `docs/decision-log.md`. The row takes the next free id at merge and amends D-049 under V4: a stopped state (min 0, ingress `internal`, SQL `NEVER`) is allowed; the running state stays min 1, max 1, no throttling; only `lib/cloud-lib.sh` may set either.

`deploy.sh`, `deploy-offline.sh`, `setup.sh` and `monitoring.sh` are not changed. A golden test pins their literal names to `stack.env` (F12). `stack.env` holds no project id on a `--project` line.

## Acceptance tests (commit 1: tests only, run red)

All kit tests put a fake `gcloud` on PATH that logs each call and exits 97 on any call the case does not expect (the `deploy-kit-stub.integration.test.ts` pattern). No test reaches the network.

| Item | Test file | Command | Expected |
|---|---|---|---|
| 1 lib | `scripts/cloud-kit.integration.test.ts` | `corepack pnpm vitest run scripts/cloud-kit.integration.test.ts` | Exit codes 0, 1, 2 and 64; usage error gives 64; `--dry-run` makes only describe and list calls |
| 2 doctor | same file | same | No active account: exit 2, the two config lines printed, no `config set` call; an old backup prints a warning; an origin mismatch is reported |
| 3 status | same file, `scripts/cloud-status.contract.test.ts` | same, and `corepack pnpm vitest run scripts/cloud-status.contract.test.ts` | `--json` equals the fixture shape, with five services, `state` in the enum, and no `secrets versions access` call; exit 1 when a part is down |
| 4 up | same file | same | Calls in order: SQL `ALWAYS`, wait `RUNNABLE`, run update with min 1, max 1, no throttling, ingress all, then the health probe; a second `up` prints "already up", exit 0; a missing service gives exit 2 "run cloud deploy" |
| 5 down | same file | same | The flag-off update is the first mutating call; with no terminal and no `--yes`, exit 2; no call contains `delete`; a backup older than 24 hours warns |
| 6 restart | same file | same | Exactly one update, with a `restarted-at` label; image and env unchanged |
| 7 deploy | same file | same | No backup in 24 hours: exit 2 unless `--accept-old-backup`; a dirty tree gives exit 2; a bad tag gives 64; no `git tag` or `git push`; prints the paste-back block |
| 8 logs | same file | same | `--lines` bounded (default 100, max 1,000); no request bodies printed |
| 9 status route | `apps/web/src/v1-status.contract.test.ts` | `corepack pnpm vitest run apps/web/src/v1-status.contract.test.ts` | 200 body has exactly `ok, environment, revision, db` (+ `maintenance` in maintenance mode, `db: "closed"`); unhealthy gives 503; matches OpenAPI; `pnpm check:openapi` and `pnpm check:routes` pass |
| 10 guard | `scripts/check-hosting-gcp.test.ts` | `corepack pnpm vitest run scripts/check-hosting-gcp.test.ts` | Every red fixture in the guard table fails and the real kit passes; the `cloud:*` scripts map one to one to the seven verbs (no `cloud:on`); `stack.env` equals the literals in the four reviewed scripts |
| 11 runbook | `scripts/cloud-runbook.golden.test.ts` | `corepack pnpm vitest run scripts/cloud-runbook.golden.test.ts` | `CLOUD-RUNBOOK.md` is at most 60 lines; every `corepack pnpm cloud:<verb>` in it exists in `package.json` |
| L items 5, 10 | `scripts/cloud-kit.adversarial.test.ts` | `corepack pnpm vitest run scripts/cloud-kit.adversarial.test.ts` | See below |

`cloud-kit.adversarial.test.ts` (F8):
- `stack.env` with `SERVICE='x;touch pwn'`, `$(...)` or backticks gives exit 2, no `gcloud` call and no file created.
- A project or region failing the `deploy.sh` regexes gives exit 2.
- When `down`'s flag-off update fails: exit 1, with no SQL or Run call after it.
- Every verb with `--dry-run` makes only describe and list calls.
- A `deploy` tag with metacharacters gives 64.
- **Planted-defect table**: the test copies `lib/cloud-lib.sh` to a temp dir, applies each defect, and asserts a named case turns red. The defects are: flag-off removed; flag-off moved after the SQL stop; `--activation-policy=NEVER` dropped; backup warning removed; `--yes` check inverted.

Mutation: `pnpm mutation --require-targets --targets scripts/check-hosting-gcp.mjs --test-cmd "corepack pnpm vitest run scripts/check-hosting-gcp.test.ts scripts/cloud-kit.adversarial.test.ts" --threshold 80`. Bash is covered by the planted-defect table.

## Safety

The gate runs `pnpm check:hosting-gcp`, `pnpm check:no-live-host`, `pnpm check:secrets-names`, `pnpm check:routes` and `pnpm check:openapi`. Offline proof: the fake `gcloud` exits 97 on any unexpected call, and the suite opens no socket.

## Build notes (scorer round 3)

N2: regenerate `docs/api/openapi-v1.json` with `pnpm openapi:emit`. N3: O5 is the only existing test this lane may edit, and the gate checks this. N4: the PR attaches the commit 1 red output, the mutation result (at least 80 percent), the planted-defect results and the `ci` output.

## Do not

Run `gcloud` for real; add a cloud permission; touch the PayPal gateway steps; read a secret value; change the four reviewed deploy scripts; add `--scaling`; add any exception to `paypal-connect`.

Branch: `feat/int-cl1-cloud-kit`. Commit: `feat(infra): one-command cloud kit and status revision (INT-CL1)`.
