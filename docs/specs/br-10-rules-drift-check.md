# Spec: registry and reference stay in step (BR-10, UNI-80)

Task: a check fails when the rule registry and the business rules documents disagree.
Package: `scripts` (new `check-business-rules.mjs` and its test), root `package.json` (one script, added to `ci`),
`docs/business-rules/configurable-rules-design.md` (marker column only) Owner: builder (Sonnet) Reviewer: Opus (S)
Branch: `feat/rules-drift-check` Commit: `chore(scripts): business rules drift check (BR-10)` Depends on: BR-1.

Goal: nobody can add, remove or re-default a configurable rule without updating `docs/business-rules/`.

Design: the script loads `RULES_REGISTRY` from `packages/contracts/src/rules.ts` through `node --import ./scripts/lib/ts-register.mjs`,
as `check:openapi` does (contracts is not built; no new dependency). It reads the section 3 key table of
`docs/business-rules/configurable-rules-design.md`. The lane adds a "Slice" column to that table: `BR-1` on the three registry keys and
`later` on the other thirteen rows. This is the only document edit allowed. The script fails when a registry key is missing from the
table; when a `BR-1` row's default, safe range or merge strategy differs from the registry; or when a row the registry lacks is not
marked `later`. Output: one line per problem and exit 1; otherwise `business rules: N keys in step` and exit 0.
`pnpm check:business-rules` is appended to `pnpm run ci`.

Tests first: `scripts/check-business-rules.test.ts` with fixtures under `scripts/__fixtures__/business-rules/` (in step, missing key,
wrong default, wrong range, extra key, extra key marked later).

Acceptance: the test passes red then green; `corepack pnpm check:business-rules` prints `business rules: 3 keys in step` on the branch;
lint, format, `check:no-live-host`, `check:secrets-names` pass.
Do not: change the documents' wording beyond the marker column; add a dependency.
Evidence: red and green runs, the script output.
