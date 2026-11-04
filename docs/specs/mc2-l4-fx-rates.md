# MC2-L4: fx_rates table, ECB fetch, convert function

Task: store EUR-based daily rates, fetch them from the ECB on demand, convert minor units between USD, EUR and GBP.
Package: packages/db (migration), packages/transport (fetch), new `domain/fx` (`@umsbx/fx`), composition wiring. Owner: Sonnet builder. Reviewer: coordinator + Opus.
Decisions: D-084 (items 4, 5, 8), D-085 (all). Umbrella: docs/specs/multi-currency-v2.md. Branch: feat/mc2-l4-fx-rates. Commit: `feat(fx): <what> (MC2-L4)`.

Goal: the app can say "1 EUR = x USD as of <ECB date>" and convert any of USD, EUR, GBP minor-unit amounts to another, with a stored rate that survives a failed fetch. This lane builds the engine only. No screen shows it yet (L5, L7). No scheduled job. No paid provider.

Inputs: `packages/transport/src/model-https.ts` (copy its shape: one fixed host, no redirect, size cap, deadline, fixed error kinds, injected `request`), `packages/db/migrations/common/` (next number after 0016), `docs/decision-log.md` D-084/D-085, `packages/runtime` (Clock). Money uses integer minor units; USD, EUR, GBP all have 2 decimals.

Outputs:

1. Migration `fx_rates`: `date` (ECB date, text/date), `base` ('EUR'), `quote` ('USD'|'GBP'), `rate` (numeric, > 0), `fetched_at`, primary key (date, quote). Append-only: no UPDATE or DELETE grant path in code. Seed rows (clearly marked `source='seed'`) for one recent ECB date so a fresh database has a rate; values written by the builder as plausible round numbers and labelled seed in a comment. `source` is 'ecb' or 'seed'.
2. `packages/transport/src/fx-ecb.ts`: one host constant `https://www.ecb.europa.eu`, one path `/stats/eurofxref/eurofxref-daily.xml`, GET only, no credentials, no redirect followed, response at most 64 KB, deadline 3 s, `Accept: application/xml`. Parse with a strict hand parser (no new dependency): accept only the known envelope and `<Cube currency='XXX' rate='n'/>` entries, ignore currencies other than USD and GBP, take the date from `<Cube time='YYYY-MM-DD'>`. Reject: wrong shape, missing USD or GBP, rate not a finite number > 0, date not a valid date, date older than the newest stored date. Reject a rate that moves more than 10% from the last stored rate for the same quote (keep the old one, report `rejected_move`). Errors carry a fixed kind only, no peer text. Only this file in transport may reach this host; `pnpm check:no-live-host` and isolation must stay green (extend only if they need the new host named, minimal).
3. `domain/fx`: `getRates(db, clock)` returns the latest stored EUR→USD and EUR→GBP with their date and age; `refreshIfStale({db, clock, fetchRates})` fetches only when the newest `fetched_at` is over 6 hours old, under an advisory lock so concurrent calls fetch once, never throws (returns `{status:'fresh'|'refreshed'|'kept'|'failed', ...}`); `convert({minor, from, to, rates, at})` returns `{minor, rate_date, rate, approx:true}` or `null` when from=to is handled as identity and when a pair has no usable rate. Cross rates (USD↔GBP) derive from the two EUR rates of the same ECB date only. A rate is usable if its date is at most 7 days older than `at`; otherwise `convert` returns null. Rounding: half away from zero to the nearest minor unit, documented and tested. Money amounts must never overflow `Number.MAX_SAFE_INTEGER` (reject, return null).
4. Composition wiring in `apps/web/composition.server.ts`: build `fetchRates` from the transport function and expose `engine.fx` (or the nearest existing pattern) with `getRates`, `refreshIfStale`, `convert`. In offline/test modes the fetch is a fake that never touches the network.

Acceptance tests (tests first, shown red, then green):

- Parser: golden ECB sample XML parses to date + USD + GBP; truncated, wrong-envelope, missing GBP, rate 0, rate negative, rate NaN, huge body, and extra Cube entries cases are refused or ignored as stated.
- Fetch: fake `request`: success, redirect (not followed, error kind), timeout at 3 s, oversize body, non-200, wrong host refused.
- Guard: a rate that moves 11% from stored is rejected and the stored rate kept; 9% accepted; date older than stored rejected.
- Refresh: fresh (< 6 h) does not call fetch; stale calls once under 5 concurrent callers; failure keeps the old rate and returns `failed` without throwing.
- Convert: 1000 USD minor → EUR, GBP→USD cross via same date, identity, rounding half away from zero (a table of 6 cases), rate older than 7 days → null, no rate → null, overflow → null.
- Migration: applies on an empty db and on the existing seeded db; seed row present; real-Postgres test with `UMS_TEST_PG_BIN=/usr/lib/postgresql/16/bin`.
- `pnpm lint`, `typecheck`, all six `pnpm test:*`, `pnpm check:no-live-host`, `pnpm check:isolation` green.

Do not: touch payments, approval, ledger, ledger or order currency; call the real ECB host from any test or from the builder; add a dependency; add a scheduled job; use a paid or third-party relay; write secrets; change `SCOPE_CURRENCIES` or any PayPal lock. The ECB host is NOT a payment API and needs no approval row, but it needs an egress allow-list entry at deploy (lane L8).
Evidence for the PR: red run, green run per suite, parser fixtures, migration output.
