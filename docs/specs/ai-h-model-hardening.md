# Spec: model output and discovery hardening (AI-H)

Task: four small hardening changes that follow the AI-A review (overnight assumption 26). No new dependency, no network.
Package: `packages/model`, `packages/contracts` (one optional field), `packages/security` (one optional route field),
`domain/discovery` (one line), `apps/web` (two route files, tests) Owner: builder (Sonnet) Reviewer: Opus
Branch: `feat/ai-h-hardening` Commit: `feat(<package>): <what> (AI-H)` Decisions: D-008 (no dependency), D-065, D-066.

Goal: model free text cannot carry a link, an address, a price or control characters into any later screen; each brief
records the model that really answered; one visitor cannot use up the discovery allowance of every judge; the spend
ledger never holds reader text.

1. Reason scrub. `sanitiseModelOutput` (`packages/model/src/tools.ts`) cleans every `picks[].reason`: URLs (scheme, `www.`,
   bare `host.tld/path`), email addresses, control characters and lone surrogates, any digit run next to a currency sign
   or code (`$5`, `5 USD`, `EUR 10`, `10 euros`), whitespace collapsed, capped at 160 code points. Idempotent. The
   scripted reason ("Matches 2 of 3 of your terms.") is unchanged.
2. Served model. `ModelResponse` (ok) gains optional `served_model`. The scripted model sets `scripted-v1`; the Claude
   adapter sets the `model` field of the API answer when it is a plain id, else `CLAUDE_MODEL_ID`; a fallback answer is the
   scripted model's, so it says `scripted-v1`. `parseNeed` stores `response.served_model ?? model.model_id` in
   `briefs.version`. The evals page keeps showing the setting in force (no change: it never claimed a served id).
3. Per-IP limit. `RouteMeta` gains optional `rate_ip: RateRule` (an `ip` rule charged in addition to `rate`, after
   authentication and before the actor rule, so a refused visitor never spends the shared persona allowance). It is skipped when no client address is known (no `UMS_TRUSTED_PROXIES`), so it can never become one
   bucket for all judges. `/api/discover` and `/api/briefs` get `{ name: 'discovery-ip', per: 'ip', limit: 40,
window_ms: 3_600_000 }` next to the actor rule (20 an hour). `DEFAULT_RATES.discovery_ip` holds the same rule.
4. Ledger. A test proves `model.spend` rows hold no reader text (action, reason, detail, target).

Acceptance tests (run with `flock /tmp/um-suites.lock`):

- `corepack pnpm exec vitest run --project unit packages/model/src/reason-scrub.test.ts` : hostile reasons come out clean.
- `corepack pnpm exec vitest run --project adversarial packages/model/src/reason-scrub.adversarial.test.ts
packages/security/src/rate-ip.adversarial.test.ts` : hostile inputs; one IP (via `x-forwarded-for` with one trusted proxy)
  at its limit gets 429 while another IP still gets 200; no address means no per-IP charge.
- `corepack pnpm exec vitest run --project state apps/web/src/model-choice.state.test.ts domain/discovery/src/discover.state.test.ts` :
  `briefs.version` is `claude-haiku-5-5` when Claude answered and `scripted-v1` when it fell back; `model.spend` rows hold no
  reader text.
- `corepack pnpm lint && corepack pnpm typecheck && corepack pnpm format:check && corepack pnpm check:routes
&& corepack pnpm check:isolation && corepack pnpm check:no-live-host && corepack pnpm check:secrets-names` : all pass.
- `corepack pnpm --filter @umsbx/web build` : passes once before the final push.

Do not: add a dependency; touch money, approval, payments or PayPal code; change the spend caps; read a key; call a
network. Evidence: red run of the new tests, then green; counts of each check.
