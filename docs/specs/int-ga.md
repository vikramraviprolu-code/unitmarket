# INT-GA: plain-words search and "explain this problem order"

Task: Two GenAI features on the existing model port, built and tested on the scripted model.
Package: new `domain/assist` (`@umsbx/assist`), `packages/contracts` (two model purposes), `packages/model` (prompts and scripted answers), `apps/web` (two routes, ask box, explain panel). Builder: Sonnet 5.5 high. Reviewer: Opus 5.5 gate.
Items: GA.1 to GA.5, 10 points, cut "should". Needs SR0, TR1, AL, OPS-A and OPS-B merged. Decision V8 (scripted model now; the live model only on Vikram's yes). Source: search proposal section 7, features 1 and 2. Includes `int-wave2-conventions.md`.

## Goal

**GA.1, rule parser.** `parseRules(text, now)` in `domain/assist` turns plain words into a partial `TxnQuery` with no model call. It handles dates (today, last week, since 1 Nov), amounts (over $5, under 50p), status words (`STATUS_GROUPS`), refund and case words, and seller names from a list the caller passes in. It returns the words it could not place.

**GA.2, model fallback.** `parseWithModel(rest, port)` sends **only the unplaced words**, never transaction data, through the `ModelPort` from contracts with the new purpose `txn_query`.
- The answer is validated by SR0's `parseTxnQuery` and then by `scopeQuery` for the caller's principal. Refused fields are dropped, not sent.
- The user sees the chips and edits them before anything runs.
- `domain/assist` imports only `@umsbx/contracts` (S1). The real port is wired in composition, so only discovery keeps its model import.
- The scripted model answers when `ai_enabled` is off or the adapter is not `claude`. The existing $2 a day and $20 total caps apply unchanged.

**GA.3, query eval.** 50 phrased queries with expected chips, on the scripted model.

**GA.4, explain panel.** On an OPS-A order page in Needs attention, `explainOrder(entries, alerts, port)` sends only TR1's **identity-free** operator view (no buyer, provider id, `req_id` or `ip_hash`) and the AL alert kinds, with purpose `explain_order`. It returns `{what_happened, safe_now, action_id}`. `action_id` must be one of the AL catalogue `fix` ids, or `none`; anything else becomes `none`. The text is shown as plain text, never HTML.

**GA.5, explain eval.** 30 problem orders from the reconciler fixtures; the safe action must be right on at least 27.

**Routes.**
- `POST /api/assist/query` (`auth: 'owner'`: any signed-in buyer, seller or operator; CSRF; 20 per minute per actor) returns chips.
- `GET /api/ops/orders/[ref]/explain` (operator session, 10 per minute) returns the explanation.
- Neither route logs the text or the model answer.

## Outputs (only these files)

New:
- `domain/assist/{package.json,tsconfig.json}`, `domain/assist/src/{index,parse-rules,parse-model,explain}.ts`
- `domain/assist/evals/{queries.json,problems.json}`
- `packages/model/prompts/{txn-query,explain-order}.md`, scripted answers in `packages/model/test-data/{txn-query,explain-order}.json`
- routes `apps/web/src/app/api/assist/query/route.ts`, `apps/web/src/app/api/ops/orders/[ref]/explain/route.ts`
- `apps/web/src/ui/{AskBox,ExplainPanel}.tsx`
- the tests below

Changed:
- `packages/contracts/src/ports.ts` (`ModelPurposeSchema` adds `txn_query` and `explain_order`, additively)
- `packages/model/src/` (scripted model reads the two new answer files; caps unchanged)
- `eslint.config.mjs` (`'assist'` in `DOMAIN`)
- `apps/web/package.json`, `pnpm-lock.yaml`
- `apps/web/src/ui/FilterBar.tsx` (hosts AskBox)
- `apps/web/src/app/ops/money/orders/[ref]/page.tsx` (panel)
- composition modules `ops-money.ts`, `buyer.ts`, `seller.ts`

## Acceptance tests (commit 1: tests only, run red)

| Item | Test file | Command | Expected |
|---|---|---|---|
| GA.1 | `domain/assist/src/parse-rules.test.ts` | `corepack pnpm vitest run domain/assist/src/parse-rules.test.ts` | 30 rule-only phrases give the expected chips with an injected `now` and a port spy that is never called |
| GA.2 | `domain/assist/src/parse-model.adversarial.test.ts`, `apps/web/src/assist-query.adversarial.test.ts` | `corepack pnpm vitest run domain/assist/src/parse-model.adversarial.test.ts apps/web/src/assist-query.adversarial.test.ts` | The port request holds only the unplaced words (canary order refs, amounts and names in the seed never appear). Model output outside the schema is dropped. "Show buyer X's orders" from a buyer gives chips scoped to self, with `buyer` dropped. A seller never gets `buyer` or `agent_key` chips. With `ai_enabled` off, the scripted answer is used. The 21st call in a minute gives 429. The text appears in no log line |
| GA.3 | `domain/assist/evals/queries.eval.test.ts` | `corepack pnpm vitest run domain/assist/evals/queries.eval.test.ts` | 50 queries, at least 45 exact on the scripted model; the run prints the misses |
| GA.4 | `domain/assist/src/explain.state.test.ts`, `apps/web/src/ops-explain.adversarial.test.ts` | `corepack pnpm vitest run domain/assist/src/explain.state.test.ts apps/web/src/ops-explain.adversarial.test.ts` | The prompt holds only identity-free timeline fields and alert kinds (deep scan). `action_id` is always in the catalogue list or `none`; an injected answer with a new id or HTML becomes `none` or plain text. Buyer and seller sessions are refused. The text is not logged |
| GA.5 | `domain/assist/evals/problems.eval.test.ts` | `corepack pnpm vitest run domain/assist/evals/problems.eval.test.ts` | 30 problem orders, safe action right on at least 27, scripted |

No L item. The model boundary is still covered by the adversarial files above. C4 to C7 apply, and the live model is never called in CI (V8). The spend caps and `ai_enabled` switch are unchanged.

## Do not

Send transaction data, names or ids to the model; let model output run a query without the user seeing the chips; import `@umsbx/model` from `domain/assist`; render model text as HTML; add a dependency.

Branch: `feat/int-ga`. Commit: `feat(assist): plain-words search and explain panel (INT-GA)`.
