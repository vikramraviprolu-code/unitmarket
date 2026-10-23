# CO-9: one opener per PGlite directory, the serialisation proof, and Postgres refused until raced

Task: stop a second process (a CLI while the app runs) from opening the same PGlite directory, prove that PGlite runs one transaction at a time, and pin that boot refuses `UMS_DB=postgres`.
Package: `packages/db`, `apps/web` (one test) Owner: Sonnet 5.5 builder, effort medium (small; the PORT-1 waiver rests on it) Reviewer: Opus 5.5 high; Sakthi merges
Wave: W0, starts now. Assumptions: ASM-55 (new), ASM-05. Requirements: nfr.md PORT-1, REL-8, D-020; READINESS "real-Postgres race tests are required before MVP-C".

Recommendation recorded here (owner decides, O-C6): **waive real-Postgres race tests for MVP-C and run them at Supabase adoption.** Reasons: production stays PGlite in one process (REL-8, architecture 8); PGlite runs one transaction at a time, so Postgres lock races cannot occur in this deployment; running them needs `pg` (not on D-008), a Postgres server and, offline, no way to get one (docker would pull an image). The waiver is safe only while two facts hold, and this lane makes both machine-checked: one process per data directory, and no Postgres target.

Goal: `openDatabase({ kind: 'pglite-disk', dir })` creates `<dir>/.ums-open.lock` with `O_EXCL`, holding pid, host name and start time; if the file exists and names a live pid on this host it throws `DbInUseError` with the message "The UnitMarket app (pid N) holds this database. Stop it first, or use the ops page Stop button."; a lock naming a dead pid or another host is replaced only after a printed warning. `close()` and process exit remove it. Memory targets take no lock. `serial.state.test.ts` proves on PGlite that two concurrent `transaction()` calls never interleave statements (statement-order spy), which is the premise of ASM-55. `apps/web/src/postgres-refused.integration.test.ts` pins that an app built with `UMS_DB=postgres` refuses to start and opens no socket.

Inputs: `packages/db/src/{pglite.ts, driver.ts}`, `scripts/safety-cli.mjs` (consumer; prints the thrown message, unchanged), `apps/web/composition.server.ts` (current postgres refusal, read only).

Outputs: `packages/db/src/{lock.ts, pglite.ts}`, `packages/db/src/{lock.test.ts, lock.adversarial.test.ts, serial.state.test.ts}`, `apps/web/src/postgres-refused.integration.test.ts` (inside the web package, so it imports `../composition.server` by a package-relative path and needs no lint exemption; the package lists `@umsbx/config` already).

Lock rules (stated once; code and tests follow this list; ASM-72):

- Replaced after a printed warning: a lock naming a dead pid; a lock naming another host (Render runs one instance on one disk, so another host name is a previous incarnation; a shared volume with several live instances is unsupported and unsafe); a lock naming this process's own pid and host that this process does not hold (SIGKILL or OOM then a restart with the same pid, pid 1 in a container). A lock this process does hold is live and refuses a second open.
- Refused (fail closed, nothing deleted): a live pid on this host (`DbInUseError`); a symlink, a directory, an unreadable, empty (a crash between create and write), oversized, malformed lock, or a pid above 4194304 (`DbLockRefusedError`; the message says to remove the file by hand once no UnitMarket process runs).
- The replace runs inside an O_EXCL guard file `.ums-open.lock.break`; an opener that finds the guard refuses (code `guard`) and says to remove it by hand. This is what keeps two openers from both holding the lock.
- Backup and restore (CO-10) call `acquireLock` for their whole run once this merges, so they replace an other-host lock too: the CO-10 note "Another host: refuse" is superseded.
- `scripts/safety-cli.mjs` prints a refusal as one line `safety: <message>` and exits 1.

Notes for later lanes: BU-2 (R4, ASM-73): `UMS_DB=postgres` stops the data side only; Next's failed `prepare()` leaves a zombie server until BU-2 exits the process in `instrumentation.ts`. BU-2 (R9): the message names an ops-page Stop button that BU-2 adds; the spec's literal text stays. CO-10 (R10): restore holds no lock while it extracts.

Order: commit 1 is tests only, run red; then implement.

Acceptance tests:

- `corepack pnpm vitest run --project unit packages/db/src/lock.test.ts`: lock created, refused while held by a live pid, replaced when stale, removed on close.
- `corepack pnpm vitest run --project state packages/db/src/serial.state.test.ts`: 50 pairs of concurrent transactions: statements of one never appear between the statements of another.
- `corepack pnpm vitest run --project adversarial packages/db/src/lock.adversarial.test.ts`: a symlinked lock file, a lock file that is a directory, and an unreadable lock all refuse (fail closed); two openers racing: exactly one wins.
- `corepack pnpm vitest run --project integration apps/web/src/postgres-refused.integration.test.ts`: `UMS_DB=postgres` refuses with a clear message and no socket.
- `corepack pnpm test && corepack pnpm lint && corepack pnpm typecheck && corepack pnpm check:isolation`: exit 0.

Do not: add `pg` or any dependency; change migrations; change composition or config; delete a lock held by a live process.

Evidence for the PR: red summary; pass counts; the interleaving spy output; the waiver text above copied into the PR for the owner's row.

Branch: `feat/db-single-opener` Commit: `feat(db): single opener lock, serialisation proof, postgres refused (CO-9)`

## Notes (CO-10): the lock contract that backup and restore rely on

CO-10 (`scripts/backup.mjs`, `scripts/restore.mjs`) is written against this exact contract. CO-9 must implement it, or CO-10 must be changed in the same review.

- File: `<dir>/.ums-open.lock`, inside the PGlite data directory.
- Created with an exclusive create (`O_EXCL`, `wx`), mode `0600`. A symlink, a directory or an unreadable file is never trusted (fail closed).
- Content: JSON `{"pid": <int>, "host": <os.hostname()>, "started": "<ISO 8601 UTC>"}`.
- Live pid on this host: refuse (the message in the goal above). A dead pid, or a lock written on another host (ASM-72): print a warning, remove it, take a new lock.
- `backup.mjs` takes this same lock for its whole run and removes it at the end, also on failure. `restore.mjs` removes a lock found inside a restored tarball, then lets `openDatabase` take its own.
- The lock file is excluded from every dump: `backup.mjs` strips it from the tarball, the logical export never holds it.
- Until CO-9 is merged nothing writes this lock, so a running app is invisible to `backup.mjs`. Therefore `backup.mjs` refuses unless `--i-stopped-the-app` is passed, and it does not call itself a read-only copy: opening a PGlite directory writes to it.
