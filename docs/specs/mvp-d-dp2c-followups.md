# DP-2c: MVP-D engine follow-ups from the DP-2b, DP-3 and DP-4 reviews

Task: close the LOW engine findings that touch what a buyer sees after a partial or held pack, without changing any money outcome.
Package: `domain/payments` (and its tests), `docs/READINESS.md` Owner: Sonnet 5.5 builder Reviewer: Opus 5.5 high (money path); Sakthi merges
Branch: `feat/payments-dp2c-followups` Commit: `fix(payments): <what> (DP-2c)` Decisions: D-041, D-047, D-051, D-054. Runs next to DP-5 (apps/web only); this lane touches no `apps/web` file.

Goal. Four small corrections, each proven by a test that fails first. If any item needs a behaviour change beyond the one described, STOP and report that item; do not guess.

1. **Receipt not reissued on a declined or held PayPal order** (`due.ts`). When the due pass ends a PayPal order of a pack as declined, failed, abandoned or frozen, the unit and the receipt must agree: the receipt of the order is reissued with the same rule `apply.ts` uses (`issueReceiptIfChanged`) so the receipt shows what was and was not charged. No new receipt content, only the same function called on the missing paths. Tests: a pack where PayPal order 2 is declined (receipt lists the paid item, not the declined one, version bumped once), one frozen (receipt unchanged for the held item, no charge line), and a second due pass changes nothing.
2. **Freeze paths that do not set `mismatch`.** The overview says `mismatch` is set whenever a PayPal order is frozen; four freeze paths do not set it. Find them (`grep` the frozen transitions in `apply.ts`, `due.ts`, `composite.ts`). For each, either set the flag in the same statement or, if the path is not a payee or amount mismatch, correct the overview text and say so in the report. Do not set a flag where the path is not a mismatch without stating why.
3. **Title cap can split a surrogate pair.** Where a unit or item title is cut to a maximum length for a PayPal order or a message, cut on a code point boundary (never leave half of a surrogate pair). Test with a title whose cap falls inside an emoji; the cut result must be valid UTF-16 and no longer than the cap.
4. **INV7 and reversal rows.** The INV7 check counts reversal rows in the ledger net but not in `refunded_minor`; a future reversal booking must move both. Add a state test that pins the current behaviour with a comment naming this rule, and record one paragraph in `docs/READINESS.md`. No change to the check itself.

Inputs: `domain/payments/src/{due,apply,composite,invariants}.ts` and their tests, `docs/specs/mvp-d-overview.md`, D-051 wording rules.
Outputs: changes in `domain/payments/src` and tests; one READINESS paragraph (replace the DP-2c bullet text with what was done and what was not).

Acceptance tests (run, paste output):

- Commit 1 holds only the new tests and is run red.
- `corepack pnpm exec vitest run --maxWorkers=2 domain/payments`: all pass after the change.
- `corepack pnpm lint`, `format:check`, `typecheck`, `check:isolation`, `check:no-live-host`, `check:secrets-names`.
- `corepack pnpm exec vitest run --maxWorkers=2 --project integration tests/mvp-a tests/mvp-b tests/mvp-c`: still green, unchanged.

Do not: touch `apps/web`, other packages, migrations or contracts; add a dependency; contact any network or PayPal; read or write a secret; edit an existing test except to follow a stated item (list each).
Disk: run `df -h /` before heavy steps; stop under 800 MB free.
Evidence: red summary, pass counts, the four findings with file:line, existing tests edited, a cost line.
