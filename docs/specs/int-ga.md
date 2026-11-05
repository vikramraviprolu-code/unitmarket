# INT-GA: plain-words search and "explain this problem order"

Task: Two GenAI features on the existing model port, built and tested on the scripted model.
Package: new `domain/assist` (`@umsbx/assist`), `packages/contracts` (two model purposes, assist word table), `packages/model` (scripted rules and prompts), `apps/web` (two routes, ask box, explain panel). Builder: Sonnet 5.5 high. Reviewer: Opus 5.5 gate.
Items: GA.1 to GA.5, 10 points, cut "should". Needs SR0, TR1, AL, OPS-A, OPS-B, BUY and SEL merged (the ask box sits in OPS-B's `FilterBar`, which BUY.4 and SEL.2 place on the buyer and seller pages; `buyer.ts` and `seller.ts` are BUY and SEL files). Decision V8 (scripted model now; the live model only on Vikram's yes). Source: search proposal section 7, features 1 and 2. Includes `int-wave2-conventions.md`. Round 2 passed 10/12 (`ga-scorecard.md`); build notes R2-1 to R2-5 and GA-L1 to GA-L7 (decision 5, live Claude, decision row D-100) below override the text above where they differ.

## Model boundary (V8, F9, F15)

- Superseded by GA-L1 to GA-L7 (decision 5): `claude.ts` now serves both purposes, with scripted fallback. Original text: `packages/model/src/claude.ts` is **unchanged**. Its `check()` returns null for any purpose other than `brief_parse` and `pack_compose`, so `txn_query` and `explain_order` are always served by the scripted model, even with `UMS_AI_ADAPTER=claude`. Turning them on for Claude is a later lane after V8 is yes. So GA makes no network call and no `model_spend` write.
- `ai_enabled` off: GA keeps working on rules plus the scripted model, and does not refuse. This differs from discovery, which refuses when `ai_enabled` is off; GA may, because neither path reaches a network or spends. The Claude adapter's own live switch is `paypal_outbound` (`composition.server.ts:1418`), not `ai_enabled`, and GA does not touch it.
- `domain/assist` imports only `@umsbx/contracts` (S1). It never imports `@umsbx/model` in production code.

## Goal

**GA.1, rule parser.** `parseRules(text, now, ctx)` in `domain/assist` turns plain words into a URL string map (`Record<string,string>`, the `TxnQuery` input shape) with no model call. `ctx` holds the principal kind and the seller-name list.

- Dates: today, yesterday, last week, this month, "since 1 Nov" (the most recent 1 Nov at or before `now`, UTC).
- Amounts: over $5, under 50p ("p" sets `currency=GBP`, "$" sets `USD`).
- Status words from `STATUS_GROUPS`; refund and case words.
- Seller names from `ctx.sellers`: for a buyer, the catalogue publishers; for a seller, itself only; for an operator, all.
- It returns `{chips, rest, dropped}`: `rest` is the words it could not place.

**Personal data never leaves (F6).** Before anything else, `parseRules` finds and removes these shapes from the text: emails, order refs (`ord_` ids and the display ref form), provider-id shapes (PayPal order, capture and refund id patterns), digit runs of 6 or more, and `buyer <Name>` / `seller <Name>` phrases. Each is placed as a local chip when the role allows it (operator: `buyer` for an email or buyer name, `q` for a ref or id; buyer and seller: `q` for an order ref) and otherwise added to `dropped`. It is never in `rest`.

**GA.2, model fallback.** `parseWithModel(rest, port)` sends **only `rest`**, after the scrub, through the `ModelPort` from contracts with purpose `txn_query`. Order of checks (F14):

1. The model answer must be a `Record<string,string>`; anything else is dropped whole.
2. Each key that OPS-B's `REFUSED_FIELDS` (the role table as data in `packages/contracts/src/txn-query.ts`) refuses for the caller's principal is removed and added to `dropped`.
3. `parseTxnQuery` parses the rest; invalid values are dropped.
4. `scopeQuery(principal, raw, parsed)` runs last; after step 2 it cannot throw `field_not_allowed`.

- The user sees the chips and the dropped list, and edits them before anything runs. GA never runs a query itself.

**GA.3, query eval.** 50 phrased queries in `domain/assist/evals/queries.json`, each with its expected chips, written in commit 1.

**GA.4, explain panel.** On an OPS-A order page whose `statusGroupOf` (SR0) is `attention`, `explainOrder(entries, alertKinds, fixIds, port)` sends purpose `explain_order` with this projection only (F7):

- From `operatorView(entries, {mfa: false})`, always the identity-free shape, even on an MFA session: per entry `seq`, `event_type`, `words_key`, `actor.kind`, `channel`, `state_from`, `state_to`.
- The AL alert kinds on the order.
- Nothing else: no `source.id`, actor id, provider tail, amount, `at`, order ref, buyer, seller, `req_id` or `ip_hash`.

It returns `{what_happened, safe_now, action_id}`.

