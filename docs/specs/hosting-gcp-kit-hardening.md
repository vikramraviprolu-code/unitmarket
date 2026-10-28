# Spec: Google Cloud kit hardening after the first real deploy (GCP-2)

Task: close the LOW findings of the GCP-1 Opus review and the facts the first deploy taught us.
Package: `infra/gcp`, `scripts/check-hosting-gcp.mjs` and its test and fixtures, `docs/owner/MVPC-OWNER-STEPS-GCP.md` Owner: GCP-2 builder Reviewer: Opus, one round (D-048)
Branch: `feat/hosting-gcp-hardening` Commit: `feat(hosting): <what> (GCP-2)` Decisions: D-043 to D-053.

Goal: the checker refuses every unsafe one-line edit of the kit that the review found, the image is built from a pinned base and tagged by commit, and the owner document matches what really happened on 27 Oct.

Requirements (tests first: each new refusal is a named case that mutates a clean kit by one line):

1. Checker refuses: `--authorized-networks` with any value; `--no-deletion-protection`; PITR or backups removed (`--no-backup`, `--no-enable-point-in-time-recovery`); an `--ssl-mode` other than `ENCRYPTED_ONLY`; `roles/owner` or `roles/editor` for the runtime service account; `secretmanager` roles bound at project level (only per-secret bindings allowed); `--scaling` and a service-level `--max` or `--min` other than the pinned instance flags; a second `--env-vars-file`; `tee`, `declare -p`, `set -x` or `xtrace` inside a script that touches a secret value. Also accept `--max-instances 1` with a space and the double-quoted `UMS_DB: "postgres"` forms (legal formatting that is refused today), or document in the checker message that the form is pinned.
2. `setup.sh`: `--connector-enforcement=REQUIRED` on the instance (flag validated with `gcloud sql instances create --help`), and a limit on storage auto-increase.
3. `set-secret.sh`: `IFS= read -r -s` so leading and trailing spaces are kept.
4. `deploy.sh`: the image tag carries the short commit id as well as the tag name (`<tag>-<sha>`), so a moved tag cannot reuse an old image.
5. `Dockerfile`: pin the base image by digest `node:22.22.0-bookworm-slim@sha256:dd9d21971ec4395903fa6143c2b9267d048ae01ca6d3ea96f16cb30df6187d94` (taken from the real Cloud Build log of 27 Oct), fix the comment that says stage 2 copies only the build output, and comment that both stages must keep `WORKDIR /app` (the migrations path resolves at build time). The `CMD` stays as the checker pins it.
6. Owner document (`MVPC-OWNER-STEPS-GCP.md`): (a) log reading uses `gcloud logging read '... jsonPayload.msg=~"webhook"' --format='json(timestamp,jsonPayload)'`: `gcloud run services logs read` shows blank lines for our JSON logs; (b) the learn window needs one REAL purchase: the simulator sends unsigned mock events and teaches nothing (D-053), and 7 of 8 events are registered; (c) `unset DATABASE_URL` at the end of Step I; (d) warnings: never `delete` or `--no-deletion-protection` on `unitmarket-sbx-pg`; shutting down the project deletes all data after 30 days; a budget alert does not cap spending; on a secret rotation disable the old versions; (e) Step order: Step I item 5 needs Step 4 and the proxy depth test first, and a redeploy resets the connection to off, so item 5 is repeated after Step J; (f) after every `git pull` on the Mac rebuild with `corepack pnpm --filter @umsbx/web build`; (g) Google reserves `/healthz` on run.app addresses; (h) the ten-secret and eleven-name text is correct (UMS_OWN_MERCHANT_ID).

Acceptance (run, paste output): `corepack pnpm check:hosting-gcp`; `corepack pnpm exec vitest run --maxWorkers=2 scripts/check-hosting-gcp scripts/check-hosting.test.ts tests/mvp-b/sealed-callers.test.ts`; `bash -n` on every script; lint, format:check, typecheck, check:isolation, check:no-live-host, check:secrets-names, check:hosting; every new gcloud flag validated with `--help` offline.
Do not: touch `packages/*` or `apps/*`; add a dependency; run gcloud with a login or contact any network; write a real secret, account or merchant id; change `render.yaml`; edit an existing test except to follow a spec change above (list each).
Disk: nearly full; run `df -h /` before heavy steps, stop under 400 MB.
Evidence: commands with output, the list of new refusal cases, a cost line.
