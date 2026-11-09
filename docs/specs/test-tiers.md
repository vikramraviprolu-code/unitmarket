# TEST-TIERS: tiered regression, so no small change needs A to Z

Task: run only the regression a change needs, plus one integrated gate, and keep the full run as a background safety net.
Package: `scripts` (plus `tests/gate.json`, `docs/TESTING.md`, `.github/workflows/ci.yml`) Owner: Sonnet 5.5 builder Reviewer: Opus 5.5
Goal: `node scripts/test-tier.mjs --tier t1|t2|gate|full` runs one of four tiers; `--plan` prints what a tier would run, without running it. T1 quick: format check of the changed files, lint of the changed code files, typecheck of the touched workspaces, the fast `check:*` guards, and `vitest related` for the changed files. T2 lane: every test (all six suite kinds, by file-name suffix) in the touched workspaces, plus the T1 checks. T3 gate: the integrated critical pack from `tests/gate.json` (money, safety, data integrity, key e2e specs, `trace:verify`) plus whole-repo format, lint, typecheck and guards; it must finish in under 60 minutes wall clock. T4 full: the existing `pnpm test`. Changed files are `git diff --name-only <base>...HEAD`, plus uncommitted and untracked files; `--files a,b` replaces that for tests and reviews.
Inputs: `git`, `tests/gate.json`, the repo file list (`git ls-files`), `vitest.config.ts` suffix convention, `apps/web/playwright.config.ts`. Reads no env var, no secret.
Outputs: `scripts/test-tier.mjs`, `scripts/test-tier.test.ts`, `tests/gate.json`, `package.json` scripts `test:t1`, `test:t2`, `test:gate` (nothing else changes; `test` stays full), `docs/TESTING.md`, `.github/workflows/ci.yml` (`workflow_dispatch` input `tier`: `gate` or `full`, default `gate`).
Acceptance tests:

- `corepack pnpm vitest run scripts/test-tier.test.ts`: all pass (maps files to workspaces, checks `--plan` for docs only, a catalogue file and a migration, checks every `gate.json` glob still matches a file).
- `node scripts/test-tier.mjs --tier t1 --plan --files docs/TESTING.md`: lists `format` and the guards only; no lint, typecheck or vitest line.
- `node scripts/test-tier.mjs --tier t1 --plan --files domain/catalogue/src/fee.ts`: lists lint of that file, typecheck of `./domain/catalogue`, the guards and `vitest related` with that file.
- `node scripts/test-tier.mjs --tier t1 --plan --files packages/db/migrations/common/0032_x.sql`: lists `vitest` with the `packages/db` migration tests.
- `node scripts/test-tier.mjs --tier gate --plan`: lists the gate test files by kind, the e2e specs, then `trace:verify`; `--group tests --shard 1/4` lists one quarter of the test files.
- `corepack pnpm format:check && corepack pnpm lint && corepack pnpm check:isolation`: exit 0.

Do not: add a dependency; touch product code or any test other than the new one; read `process.env`; run PayPal, deploy, or add a secret or permission to CI; run the full suite while building this.
Evidence for the PR: the unit test run (red on commit 1, green on commit 2), `--plan` output for three sample changes, `prettier --check` and lint of the new files.
Branch: `feat/test-tiers` Commit: `feat(scripts): tiered test runner and gate pack (TEST-TIERS)`