- `action_id` (F4) is an AL catalogue key (an alert kind or a `BLOCKED_BY` value) whose entry has a `fix`. The composition derives `fixIds` from AL's catalogue and passes it in; GA edits no AL file. Anything outside `fixIds` becomes `none`.
- The panel's one button (F5) is a link to that catalogue entry's `fix.route#anchor`, passed through `lib/next-path.ts`. It never posts and never runs a write. `none` shows no button.
- `what_happened` and `safe_now` are capped at 400 characters each and rendered as plain text, never HTML.

**GA.5, explain eval.** 30 cases in `domain/assist/evals/problems.json`, written by hand in commit 1 (F3). Each case is a projected entry list plus alert kinds, with the expected `action_id` taken from AL's catalogue. Together they cover every AL alert kind and every `BLOCKED_BY` value at least twice. The safe action must be right on at least 27.

**Scripted answers are rules, not lookups (F2).**

- `packages/model/src/scripted-assist.ts` answers `txn_query` from a word-to-field table (`ASSIST_SYNONYMS` in `packages/contracts/src/assist-words.ts`, for words `parseRules` does not handle, such as "stuck", "money back", "by my agent"). It answers `explain_order` by rule: the first alert kind in catalogue severity order whose kind is in `fixIds`, with sentences built from the entries' `words_key`.
- The shared table lives in contracts, because `packages/model` cannot import `domain/assist`.
- A test asserts that no eval phrase, no eval order ref and no eval expected answer appears as a string in `scripted-assist.ts` or `assist-words.ts`.

**Prompts (F10).** `TXN_QUERY_SYSTEM` and `EXPLAIN_SYSTEM` are TS constants in `packages/model/src/prompts.ts`, with the data-not-instructions wording of `BRIEF_SYSTEM`. They exist for the later Claude lane; the scripted path does not read them. There is no `prompts/` folder.

**Where the port reaches GA (F8).** `apps/web/composition.server.ts` gains one exported function, `assistDeps()`, beside `chooseModel`. It returns `{model: ModelPort, fixIds: readonly string[]}` from the app's built model port and AL's catalogue. `src/composition/ops-money.ts`, `buyer.ts` and `seller.ts` call it. This is the one non-re-export line GA adds to `composition.server.ts`.

**Routes.**

- `POST /api/assist/query`: `auth: 'owner'` (any signed-in buyer, seller or operator), `csrf: true`, `idempotent: false`, rate 20 per minute per actor. It is idempotent-free because it changes no state, and a stored replay would keep chips derived from the user's text. One shared path is used because the parser is one function and scope comes from the session principal, not the path. An operator session without MFA gets 403 `mfa_required` from the wrapper on this POST (F11); the ask box shows "Sign in with your authenticator to use Ask" for that session.
- `GET /api/ops/orders/[ref]/explain`: `auth: 'operator'`, rate 10 per minute per actor. A GET is accepted here (F13) because it changes no state and spends nothing: the purpose is scripted until V8.
- Neither route logs the text, the chips or the model answer.

## Outputs (only these files)

New:

- `domain/assist/{package.json,tsconfig.json}` (`include` covers `src` and `evals`), `domain/assist/src/{index,parse-rules,scrub,parse-model,explain}.ts`
- `domain/assist/evals/{queries.json,problems.json,queries.eval.test.ts,problems.eval.test.ts}`
- `packages/model/src/scripted-assist.ts`, `packages/contracts/src/assist-words.ts`
- routes `apps/web/src/app/api/assist/query/route.ts`, `apps/web/src/app/api/ops/orders/[ref]/explain/route.ts`
- `apps/web/src/ui/{AskBox,ExplainPanel}.tsx`, `apps/web/src/lib/{ask-view,explain-view}.ts`
- the tests below

Changed:

- `packages/contracts/src/ports.ts` (`ModelPurposeSchema` adds `txn_query` and `explain_order`, additively), `packages/contracts/src/index.ts`
- `packages/model/src/scripted.ts` (dispatches the two purposes to `scripted-assist.ts`), `packages/model/src/prompts.ts` (two constants), `packages/model/src/index.ts`
- `eslint.config.mjs`: `'assist'` in `DOMAIN`, and a test-only model exception: `harnessExtra` allows `@umsbx/model` for `assist` (test files and `evals/` only); `prodExtra` keeps discovery as the only model importer (F1)
- `apps/web/package.json`, `pnpm-lock.yaml`
- `apps/web/src/ui/FilterBar.tsx` (hosts AskBox)
- `apps/web/src/app/ops/money/orders/[ref]/page.tsx` (panel)
- `apps/web/composition.server.ts` (re-export lines only, R2-4), new composition module `assist.ts`, composition modules `ops-money.ts`, `buyer.ts`, `seller.ts`

`packages/model/src/claude.ts`, `packages/model/src/schemas.ts` and `claude.adversarial.test.ts` change under GA-L1, GA-L2 and GA-L6; `composition.server.ts` gains the one `App` field of GA-L5.

## Acceptance tests (commit 1: tests and eval data only, run red)

