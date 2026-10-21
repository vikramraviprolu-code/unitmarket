# Lane 00: scaffold (repository tooling, isolation, guards, CI, docs)

Task: make `/home/user/unitmarket-sandbox` a self-contained SBX repository whose tooling enforces architecture sections 2, 6 and 7 before any feature code exists.
Package: repository root, `scripts/`, every package's `package.json`, `tsconfig.json` and placeholder `src/index.ts` Owner: Sonnet worker W-00 (already started) Reviewer: Opus 5.5
Wave: 0. Size: 6 h.

## Goal
A clean clone installs, lints, typechecks and tests green with no network beyond the package registry. The layout matches architecture v1.0 (`apps/web`; `domain/{access-clock, approval, catalogue, delivery, discovery, entitlements, fit, ledger, library, offer-entry, payments, receipts, recovery}`; `packages/{config, contracts, db, jobs, model, obs, paypal, runtime, safety, security, testkit, transport}`; `tools/spike-kit`; `scripts/`; `tests/` (cross-package acceptance tests, lane 18); `fixtures/paypal/{docs-examples, synthetic, sandbox-recordings}`; `docs/`). `vitest.config.ts` roots include `tests/**`. Lint rules S1 to S7 are live, so later lanes cannot cross a boundary by accident. The repo has its own git history, no remote, and nothing from the simulation except copied, attributed files.

## Inputs
- `docs/design/architecture.md`, `mvp-plan.md`, `nfr.md` (copy the three BASELINE v1.0 files from the design scratchpad into `docs/design/`).
- Copy and adapt from `/home/user/AIC_Hackathon_UnitMarket` at `a36ddc03fd0b962000f686291c145b50ee337f90`: `eslint.config.mjs` (the `NO_REAL_TIME` block, lines 117 to 140, and the restricted-imports pattern), `vitest.config.ts` (project split by file suffix), `lefthook.yml` (gitleaks on staged files), `.nvmrc`, `.prettierrc*`, `CLAUDE.md` (spec protocol and credentials rule, rewritten for SBX), `scripts/test-module.mjs`, `scripts/mutation-checks.mjs` (copy now as `scripts/mutation-checks.mjs`, adapted to SBX paths; used from lane 17).
- Runtime: Node 22.22.0, pnpm 10.34.7. Dependencies only from the approved list D-4.

