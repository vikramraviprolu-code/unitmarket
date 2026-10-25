# CO-7b: hosted maintenance mode (D-037, option a)

Task: let the owner insert the approval row and switch the PayPal switch on, on the Render disk, by starting the app in a maintenance mode that never opens the database.
Package: `packages/config`, `packages/security` (one gate), `apps/web`, `scripts/`, `render.yaml`, `docs/` Owner: Sonnet 5.5 builder, effort high Reviewer: Opus 5.5 high; Sakthi merges
Wave: after CO-G. Decisions: D-037 (this), D-011, D-029, D-031, D-035. Requirements: nfr REL-8 (one opener), SOP 14.

Goal: while a flag file exists at `/var/data/ums-maintenance` (beside the PGlite folder, on the persistent disk) at the moment the app boots, the app does not open the database (the single-opener lock stays free), does not start the job loop and builds neither the outbound nor any Wire. Every route and page answers 503 with code `maintenance`, except `/healthz`, which answers 200 with `maintenance: true`. The owner then runs the unchanged `corepack pnpm safety:approve` and `safety:resume` in the host shell, removes the flag and restarts. `scripts/backup.mjs` and `scripts/restore.mjs` accept the flag as the proof that the app is down (`--maintenance`); backup still refuses a live lock. The flag is created and removed only from the host shell. Maintenance mode may only REDUCE what the app does; none of the five locks is touched.

Design: the path is `UMS_MAINTENANCE_FLAG` (config, S3), pinned by `check:hosting` to `/var/data/ums-maintenance`, a sibling of `UMS_PGLITE_DIR` (never inside it, so a restore cannot delete it). The state is read once, when the app is built, and latched: a flag created later changes nothing until a restart, and removing it does not leave maintenance until a restart. Fail closed toward doing less: a missing parent folder (disk not mounted) or any error other than "no such file" reads as maintenance. The gate is `withRoute` (architecture 9.8: enforcement is in the route wrapper, middleware is a convenience): `SecurityDeps.maintenance` answers 503 before the method, the session or the body is looked at, for every path except the one in `MAINTENANCE_ROUTES` (`/healthz`). Pages are covered by the middleware, and by the closed database behind them.

Inputs: D-037, `packages/db/src/lock.ts`, `scripts/backup.mjs`, `scripts/restore.mjs`, `apps/web/composition.server.ts`, `docs/design/hosting.md`.

Outputs: `packages/config/src/{schema,load,index,maintenance}.ts`, `.env.example`, `packages/security/src/route.ts` (gate, 12 lines), `apps/web/composition.server.ts`, `apps/web/src/{middleware,instrumentation}.ts`, `apps/web/src/app/healthz/route.ts`, `render.yaml`, `scripts/{check-hosting,backup,restore}.mjs`, `packages/safety/src/cli-resume.ts` (a stale comment only: the web sign-in does give mfa since CO-6), `docs/design/hosting.md`, `docs/owner/MVPC-OWNER-STEPS.md` Step 6 only. Tests below; hosting fixtures under `scripts/__fixtures__/hosting/`.

Acceptance tests (all offline):

- `corepack pnpm vitest run --project unit packages/config/src/maintenance.test.ts`: flag absent reads off; present (file, folder, dangling link) reads on; missing parent folder and an unreadable path read on; the reader creates nothing; `UMS_MAINTENANCE_FLAG` must be an absolute, normal path named `ums-maintenance`, beside and not inside the PGlite folder.
- `corepack pnpm vitest run --project state packages/security/src/maintenance.state.test.ts apps/web/src/maintenance.state.test.ts`: with the flag, `ready`, `startJobs` and `health` never call `openDatabase`, `startLoop` or `buildOutbound` (sandbox mode too), no lock file and no PGlite folder appear, health is 200 `maintenance: true`; the gate answers 503 `maintenance` before the handler and any database read; without the flag boot is unchanged; the state is latched both ways.
- `corepack pnpm vitest run --project adversarial apps/web/src/maintenance.adversarial.test.ts`: every route handler found under `apps/web/src/app` answers 503 `maintenance` (health excepted), the flag keeps its bytes and its time, nothing else appears beside it, and in normal mode no route, as buyer, operator or anonymous, creates or deletes it.
- `corepack pnpm vitest run --project unit scripts/maintenance-flag.test.ts scripts/check-hosting.test.ts`: only the listed files touch node:fs or name the flag; the reader imports read functions only; `check:hosting` fails when the flag is missing, off the disk, inside the PGlite folder, not a sibling, or renamed.
- `corepack pnpm vitest run --project state scripts/backup-maintenance.state.test.ts`: backup and restore with `--maintenance` need the flag as a plain file beside the data folder; backup still refuses a live lock; the old `--i-stopped-the-app` path is unchanged.
- `corepack pnpm run ci` ends without an error.

Do not: add a dependency; change `safety:approve`, `safety:resume`, the lock, the five locks or any contract; create or delete the flag from any code path of the app; read `process.env` outside `packages/config`; edit Steps 1, 3, 7 or pin text of the owner steps; contact PayPal or any network; read or create a secret.

Evidence for the PR: red output of commit 1, green output of commit 2, the diff stat, the adversarial re-read, the open questions (Render web shell and TTY: unchecked).

Branch: `feat/hosting-maintenance-mode` Commit: `type(<package>): <what> (CO-7b)`