| Item | Test file                                                                                            | Command                                                                                                                    | Expected                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| ---- | ---------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| GA.1 | `domain/assist/src/parse-rules.test.ts`                                                              | `corepack pnpm vitest run domain/assist/src/parse-rules.test.ts`                                                           | 30 rule-only phrases give the expected chips with an injected `now` and a port spy that is never called; "since 1 Nov" on 5 Nov and on 30 Oct resolve as stated; "50p" sets GBP                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| GA.2 | `domain/assist/src/parse-model.adversarial.test.ts`, `apps/web/src/assist-query.adversarial.test.ts` | `corepack pnpm vitest run domain/assist/src/parse-model.adversarial.test.ts apps/web/src/assist-query.adversarial.test.ts` | The port request holds only the scrubbed rest: `alice@example.com`, a seeded order ref, a PayPal capture id shape, `1234567`, "buyer Alice Smith" and the seed's canary names and amounts never appear in it. Model output that is not a string map is dropped. "Show buyer X's orders" from a buyer gives chips scoped to self with `buyer` in `dropped`, and `scopeQuery` is never reached with a refused key. A seller never gets `buyer` or `agent_key` chips. With `ai_enabled` off the scripted answer is used and nothing refuses. An operator without MFA gets 403. The 21st call in a minute gives 429. The text appears in no log line |
| GA.3 | `domain/assist/evals/queries.eval.test.ts`                                                           | `corepack pnpm vitest run domain/assist/evals/queries.eval.test.ts`                                                        | 50 queries, at least 45 exact on the scripted model; the run prints the misses. A no-overlap check passes: no eval phrase, ref or expected answer appears in `scripted-assist.ts` or `assist-words.ts`                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| GA.4 | `domain/assist/src/explain.state.test.ts`, `apps/web/src/ops-explain.adversarial.test.ts`            | `corepack pnpm vitest run domain/assist/src/explain.state.test.ts apps/web/src/ops-explain.adversarial.test.ts`            | A deep scan of the port request finds only the projection's seven entry fields and alert kinds, on an MFA session too; no `source.id`, actor id, provider tail, amount or ref. `action_id` is always in `fixIds` or `none`; an injected answer with a new id becomes `none`; injected HTML is shown as text; over-long text is cut at 400. The button is a link to `fix.route#anchor` and the panel source has no form or POST. The panel shows only when the status group is `attention`. Buyer and seller sessions are refused. The text is not logged                                                                                         |
| GA.5 | `domain/assist/evals/problems.eval.test.ts`                                                          | `corepack pnpm vitest run domain/assist/evals/problems.eval.test.ts`                                                       | 30 cases, every alert kind and `BLOCKED_BY` value covered at least twice, safe action right on at least 27, scripted                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| C5   | gate                                                                                                 | `corepack pnpm trace:verify` after the suites above                                                                        | Exit 0; INV-T2 empty                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |

No L item. The model boundary is covered by the adversarial files above. C4 to C7 apply, and the live model is never called in CI (V8). The spend caps and the `ai_enabled` switch are unchanged.

## Build notes (round 2, binding)

- R2-1: `fixIds` holds AL catalogue **alert kinds** with a `fix` only. `BLOCKED_BY` values are not an input to `explainOrder`, so they are not in `fixIds`. GA.5's 30 cases cover each fix kind at least once and each critical or high kind at least twice.
- R2-2: the no-overlap check compares whole eval phrases of 3 or more words and eval refs only, not single chip values such as "attention".
- R2-3: order refs and provider ids are placed in SR0's `ref` field, not `q` (`q` is the title match).
- R2-4: `assistDeps()` lives in `apps/web/src/composition/assist.ts`, not in `composition.server.ts` (UI0.7 allows only re-exports there). `composition.server.ts` gains re-export lines only: `createScriptedModel` from `@umsbx/model` and AL's catalogue. `assist.ts` uses the scripted port directly; this is the same behaviour as the app port, because `claude.ts` never serves these purposes. If a needed value cannot be reached by a re-export, stop and report.
- R2-5: `REFUSED_FIELDS` comes from OPS-B fix B1. If it is absent at build, stop and report.
- GA-L1 to GA-L7 (decision 5, 5 Nov, live Claude with the $2 per day cap) are in `consolidation.md` section 4 and are binding. In short: `check()` accepts `txn_query` as exactly `{rest}` (max 500 chars) and `explain_order` as a strict projection schema with `fix_ids`; answers are schema-checked and fall back to scripted; the two system prompts are used; caps and the `paypal_outbound` kill switch are unchanged; the port reaches GA as `App.model`, replacing R2-4's scripted re-export; tests use a fake wire only; decision row D-100.

## Do not

Send transaction data, names, emails, refs or ids to the model; let model output run a query without the user seeing the chips; import `@umsbx/model` in `domain/assist` production code; change `claude.ts` beyond GA-L1 to GA-L3; call the live model in any test or in CI; change the spend caps or the kill switch; render model text as HTML; add a dependency; edit AL's catalogue.

Branch: `feat/int-ga`. Commit: `feat(assist): plain-words search and explain panel (INT-GA)`.
