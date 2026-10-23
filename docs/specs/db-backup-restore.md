# CO-10: offline backup and restore round trip (first lane to cut)

Task: give the owner one command to back up the PGlite directory (data-dir tarball plus logical export) and one to restore it, both proven offline by a round trip.
Package: `scripts/`, `packages/db` (`export-sql.ts`, import side) Owner: Sonnet 5.5 builder, effort medium (operator tool, no hostile input) Reviewer: Opus 5.5 high (data); Sakthi merges
Wave: W0, starts now. Cut first under time pressure: the owner can use Render disk snapshots plus a manual copy instead. Assumptions: ASM-05, ASM-55. Requirements: nfr.md REL-5, REL-7, C-10 (offline part).

Goal: `node scripts/backup.mjs --dir <pglite dir> --out <folder outside the repo>` refuses while the app holds the directory (CO-9 lock, if merged; otherwise it checks the lock file itself), writes `pglite-<utc>.tar.gz` (`dumpDataDir`), `export-<utc>.sql` (`tools/export-sql` logic in `packages/db/src/export-sql.ts`, schema version header, FK order) and `manifest.json` (sha256 of both, row count per table, migration version). `node scripts/restore.mjs --from <folder> --dir <empty dir>` refuses a non-empty target, checks both hashes, loads the tarball, migrates, and compares row counts with the manifest; `--sql` instead imports the logical export into a fresh PGlite inside one transaction with the append-only triggers disabled only there (READINESS FIX-W1A note), then compares counts. Neither script reads secrets or opens a network connection. Off-host copying is the owner's job and is written as one line in the hosting doc of CO-7 (this lane does not edit that file).

Inputs: `packages/db/src/{export-sql.ts, migrate.ts, pglite.ts, testing.ts}`, READINESS FIX-W1A note on the import transaction.

Outputs: `scripts/{backup.mjs, restore.mjs}`, `scripts/backup.state.test.ts`, `scripts/restore.integration.test.ts`, `packages/db/src/export-sql.ts` (import function) and its test.

Order: commit 1 is tests only, run red; then implement.

Acceptance tests:

- `corepack pnpm vitest run --project state scripts/backup.state.test.ts`: a seeded database with an order, a capture, a refund and a receipt backs up; the manifest counts match; a running-app lock refuses.
- `corepack pnpm vitest run --project integration scripts/restore.integration.test.ts`: tarball restore and SQL restore each give identical row counts and identical ledger sums; a changed byte in either file refuses; a non-empty target refuses; the restore takes under 30 s for the seeded set (RTO budget is 30 min).
- `corepack pnpm test && corepack pnpm lint && corepack pnpm typecheck`: exit 0.

Do not: write into the repository; delete the source directory; disable append-only triggers outside the import transaction; add a dependency; touch root `package.json` (CO-7 owns it in this wave).

Evidence for the PR: red summary; pass counts; a sample manifest from the test run (no data values).

Branch: `feat/db-backup-restore` Commit: `feat(db): offline backup and restore with manifest round trip (CO-10)`
