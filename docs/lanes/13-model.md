# Lane 13: agent model port with the scripted deterministic model

Task: `ScriptedModel`, a deterministic implementation of `ModelPort` for brief parsing and pack composition, plus the tool dispatcher that only knows three read-only tools.
Package: `packages/model` Owner: Sonnet worker W-13 Reviewer: Opus 5.5
Wave: 1 (needs lane 01 F1 `ModelPort`, `ModelRequest`, `ModelResponse`). Size: 4 h.

## Goal
The agent-led path works with no model API and no spend (Claude is not approved). Same input, same output. The model never sees secrets, payer data or buyer identity, can name only offers it was given, and cannot cause any write or call.

## Inputs
- Architecture 9.10; nfr.md AI-1 to AI-5, PRIV-2.
- Copy and adapt (`/home/user/AIC_Hackathon_UnitMarket` at `a36ddc03fd0b962000f686291c145b50ee337f90`): `simulation/consumers/src/parse.ts` (regex brief parser: budget, currency, keep or view, language), `simulation/consumers/src/model.ts` (scripted `ModelPort` shape), `packages/core/agent/prompts.ts` (`COMPOSE_SYSTEM` text), `packages/core/agent/injection.adversarial.test.ts` (injection cases as data).

## Outputs
`packages/model/src/{scripted.ts, parse-brief.ts, compose.ts, tools.ts, prompts.ts, schemas.ts, index.ts}`, tests, `packages/model/test-data/injection-cases.json` (at least 30 listing injections and 20 brief jailbreaks).

## Interfaces
```ts
export const BRIEF_SYSTEM: string; export const COMPOSE_SYSTEM: string;   // no secrets, no ids, no buyer data
export const AGENT_TOOLS: readonly ['search_catalogue', 'get_article_summary', 'propose_pack'];
export interface BriefParseOutput { need: string; ceiling_minor: number | null; currency: string | null; option: 'keep_retrieve' | 'online_read' | null; language: string | null; terms: string[] }
export interface ComposeInput { need: string; terms: string[]; ceiling_minor: number | null; candidates: { offer_id: string; title: string; abstract: string; topics: string[] }[] }  // listing text is data
export interface ComposeOutput { picks: { offer_id: string; reason: string }[] /* <= 5 */; tool_calls: { tool: string; args: Record<string, unknown> }[] }
export const BriefParseOutputSchema: ZodType<BriefParseOutput>; export const ComposeOutputSchema: ZodType<ComposeOutput>;
export function createScriptedModel(): ModelPort;     // model_id 'scripted-v1'; purpose brief_parse returns BriefParseOutput; pack_compose returns ComposeOutput ranked by term overlap then offer_id
export function dispatchTool(call: { tool: string; args: Record<string, unknown> }): { accepted: boolean; recorded: true }; // never executes; any name outside AGENT_TOOLS is refused (AI-3)
export function sanitiseModelOutput(raw: unknown, candidateIds: Set<string>): Result<ComposeOutput, 'unparseable' | 'unknown_offer'>; // zod parse, drop fields like price or payee, refuse ids not in candidates (AI-5)
```
Input caps: brief text at most 2,000 characters (AI-4); refused above with `too_long`. Currency words map to ISO codes; "view" or "read online" map to `online_read`; "download" or "keep" to `keep_retrieve`.

## Acceptance tests
- `corepack pnpm vitest run --project unit packages/model`: `same input same output` (100 runs); `parses "need X, under $6, download, English"`; `brief over 2000 chars refused`; `compose returns at most 5 picks from candidates only`; `tool outside allow-list refused, recorded, not executed` (AI-3); `output with price or payee fields is stripped and ids re-checked` (AI-5).
- `--project adversarial packages/model`: `30 injected listings: zero picks outside candidates, zero price or payee in output, zero accepted tool calls outside the list` (AI-1); `20 jailbreak briefs: output passes the schema or is refused` (AI-2); `prompts contain no secret-like strings and no buyer fields` (PRIV-2).

## Security and NFR gates
AI-1 to AI-5, PRIV-2, S4 isolation.

## Do not
Call any network or model API; import payments, approval, entitlements, paypal, safety or transport; add a dependency; put real article text from paywalled sources in test data.

Branch `feat/model-scripted` Commit `feat(model): scripted model and read-only tool dispatcher (SBX-A-13)`.
