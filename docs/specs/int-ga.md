# INT-GA: plain-words search and "explain this problem order"

Task: Two GenAI features on the existing model package, built and tested on the scripted model.
Package: new `domain/assist` (`@umsbx/assist`), `packages/model` (prompts only), `apps/web` (filter bar input, explain panel). Builder: Sonnet 5.5 high. Reviewer: Opus 5.5 gate.
Items: GA.1 to GA.5, 10 points, cut "should". Needs SR0, TR1, OPS-A, OPS-B. Decision V8 for the live model. Source: search proposal section 7, features 1 and 2 (G1a, G1b, G1c, G2b, G2c).

## Goal

Typing "refunds over $5 from Harbour last week" in the filter bar returns chips the user can edit before anything runs: a rule parser places dates, amounts, status words and seller names; the model sees only the words the parser could not place and returns a `TxnQuery` validated by the same schema; the scripted model answers when `ai_enabled` is off or the adapter is not `claude`. On an order in Needs attention, an Explain panel reads the operator's redacted TR1 timeline and returns what happened, what is safe to do, and one button id from a fixed list. Evals run on the scripted model in CI and on the live model only when V8 is yes.

## Outputs

`domain/assist/src/{parse-rules,parse-model,explain}.ts`, prompt files under `packages/model/prompts/`, eval fixtures `domain/assist/evals/{queries.json,problems.json}`, components `apps/web/src/components/{AskBox,ExplainPanel}.tsx`.

## Acceptance tests (commit 1: tests only, run red)

| Item | Test file | Command | Expected |
|---|---|---|---|
| GA.1 | `domain/assist/src/parse-rules.test.ts` | `pnpm test -- assist/parse-rules` | 30 rule-only phrases give the expected chips with no model call |
| GA.2 | `domain/assist/src/parse-model.adversarial.test.ts` | `pnpm test:adversarial -- assist/parse-model` | Model output outside the schema is dropped; a prompt asking for another buyer's data yields buyer-scoped chips only; no transaction data in the prompt |
| GA.3 | `domain/assist/evals/queries.eval.test.ts` | `pnpm test -- assist/queries.eval` | 50 queries, at least 45 exact on the scripted model |
| GA.4 | `domain/assist/src/explain.state.test.ts` | `pnpm test:state -- assist/explain` | Prompt holds only redacted timeline fields; button id always in the allowed list |
| GA.5 | `domain/assist/evals/problems.eval.test.ts` | `pnpm test -- assist/problems.eval` | 30 problem orders, safe action correct on at least 27 |

Spend: the existing $2 a day and $20 total caps and `ai_enabled` switch apply unchanged.

Branch: `feat/int-ga`. Commit: `feat(assist): plain-words search and explain panel (INT-GA)`.
