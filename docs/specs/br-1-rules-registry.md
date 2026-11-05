# Spec: rule registry and pure terms resolver (BR-1, UNI-80)

Task: one code registry of configurable business rules and a pure function that resolves the value that applies to a sale.
Package: `packages/contracts` (new `src/rules.ts`), new `domain/rules` (`@umsbx/rules`) Owner: builder (Sonnet) Reviewer: Opus
Branch: `feat/rules-registry` Commit: `feat(rules): registry and terms resolver (BR-1)` Decisions: D-096. Design:
`docs/business-rules/configurable-rules-design.md` sections 3, 5 and 6.

Goal: nothing in the product changes behaviour in this lane. The registry and resolver exist, are tested, and with no override rows
return exactly today's values plus the D-096 refund window. Later lanes (BR-2, BR-3, BR-4) read them.

Design:

- `packages/contracts/src/rules.ts` exports `RULES_REGISTRY` (frozen), `RuleKey`, `RuleScopeKind` (`platform`, `category`, `seller`,
  `buyer`, `agreement`), `RuleSettingRowSchema` (zod: id, rule_key, scope_kind, scope_id nullable only for platform, value, effective_from,
  effective_until nullable, set_by, reason 3..200, approved_by nullable, created_at) and `ResolvedTermsSchema`. `seller` keys on
  `publishers.id`, `buyer` on `buyers.id`. Slice keys only:
  - `refund.request_window`: integer days, default 7, safe range 0..30, scopes all five, merge `max`, tier A (D-096).
  - `access.window`: integer days, default 5, safe range 1..30, scopes platform, category, seller, merge `seller_wins`, tier A
    (BR-ACC-1). Linked: raised to at least the resolved refund window (D-096 (1)).
  - `mandate.max_days`: integer days, default 90, safe range 1..90, scopes platform, buyer, merge `min`, tier A (BR-MAN-2).
- `domain/rules/src/resolve.ts`: `resolveTerms(ctx, rows, now)`, ctx = `{ seller_id, buyer_id, category: string | null }`. Pure: no
  clock, database or env; `now` is an ISO string. Precedence (design section 6):
  1. Keep rows active at `now` (`effective_from <= now < effective_until`). Agreement rows are ignored until the agreements lane.
  2. Seller side: the most specific scope with a row wins: seller over category over platform. Buyer side: buyer over platform.
     Within one scope, latest `effective_from` wins, then latest `created_at`, then the larger id.
  3. If only one side set the key (or neither), that value (or the default) applies. If both the seller side and the buyer side set it
     at seller or buyer scope, merge the two by the key's strategy (`max`, `min`, `seller_wins`). A platform row counts for both sides,
     so it never merges with itself.
  4. Link rule: `access.window = max(access.window, refund.request_window)`.
  5. Every value inside its safe range, else `err({ code: 'rules_invalid', key })`.

  Returns `{ rules_version: '1', values, sources, digest }`. The field is `rules_version`, not `terms_version`, which already means the
  offer terms on `SnapshotItemSchema` (`approval.ts:21`). `sources[key]` is `default`, `platform:<row id>`, `seller:<id>@<row id>` and
  so on. `digest` is sha256 hex of the canonical JSON of `values` (sorted keys), computed in `domain/rules/src/digest.ts` only.

- `domain/rules` imports only `@umsbx/contracts` (S1) plus `node:crypto` in `digest.ts`. It does not import `@umsbx/approval` for
  `sha256Hex`: BR-3 makes approval import rules, which would be a cycle. Export from the package root only.

Files: `packages/contracts/src/rules.ts`, its index export and test; `domain/rules/package.json`, `tsconfig.json`, `src/index.ts`,
`src/resolve.ts`, `src/digest.ts` and tests; `pnpm-lock.yaml` (workspace entry only); `eslint.config.mjs`: add `'rules'` to `DOMAIN`
(line 94, so S1 and S6 apply) and `rules: ['digest.ts']` to `HASH_ONLY` (line 1182).

Tests first (commit 1, run red): `packages/contracts/src/rules.test.ts` (registry shape, every default inside its range, schema refuses
unknown keys and bad scopes); `domain/rules/src/resolve.test.ts` table cases:

- no rows: refund 7, access 7 (raised), mandate 90;
- platform 7 + seller 3: refund 3 (specific scope wins, no merge);
- platform 7 + seller 3 + buyer 10: refund 10 (seller side 3, buyer side 10, merge `max`);
- seller 14 + buyer 30: refund 30, access 30;
- buyer mandate 30 + platform 90: 30; access seller 10 + platform 5: 10;
- two seller rows for the same seller: latest `effective_from` wins; equal `effective_from`, later `created_at`; equal both, larger id;
- a row before `effective_from` or at `effective_until` ignored; agreement rows ignored; out-of-range value gives `rules_invalid`;
- same input in shuffled row order gives the same values and digest.

`domain/rules/src/resolve.property.test.ts`: 200 cases with a local seeded generator in the test file, as
`domain/access-clock/src/refund.property.test.ts:34` does (the testkit has no Rng; no new dependency): every value inside its range
and access >= refund.

Acceptance: `corepack pnpm vitest run packages/contracts/src/rules.test.ts domain/rules` passes (red run shown first); lint, typecheck,
format check, `check:isolation`, `check:no-live-host`, `check:secrets-names` pass; `git diff --stat origin/main` lists only the files above.
Do not: wire the resolver into any caller; add a dependency; touch the database; import `@umsbx/approval`.
Evidence: red run, green run, the table of cases.