## Outputs
- Root: `package.json` (scripts below), `pnpm-workspace.yaml` (`apps/*`, `domain/*`, `packages/*`, `tools/*`), `pnpm-lock.yaml`, `tsconfig.base.json` (strict, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`), `eslint.config.mjs`, `vitest.config.ts`, `lefthook.yml`, `.gitleaks.toml`, `.gitignore` (`.env*` except `.env.example`, `.next`, `data/`, `spike-out/`), `.env.example` (names only, architecture 6), `.nvmrc`, `CLAUDE.md`, `README.md`.
- One workspace package per module above, scope `@umsbx/<name>`, each with `package.json` declaring only allowed workspace deps, `tsconfig.json`, `src/index.ts`, one smoke test.
- `scripts/check-isolation.mjs`, `scripts/check-no-live-host.mjs`, `scripts/check-secrets-names.mjs`, `scripts/check-provenance.mjs`, `scripts/route-inventory.mjs` (stub that lane 11 fills).
- `.github/workflows/ci.yml` (`workflow_dispatch` and `pull_request`; runs `pnpm ci`; no secrets referenced).
- `docs/`: `design/` (three baseline files), `specs/` (lane files copied from `lanes/`), `decision-log.md` (rows D-1 to D-9 with date 21 Oct 2026), `PROVENANCE.md` (table: SBX path, origin path, origin sha), `threat-model.md` (seed from nfr.md section 3), `READINESS.md` (one row per lane).
- `fixtures/paypal/README.md` (labels `docs-example`, `synthetic`, `sandbox-recording`; only the last is PayPal evidence).

## Interfaces
Root scripts, exact names: `lint`, `typecheck`, `test`, `test:unit`, `test:state`, `test:contract`, `test:integration`, `test:adversarial`, `test:golden`, `test:e2e` (Playwright, offline; placeholder until lane 15), `mutation`, `check:isolation`, `check:no-live-host`, `check:secrets-names`, `check:provenance`, `check:routes`, `format`, `format:check`, `ci` (all of the above except `test:e2e` and `mutation`). Lint rules (each a named block in `eslint.config.mjs`):
- S1 `domain/*` may import only `@umsbx/contracts` and other `domain/*` packages through their package name (no deep paths).
- S2 `fetch`, `node:http`, `node:https`, `node:net`, `node:tls`, `node:dns`, `undici` barred everywhere except `packages/transport/src/sandbox*.ts` and `tools/spike-kit`. Only `packages/paypal` may import `@umsbx/transport`; only `apps/web/src/server/composition.ts`, `packages/jobs` and `packages/testkit` may import `@umsbx/paypal`.
- S3 `process.env` barred except in `packages/config` and `tools/spike-kit` and `scripts/`.
- S4 `domain/discovery`, `domain/fit`, `packages/model` may not import `domain/payments`, `domain/approval`, `domain/entitlements`, `packages/paypal`, `packages/safety`, `packages/transport`.
- S5 files under `apps/web/src/app/**` marked `'use client'` may import only `@umsbx/contracts` (types) and `apps/web/src/ui/**`; server modules in `apps/web/src/server/**` start with `import 'server-only'`.
- S6 `NO_REAL_TIME` (no `Date.now()`, argument-less `new Date()`, `Math.random()`, `crypto.randomUUID()`, `performance.now()`) everywhere except `packages/runtime/src/system*.ts`, `scripts/`, `tools/`.
- S7 is `check:no-live-host`: fails if `api-m.paypal.com`, `api.paypal.com` or `www.paypal.com` appear in any tracked file outside `docs/` (tests must build the string at runtime).
- Isolation: `check:isolation` resolves every import specifier with the TypeScript resolver and fails on `@unitmarket/`, `@unitmarket-sim/`, `simulation/`, `AIC_Hackathon_UnitMarket`, or any resolved file outside the repo root.
- `check:secrets-names` fails on any `NEXT_PUBLIC_` name other than `NEXT_PUBLIC_UMS_ENV_LABEL`, and on any value assigned in `.env.example`.
- `check:provenance` fails when a file with an `// Origin:` header is missing from `docs/PROVENANCE.md` or the reverse.

## Acceptance tests
- `scaffold_green`: `corepack pnpm install --frozen-lockfile && corepack pnpm ci` exits 0 on a clean clone.
- `lint_s2_bites`: a fixture file under `scripts/__fixtures__/` calling `fetch` from `domain/payments` is reported by ESLint (test runs ESLint programmatically on the fixture).
- `lint_s3_bites`, `lint_s4_bites`, `lint_s6_bites`: same pattern, one fixture each.
- `no_live_host_bites`: the check fails on a temp file containing a live hostname, passes after removal (A-26).
- `isolation_bites`: the check fails on a temp file importing `@unitmarket/contracts` (A-27, MAINT-1).
- `secrets_names_bites`: fails on `NEXT_PUBLIC_PAYPAL_CLIENT_ID` in a temp file.
- `gitleaks_clean`: `gitleaks detect --no-git=false` on the history exits 0 (SUP-6) (run by the reviewer if gitleaks is installed; otherwise lefthook config review).
- `git_has_no_remote`: `git remote -v` prints nothing (D-1).

## Security and NFR gates
SOP 1, 2, 12, 20; MAINT-1, MAINT-2; SUP-1, SUP-4, SUP-6; RLR-4 (config refusal is lane 02, but `.env.example` names are fixed here).

## Do not
Add a dependency outside D-4; add a git remote or push; copy any simulation file without the provenance header; write feature code; put any value in `.env.example`; reference PayPal credentials in CI.

Branch `feat/repo-scaffold` Commit `feat(repo): scaffold, isolation lint and guards (SBX-A-00)`.
