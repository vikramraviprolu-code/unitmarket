# Spec: operator evals page (AI-B)

Task: a small `/ops/evals` page showing how many evaluation cases exist and the keyword baseline, honestly labelled.
Package: `apps/web` (page, engine method, copy) Owner: builder (Sonnet) Reviewer: Opus, one round
Branch: `feat/web-ai-b-evals` Commit: `feat(web): <what> (AI-B)` Decisions: D-065 item 18 (first AI item to cut), item 19.
Depends on: AI-A merged. Common rules: `docs/specs/overnight-plan.md` section 2. Size: about 45 minutes.

Goal: an operator, and a judge watching the video, sees the evidence of effort on the AI half: the number of cases, how the
deterministic keyword model does on them, and whether the Claude adapter has been run, without any figure that was not
measured.

Behaviour:

- Engine method `evalsSummary(actor)` (operator only, else null), computed at request time from committed data:
  `listing_cases` and `brief_cases` (counts from `packages/model/test-data/injection-cases.json`), `baseline` (the scripted
  model run over the same cases with the existing adversarial checks reused as pure functions: count passed of total), and
  `claude` = `{ state: 'not_run' }` unless `packages/model/test-data/claude-eval-result.json` exists, in which case its
  stored counts, date and the label "Recorded on <date> by the owner" are shown. This lane does not create that file.
- The checks are pure functions moved, not copied, into `packages/model/src/eval-checks.ts` and exported from the package
  root, so the adversarial test and the page use one definition. The adversarial test then imports them (a refactor of the
  test's helpers, not a change of what it asserts; say so).
- Page `apps/web/src/app/ops/evals/page.tsx`: three lines and a short "What this shows" paragraph: the cases are synthetic
  injection attempts; a pass means the output added no unknown id and no price, payee or amount field; the baseline is a
  deterministic keyword model, not AI. Copy in `apps/web/src/lib/evals-copy.ts`. Link from `/ops`.
- The model in use is shown from config: "Model in use: scripted (keyword) model" or "Model in use: Claude Haiku 5.5, with
  the scripted model as fallback".

Tests first: `apps/web/src/evals.state.test.ts` (counts equal the JSON; baseline equals running the checks; `not_run`
without the result file; buyer and publisher get null); `apps/web/src/evals-copy.golden.test.ts`;
`packages/model/src/eval-checks.test.ts`.

Acceptance: `corepack pnpm test:state apps/web`, `corepack pnpm test:adversarial packages/model` (unchanged count of
cases, all pass), `corepack pnpm test:golden apps/web`, plan section 3.
Do not: call any model over the network; write the Claude result file; add a dependency; edit `globals.css`; show a
percentage that looks like a probability (show "n of m").
Evidence: outputs, red run, screenshot if a browser runs, cost line.
