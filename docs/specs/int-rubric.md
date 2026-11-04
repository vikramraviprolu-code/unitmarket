# INT rubric: spec and build scoring for the integrated plan

Used twice per lane, exactly as in MVP 1. **Spec review:** a fresh Opus 5.5 thread (high effort, not the designer, a different model from the Sonnet builder) scores the spec before any code. **Build review:** a separate Opus 5.5 thread (high effort, not the builder) runs the tests, reviews the diff, scores the branch and merges on a pass. Plan: `/mnt/project-files/integrated-design/integrated-plan.md`.

Score each criterion 0, 1 or 2. **Pass: at least 10 of 12 and no criterion at 0.** A fail returns numbered findings, each naming the criterion, the file or line, and the fix. Spec: at most 2 revise rounds, then stop and report. Build: at most 3 fix rounds, then stop and report.

| # | Criterion | 2 | 1 | 0 |
|---|---|---|---|---|
| 1 | Goal clarity | One paragraph says what is true when done; every item id of the lane (plan section 5) is named | Goal clear, one item implied | Goal vague or items missing |
| 2 | Testability (tests first) | Every item has a named test file and a command with the expected result; commit 1 holds only tests and fixtures and was run red (build: red output attached) | One item covered only by a shared test without a named case | An item without a test, or tests written after code |
| 3 | Safety | No PayPal call, credential, account, approval row or secret; `packages/transport/src/endpoints.ts` unchanged; the five locks untouched; nothing sets the connect flag or inserts `outbound_approvals`; no raw IP, email or name in the journal; `check:no-live-host`, `check:secrets-names` and the offline proof pass | Safety stated, one check not listed or not run | Any network path to PayPal, any secret, a lock weakened, or personal data in the journal |
| 4 | Scope | Touches only the files the spec lists; no dependency beyond D-008 and D-050; contract changes additive; migration takes the next free number at merge | One unlisted file with a stated reason | Unlisted package, new dependency, breaking contract change, or edits to another lane's files |
| 5 | Security and integrity depth | Every L item has adversarial tests (cross-tenant read, missing or wrong scope, missing MFA, replay, tamper, race as relevant) and a mutation target of at least 80 percent; from TR0 on, `pnpm trace:verify` passes and the unattributed-row invariant is zero after the seed and journeys | Adversarial present but one relevant attack missing, or mutation 70 to 79 percent | An L item without adversarial tests, mutation below 70 percent, `trace:verify` failing, or unattributed rows |
| 6 | Fit | Matches the plan's item list, sizes and cut marks, the folding table (plan section 4) and Vikram's decisions V1 to V9; persona rules hold (sellers never see buyer identity; labels come from stored data) | One deviation, explained | Contradicts a decision or rebuilds a shared block another lane owns |

Build review attaches: `corepack pnpm run ci` output (lint, typecheck, six suites, isolation, no-live-host, secrets-names, routes, openapi), the lane's mutation command and result, `pnpm trace:verify` output (TR0 onward), the diff stat, and for screen lanes one light and one dark screenshot per new page. Six suites green before merge (D-066).

If review time runs short: criteria 3 and 5 are never skipped. L-item adversarial and mutation, `trace:verify`, and the E2E proof come first. S and M screen items may share one table-driven test per group.
