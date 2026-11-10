# Spec: worldwide payee corridors, migration 0034 (L3, WW-COR)

Task: widen the three corridor rows so a publisher in any country except India can sell in USD, EUR or GBP; add the India EUR and GBP rows; guard against overlap.
Package: `packages/db` (migration) with `packages/contracts` (country list), `domain/catalogue` (seed data, demo prices, applicant country). Owner: builder (Sonnet). Reviewer: Sakthi, or any reviewer other than the author.
Branch: `feat/db-ww-corridors` Commit: `type(db): <what> (WW-COR)`. Decision: owner rule of 9 Nov 2026 (D-113): only USD, EUR, GBP; the seller picks the currency per offer; no FX; India buyers cannot buy from an Indian publisher.
Design: approved design, items C2, C3, C4, C10 (lane L3). Deploy AFTER lane L1 (`feat/catalogue-offer-currency`), never before: L1 removes the `ORDER BY id LIMIT 1` currency guess that 0034 would otherwise break.

Goal: after 0034, on a fresh or a deployed database: `us-usd` (USD), `gb-gbp` (GBP) and `de-eur` (EUR) are enabled, with payee countries = every ISO 3166-1 alpha-2 code except `IN`, buyer countries `['*']`; `in-usd` (0033) is unchanged; new `in-eur` and `in-gbp` are shaped like `in-usd` (payee `['IN']`, buyers `['*']`, no domestic sale). Ids, currencies and every other column of the three widened rows stay. Two enabled rows of one currency never share a payee country (a trigger refuses it).

Checked in the code: `corridorFor` and `start.ts` call with `buyer_country: null`, so `buyer_countries` gates nothing; `['*']` on the three rows is documentation of the owner rule, and `domestic_supported` stays true (India alone is no-domestic).

Inputs: `packages/db/migrations/common/0001_core.sql`, `0033_*`, `domain/catalogue/src/{seed-data,seed,demo-prices,applicants,corridors}.ts`, `fixtures/catalogue/seed.json`.
Outputs: `packages/contracts/src/countries.ts` (the one ISO list, exported), `packages/db/migrations/common/0034_ww_corridors.sql`, seed data and `seed.json` in the wide shape, `demo-prices.ts` (USD, EUR, GBP), `applicants.ts` (country must be in the list), tests, `fixtures/INDEX.json`.

Migration 0034: forward only; no down step, no `now()`, no `DEFAULT`. First a deferrable constraint trigger on `corridors` (after insert or update, enabled row, same currency, `payee_countries &&` another enabled row: refuse). Then `INSERT ... ON CONFLICT (id) DO UPDATE SET currency, payee_countries, buyer_countries, enabled = true, updated_at` for the three rows (the migration runs before the seed, so the seed's `DO NOTHING` can never narrow them); plain `INSERT` for `in-eur` and `in-gbp`. The country literal is written once, generated from the contracts constant; a test proves equal.

Acceptance tests (run each; red for commit 1, green after):

- `corepack pnpm vitest run packages/db/src/migration-0034` : old-disk database (all files before 0034, narrow and off `gb-gbp`, `de-eur`, an operator change on `us-usd`): rows wide and on, ids and currencies unchanged, `in-eur` and `in-gbp` exact, applied once; fresh database holds exactly the five ids; the literal equals the constant.
- `corepack pnpm vitest run domain/catalogue/src/corridors-ww` : fresh migrate then the full boot seed (base seed plus DE supplement): rows stay wide and on; a second boot changes nothing; each of the 248 non-IN codes is covered by exactly one enabled row per currency, `IN` only by `in-*`; the guard refuses an overlap (insert and update) and allows a swap in one transaction and a disabled overlap.
- `corepack pnpm vitest run packages/contracts/src/countries domain/catalogue/src/applicants domain/catalogue/src/applications` : 249 codes, sorted, unique; `UK`, `EU`, `ZZ`, `gb` refused as applicant country.
- `corepack pnpm vitest run domain/catalogue/src/write.state` : demo prices clamp GBP and EUR; `village-bus` 0.90 GBP becomes 1.00.
- `corepack pnpm lint`, `typecheck`, `format:check`, `check:isolation`, `check:no-live-host`, `check:secrets-names`, `check:fixtures`, the six suites: pass.

Do not: touch `write.ts`, `import-*.ts`, `corridors.ts`, `composition.server.ts`, web routes or forms (lane L1), payments, ledger, approval, transport, paypal; add a dependency; change ids or currencies of existing rows; put a secret anywhere.
Evidence for the PR: the red run, the green run, the check outputs, each existing test edited and why.
Existing tests edited (the list lands in the PR): rows and ids in `migration-0033`, `schema`, `approval`, `catalogue`, `corridors-in`, `in-corridor`; fixtures that insert an EUR row for payee US now meet the guard; tests that assumed `gb-gbp` and `de-eur` off at boot.
