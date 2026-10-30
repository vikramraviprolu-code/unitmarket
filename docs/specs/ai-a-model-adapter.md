# Spec: Claude model adapter behind the model port, with spend caps (AI-A)

Task: a Claude adapter for `ModelPort` (purposes `brief_parse` and `pack_compose` only), reached through one new egress path
in `packages/transport`, with hard spend caps, a scripted fallback, the AI-1 injection set run against it on recorded fake
answers. Off by default; no key is needed for any test. The evals page is lane AI-B (`ai-b-evals-page.md`).
Package: `packages/model`, `packages/transport` (one new file), `packages/contracts` (one port), `apps/web` Owner: builder
(Sonnet) Reviewer: Opus, egress and spend review
Branch: `feat/model-ai-a-claude` Commit: `feat(<package>): <what> (AI-A)` Decisions: D-065 items 13 to 19; D-066 (ships off);
D-008 (no new dependency). Depends on: CFG-0 (`ai_adapter`, `ai_api_key`). PREREQUISITE before merge: the coordinator
records a decision row amending architecture section 1 ("No Claude API") and zone Z4 for this one host (plan section 5).
Common rules: plan section 2.

Goal: with `UMS_AI_ADAPTER=claude` and a key, discovery uses the model for the two purposes; on any error, refusal, cap or
switch-off the scripted model answers instead and the buyer sees no difference in safety. With the default config nothing
changes and no socket is opened.

Egress, new `packages/transport/src/model-https.ts` (exported from the package root as `createModelHttps`):

- One host constant `MODEL_API = 'https://api.anthropic.com'`, not configurable; one path `/v1/messages`; POST only; no
  redirects followed; request body cap 64 KB; response cap 256 KB; 20 s deadline; headers `x-api-key` (from a `Secret`,
  never logged), `anthropic-version: 2026-10-21`, `content-type: application/json`. Any other host, path or method refused
  before a socket opens. Takes an injected request function in tests (same pattern as `makeHttpsWire` deps). It does not
  import `wire-https.ts`, `sandbox.ts` or the approval minter, and it is not usable for PayPal operations.
- Contracts, `packages/contracts/src/ports.ts`: `ModelWire { send(body: string): Promise<{ status: number; body: string }> }`
  and `ModelSpendStore { spentMicroUsd(since_iso: string | null): Promise<number>; charge(micro_usd: number, note: string):
Promise<void> }`. These are the only contract changes.

Adapter, new `packages/model/src/claude.ts` and `caps.ts`: `createClaudeModel({ wire, spend, clock, fallback })`.
Model `claude-haiku-5-5` (decision 16); body: `max_tokens` 800, `thinking: { type: 'disabled' }`, `output_config: { effort:
'low' }`, no `temperature`; the existing `BRIEF_SYSTEM` or `COMPOSE_SYSTEM` as `system`, the input as JSON text. Tools: none
are sent; the read-only tool list stays in our dispatcher. Prices as constants: USD 0.10 input and 0.50 output per million
tokens (claude-api reference cached 2026-10-06, prompts up to 100K tokens; the owner re-checks before switching on). Before
each call the worst-case cost (input estimated as `ceil(chars / 3)` tokens, capped at 8000 tokens, plus 800 output tokens)
is charged to the spend store; the call is refused, and the scripted fallback answers, when that charge would pass USD 2.00
since 00:00 UTC of the injected clock or USD 20.00 in total. Input over 8000 estimated tokens: fallback, no call. Output:
`stop_reason` other than `end_turn` (including `refusal`, `max_tokens`), non-200, timeout or text that does not parse
against `BriefParseOutputSchema` or `ComposeOutputSchema`: fallback. Output always passes `sanitiseModelOutput`.
Composition: the Claude adapter is used only when `config.ai_adapter === 'claude'` and a key is set; the spend store writes
`audit_log` rows (action `model.spend`, detail micro USD) and sums them (no migration). The `ai_enabled` switch keeps its
current meaning (discovery on or off; seeded on) and is not repurposed.

Tests first (all with a fake wire; no key, no socket): `packages/transport/src/model-https.test.ts` and
`model-https.adversarial.test.ts` (host, path, method, redirect, oversize, timeout, key absent from errors and logs);
`packages/model/src/claude.test.ts` (request body shape; parse; each fallback cause); `claude.caps.state.test.ts` (daily and
total caps with a fake clock across midnight; a refused charge sends nothing); `claude.adversarial.test.ts` (every case of
`test-data/injection-cases.json` against the adapter with recorded synthetic answers in new
`packages/model/test-data/claude-recorded.json`, labelled synthetic: a hostile answer never adds an id, a price or a payee);
`apps/web/src/model-choice.state.test.ts` (default config uses scripted and opens no
socket).

Lint: no S2 or S4 change is needed (the network code stays in `packages/transport`; the model gets an injected port and never
imports transport; composition may import transport). If a transport test pins the set of files that use `node:https`,
update it to add `model-https.ts`, name it, and flag it for review.
Acceptance: `corepack pnpm test:unit packages/transport packages/model`, `corepack pnpm test:state packages/model apps/web`,
`corepack pnpm test:adversarial packages/transport packages/model`, `corepack pnpm check:no-live-host`, plan section 3.
Do not: add the Anthropic SDK or any dependency; read a key from anywhere but config; run any real call; touch
`wire-https.ts`, `sandbox.ts`, `approval.ts`, `endpoints.ts`, `domain/discovery` logic or the `ai_enabled` switch; add tools.
Evidence: outputs, red run, the egress refusal table, cost line.
