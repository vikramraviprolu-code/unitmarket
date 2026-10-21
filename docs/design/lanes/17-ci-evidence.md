# Lane 17: CI and evidence

Task: the CI pipeline beyond lane 00's basics, mutation checks, coverage gates, the bundle secret scan, and the evidence and gate-report templates.
Package: `scripts/`, `.github/workflows/`, `docs/evidence/` Owner: Sonnet worker W-17 Reviewer: Opus 5.5
Wave: 1 (after lane 00). Size: 5 h. Owner of the gate report format.

## Goal
Every merge has the same machine-checked evidence, runnable locally while CI is manual, and every MVP gate produces a report in the nfr.md SOP 22 format. Money modules cannot merge below their coverage and mutation thresholds.

## Inputs
- nfr.md sections 1.3, 2.8 (MAINT-3, MAINT-4, MAINT-6), 2.11 (SUP-1 to SUP-6), 2.12; architecture 11.
- Copy and adapt (`/home/user/AIC_Hackathon_UnitMarket` at `a36ddc03fd0b962000f686291c145b50ee337f90`): `scripts/mutation-checks.mjs` (operator mutation and re-run; adapt targets), `scripts/test-module.mjs`.
- Dependencies: `@vitest/coverage-v8` is NOT on the D-4 list: use Vitest's built-in reporter only if it needs no new package; otherwise write the coverage gate as a TODO and raise it as a dependency request (do not install).

## Outputs
- `scripts/mutation-checks.mjs` (targets: `domain/payments/src/match.ts`, `reconcile.ts`, `domain/access-clock/src/compute.ts`, `domain/entitlements/src/table.ts`, `domain/ledger/src/ledger.ts`, `packages/paypal/src/map-*.ts`, `packages/paypal/src/money.ts`; mutations: relational operator flip, boolean negation, constant change, removed condition; score >= 80 percent or exit 1).
- `scripts/check-bundle-secrets.mjs` (after `next build` with canary env values, scans `.next/` client and server chunks for each canary and for `NEXT_PUBLIC_` names other than `NEXT_PUBLIC_UMS_ENV_LABEL`; A-25).
- `scripts/check-fixtures.mjs` (fixture labels, redaction canaries, index up to date; MAINT-5).
- `scripts/evidence.mjs` (runs the `ci` script set, writes `docs/evidence/<lane>-<date>.md` with commands, exit codes, test counts, and sanitised ids only).
- `.github/workflows/ci.yml` extended: jobs `lint-type`, `tests`, `checks` (isolation, no-live-host, secrets-names, provenance, routes, fixtures), `mutation` (manual input), `bundle` (manual); `permissions: contents: read`; no secrets; `pnpm install --frozen-lockfile`.
- `docs/evidence/TEMPLATE-gate-report.md` (sections: findings by severity with issue, risk, impact, fix, files; verdict one of APPROVED FOR SANDBOX DEMO, APPROVED WITH CONDITIONS, NOT APPROVED; control ids ticked from nfr.md 1.3).
- `docs/evidence/TEMPLATE-pr.md` (spec link, evidence block, sanitised ids, reviewer checklist).

## Interfaces
Root scripts added: `mutation` (runs `scripts/mutation-checks.mjs`), `check:bundle`, `check:fixtures`, `evidence`. Exit code 0 means pass; any other code fails the gate.

## Acceptance tests
- `mutation_detects`: on a temp copy, removing the `payee` comparison from a fixture function is detected (script exits 1 when the test suite does not catch a mutant).
- `bundle_canary`: a fixture `.next` directory containing a canary string makes `check:bundle` exit 1; a clean one exits 0.
- `fixtures_check`: a fixture missing `meta.source` or containing an email fails.
- `evidence_writes`: `corepack pnpm evidence --lane 17` writes a report with no environment values and no ids longer than 6 characters unsanitised.
- `ci_yaml_safe`: workflow has `permissions: contents: read`, no `secrets.` reference, frozen lockfile.

## Security and NFR gates
SOP 20, 22, 23; MAINT-4, MAINT-5, MAINT-6; SUP-1, SUP-2 (`pnpm audit --prod` step), SUP-6; A-25.

## Do not
Install a dependency outside D-4; add a secret or deployment step to CI; push anywhere; edit feature packages.

Branch `feat/ci-evidence` Commit `feat(ci): mutation, bundle, fixture checks and evidence reports (SBX-A-17)`.
