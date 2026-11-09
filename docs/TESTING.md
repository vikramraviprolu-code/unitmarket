# Testing: which tier to run

A small change does not need the whole suite. There are four tiers. Each one runs more than the one before.
Spec: `docs/specs/test-tiers.md`. Runner: `scripts/test-tier.mjs`. Gate pack: `tests/gate.json`.

| Tier     | Command                   | What it runs                                                                                                                                                                                                                         |
| -------- | ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| T1 quick | `corepack pnpm test:t1`   | Format check of the changed files, lint of the changed code files, typecheck of the touched workspaces, the fast guards, and only the tests that import the changed files.                                                           |
| T2 lane  | `corepack pnpm test:t2`   | The same checks, then every test (unit, state, contract, integration, adversarial, golden) of each touched workspace, and lint of those workspaces.                                                                                  |
| T3 gate  | `corepack pnpm test:gate` | One integrated pack for money, safety and data integrity (list in `tests/gate.json`, 397 test files), 17 key browser specs, the client-bundle secret scan, `trace:verify`, and format, lint, typecheck and guards of the whole repo. |
| T4 full  | `corepack pnpm test`      | Every test in the repo. This is the background safety net; nobody waits on it for a small change.                                                                                                                                    |

"Changed files" are `git diff --name-only origin/main...HEAD` plus uncommitted and untracked files. Add `--plan` to any tier to see what it
would run without running it, for example `corepack pnpm test:t1 --plan`. Add `--json` for the full file lists.

## When to run which

- Docs, comments, copy: T1. It runs the format check and the guards only.
- One workspace changed (`domain/x`, `packages/x`, `apps/web`, `scripts`): T1 while you work, T2 before you push.
- A database migration changed: T1 already runs the `packages/db` migration and schema tests; T2 runs all `packages/db` tests. Any migration
  also prints "run the gate".
- `render.yaml` or `infra/**` changed: T1 and T2 add the two hosting guards (`check:hosting`, `check:hosting-gcp`).
- A recorded fixture (`fixtures/**`) changed: T1 and T2 add the `packages/paypal` and `packages/testkit` tests.
- A workspace `package.json` or `tsconfig.json` changed: its typecheck runs even though no code changed.
- A change in `packages/safety`, `transport`, `config`, `security`, `paypal`, `db`, `jobs` or in `domain/payments`, `approval`, `ledger`,
  `entitlements`, `trace` or `receipts`: the plan prints "run the gate", and T2 adds one more step (`vitest:dependents`) that runs every test importing the
  changed files, `apps/web` and the `tests/mvp-*` suites included.
- A root file changed (`package.json`, lockfile, `eslint.config.mjs`, `vitest.config.ts`, `tsconfig.base.json`): the plan says so; run T3.
- Before any deploy, and before a reviewer merges a change that touches money, safety, approvals, the ledger, entitlements, refunds,
  payouts or the database: T3.
- T4 runs on a schedule or in CI, never as a step in the middle of a small change.

A browser spec change (`apps/web/e2e/`) is not run by T1 or T2. Run `corepack pnpm --filter @umsbx/web test:e2e <file>.spec.ts` after
`corepack pnpm --filter @umsbx/web build`, or run T3.

## Go or no-go

- Any red in T1, T2 or the gate (T3) means no deploy. Fix it or revert; do not argue with it.
- Any red in a safety, money, transport, config or security test means no deploy, whatever the tier it showed up in, and whether or not
  that test is in the gate pack. That includes a red only the full run (T4) found.
- A T4 failure in any other test is fixed in a follow-up change, with the failing test named in the PR. If it shows the gate pack
  missed something important, add that test to `tests/gate.json` in the same follow-up.
- Real-Postgres suites (`packages/db` locks and sessions, `tests/mvp-c-pg`, and others) skip when `UMS_TEST_PG_BIN` is not set, and a
  skipped suite counts as green. On a local machine without Postgres binaries a green T2 or T3 therefore says nothing about them. The
  `postgres` job in CI covers them, and the gate in CI runs them too: each `gate-tests` shard sets `UMS_TEST_PG_BIN` and fails if
  `initdb` is missing. Before a deploy, look for a green `postgres` job or a green CI gate.
- The gate adds no new proof of PayPal compatibility. The offline suites prove the modelled cases only. Nothing here connects to PayPal.

## What the gate holds

`tests/gate.json` is the list, as globs: 397 test files, about half of the 794 in the repo. It covers:

- Safety layer: `packages/safety`, `transport`, `config`, `security`, `paypal` (all of it), `jobs`, the scripts `safety-*`,
  `check-no-live-host`, `trace-verify`, `backup*` and `restore*` tests, and `domain/trace`.
- Money and data: `packages/db` (migrations and schema), `domain/payments`, `approval`, `ledger`, `entitlements`, `receipts`, every
  refund and payout test, the catalogue corridor, create, import, fee and payee tests, `domain/offer-entry`, `discovery`, `mandates`.
- Web: the purchase, approval, payment, composite and onboarding (`pob-journey`) state tests.
- Integrated suites: `tests/int`, `tests/mvp-a`, `tests/mvp-b`, `tests/mvp-c`, `tests/mvp-c-pg`, `tests/mvp-d`.
- Browser specs: buyer purchase, publisher offers, operator controls and switches, refund and sign-in. There is no browser spec for
  publisher import; that journey is covered by the catalogue import state tests and `pob-journey`.

`scripts/test-tier.test.ts` fails if a glob matches no file, a spec is gone, or the safety layer above drops out of the pack, so the list
cannot rot quietly. To change the gate, edit the file and run `corepack pnpm vitest run scripts/test-tier.test.ts`.

## Expected wall times

These are estimates from file and test counts, not timings. The first owner run of each tier replaces them: write the measured time here.

| Tier | Expected                                                                                                                                                                               |
| ---- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| T1   | Seconds to a few minutes. It scales with the changed files. Measured: a docs-only change took 28 seconds on a loaded machine.                                                          |
| T2   | A few minutes for a small workspace, 15 to 25 minutes for `apps/web` (about 190 test files) or `domain/payments` (about 75).                                                           |
| T3   | The pack is now about half of the test files and test cases (397 files), so on one 2-core machine it may take over an hour. In CI, four shards: about 20 minutes plus the browser job. |
| T4   | Several hours of machine time on one 2-core worker (CI splits it into six shards of 25 to 30 minutes each).                                                                            |

The 60 minute goal is for the CI gate (four shards, run in parallel). Locally, run the shards in parallel terminals
(`node scripts/test-tier.mjs --tier gate --group tests --shard 1/4`, and so on) or use CI. If a measured CI gate goes over 60 minutes, add
shards (the count is in `ci.yml` and `tests/gate.json`) before removing any safety, money, transport, config or security test.

## CI

`.github/workflows/ci.yml`, manual run (`workflow_dispatch`), input `tier`:

- `gate` (default): the four `gate-tests` shards (real Postgres on), `gate-e2e` (build with canary values, `check:bundle`, key browser specs, `trace:verify`), and the jobs that always run
  (`lint-type`, `checks`, `postgres`, `gitleaks`).
- `full`: today's six `tests` shards, plus `mutation` and `bundle`, plus the jobs that always run.

A pull request runs the `full` jobs as before. The same tiers run on a machine with `node scripts/test-tier.mjs --tier gate --group tests
--shard 2/4` (`--group` is `static`, `tests` or `e2e`).
