# Lane 18: MVP-A integration and gate report

Task: run the MVP-A acceptance list A-01 to A-27 end to end, fix nothing outside your test files (raise defects to the owning lane), and produce the gate report.
Package: `tests/mvp-a/` (the top-level test folder created by lane 00 and included in the Vitest roots) and `docs/evidence/` Owner: Sonnet worker W-18 Reviewer: Opus 5.5 (full gate review)
Wave: 4 (after every other lane). Size: 6 h plus defect loops.

## Goal
Prove, from the requirements, that the offline walking skeleton is safe and complete: no unlock without a verified read-back, no socket opened, no live path, buyer isolation, five-day windows, honest labels. The gate passes only with zero open critical or high findings.

## Inputs
- `mvp-plan.md` MVP-A acceptance table (A-01 to A-27) and gate list; nfr.md 1.3 (MVP-A checklist), section 4 map; lane 17 templates.
- All packages through their public entry points and the web app through Playwright.

## Outputs
`tests/mvp-a/*.integration.test.ts` and `*.adversarial.test.ts` (one file per acceptance id group), `docs/evidence/mvp-a-gate-<date>.md` (SOP 22 format, control ids ticked: SOP 1, 2, 3, 6, 7, 12, 20; P3, P4, P5, P12, P15, P16, AI-3; MAINT-1, MAINT-2, MAINT-5, PORT-1, RLR-4, REL-2 to REL-4), `docs/READINESS.md` updated per lane, `docs/PROVENANCE.md` checked.

## Interfaces
None exposed. Consumes only public package entry points and HTTP.

## Acceptance tests
- `corepack pnpm vitest run --project integration --project adversarial tests/mvp-a`: one named test per A-01 to A-27 with the expected result from `mvp-plan.md`, written before reading the implementation.
- `corepack pnpm ci && corepack pnpm mutation && corepack pnpm test:e2e && corepack pnpm check:bundle` all exit 0.
- `perf`: quote and approval API p95 under 300 ms over 200 offline requests (PERF-2 offline twin), recorded in the report.
- Gate report verdict is APPROVED FOR SANDBOX DEMO or APPROVED WITH CONDITIONS with no open critical or high finding.

## Security and NFR gates
Every MVP-A item of nfr.md 1.3; REL-2 to REL-4; MAINT-1 to MAINT-6.

## Do not
Patch production code (open a defect for the owning lane); weaken an assertion; connect to PayPal; add dependencies.

Branch `feat/mvp-a-gate` Commit `test(mvp-a): integration acceptance and gate report (SBX-A-18)`.
