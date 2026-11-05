# Spec: rule settings table and operator write path (BR-2, UNI-80)

Task: store business-rule overrides as append-only rows and let an operator add one, safely.
Package: `packages/db` (one migration), `domain/rules`, `apps/web` (composition and one API route) Owner: builder (Sonnet)
Reviewer: Opus (L, money-adjacent) Branch: `feat/rules-settings` Commit: `feat(rules): settings store and operator write (BR-2)`
Depends on: BR-1, and TR0 merged (trace capture). Decision: D-096.

Goal: an operator with the second factor can add a platform, seller or buyer setting for a slice key, with a reason and an effective
date. Rows are never updated or deleted. Reading the active rows for a sale context is one indexed query. No caller uses them yet.

Scope against the design: design sections 5 and 9 put four tables and seeded platform rows here. This lane builds `rule_settings` only.
The agreements, agreement versions and acceptances tables move to BR-7. There is no seed: the registry default is the platform value
until an operator adds a platform row.

Design:

- Migration number: the next free number at merge, 0027 or later (0023 TR0, 0024 SR0, 0025 AL, 0026 CTL are taken in the
  consolidation registry). Never renumber an applied migration.
- `rule_settings` with the columns of `RuleSettingRowSchema` (BR-1). CHECKs: `scope_kind` in the five values; `scope_id IS NULL` only
  for `platform`; `char_length(reason) BETWEEN 3 AND 200`; `effective_until IS NULL OR effective_until > effective_from`. No DEFAULT on
  business columns. Append-only trigger (no UPDATE, DELETE, TRUNCATE) in the style of `0015_publisher_agreements.sql`. Index on
  `(rule_key, scope_kind, scope_id, effective_from)`. The value range is checked in the domain (the registry owns it).
  `scope_kind 'seller'` keys on `publishers.id`, `'buyer'` on `buyers.id`.
- If TR0 requires new tables in its capture list, `rule_settings` joins it. `reason` is journaled as sha256 like other free text.
- `domain/rules/src/store.ts`: `addRuleSetting(d, { actor, rule_key, scope_kind, scope_id, value, effective_from, effective_until, reason })`.
  Refusals: `not_operator`; `mfa_required` (actor `mfa !== true`, checked in the domain as well as the route); `rule_invalid` (unknown key,
  scope not allowed for the key, value outside the safe range or of the wrong JSON type); `backdated` (`effective_from` earlier than
  `d.clock.now()` minus 60 s); `scope_unknown` (a seller id that is not in `publishers`, a buyer id not in `buyers`, or an id of the
  other kind, for example a publisher id with `scope_kind: 'buyer'`). Writes the row and one audit event in one transaction; ids from
  `d.ids`. `activeRows(db, ctx, at)`: platform, seller, buyer and category rows active at `at`. `listRuleHistory(db, filter, limit)`:
  newest first; `limit` defaults to 200, maximum 5000 (BR-6 export).
- Route file `apps/web/src/app/api/ops/rules/route.ts`, pattern of `api/ops/agent-buy/route.ts`: `routeMeta` with
  `auth: 'operator'`, `csrf: true`, `rate: { name: 'ops_rules', per: 'actor', limit: 20, window_ms: 3_600_000 }`, `idempotent: true`,
  `risk: 'high'`, zod body (strict). `check:routes` reads the `routeMeta` into the inventory. `apps/web/composition.server.ts` exposes
  `engine.opsRules.add`, `engine.opsRules.history`, `engine.rules.activeRows`. `domain/rules/package.json` gains `@umsbx/db` only if the
  store needs its types.

Tests first: `packages/db/src/migration-<n>.state.test.ts` (table, CHECKs, append-only, index); `domain/rules/src/store.state.test.ts`
(happy path, every refusal code, audit row written, history order and limit, active-row selection at both boundaries; two
concurrent writes for the same key and scope are both stored and the BR-1 resolver picks one deterministically);
`apps/web/src/ops-rules.state.test.ts` (route needs MFA and an Idempotency-Key; the same key with the same body replays the first
answer; the same key with a different body is refused; operator API key, buyer and publisher refused);
`domain/rules/src/store.adversarial.test.ts` (scope_id injection strings stored as data, wrong JSON type refused, a publisher id with
`scope_kind: 'buyer'` refused `scope_unknown`, an operator session without MFA refused at the domain even if the route is bypassed,
201 history rows return 200 by default).

Acceptance: those tests plus the six suites pass, red run first; `corepack pnpm mutation --targets domain/rules/src/store.ts
--require-targets` kills at least 80 percent; `pnpm trace:verify` reports zero unattributed rows after the state test seed;
`check:routes`, `check:isolation`, `check:no-live-host`, `check:secrets-names`, lint, typecheck, format pass.
Do not: let any existing caller read the rows; edit an applied migration; add a dependency; add a screen (BR-6); build agreements (BR-7).
Evidence: red and green runs, mutation score, a psql-free dump of two rows from the state test.
