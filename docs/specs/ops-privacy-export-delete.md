# Spec: operator privacy script, export and delete (OPS-PRIV, spec only)

Cut first if short of time (decision 52). This file is the spec; the script is a later lane and is not built here.

Task: one operator script `scripts/privacy.mjs` with `export <buyer_id>` and `delete <buyer_id>` for PRIV-3 and PRIV-4.
Package: `scripts/` (plus one test file) Owner: builder (Sonnet) Reviewer: Opus, one round; owners approve the delete rules
Goal: an operator at a terminal can hand a buyer a JSON copy of that buyer's rows, and can remove the buyer's personal data
without touching the money evidence. Today the buyer rows hold a display name, an `auth_subject`, free text in briefs and
consents; the ledger, receipts and approvals hold ids only (checked in migrations 0002 to 0005 and `contracts/approval.ts`;
UNVERIFIED for the full text of every receipt body, the test must scan one).

Inputs: the database through the same loader as the safety CLI (`loadConfigFromProcess`, `openDatabase`, `migrate`,
`terminalEnv` in `scripts/lib/safety-cli-main.mjs`); `<buyer_id>` as an argument; no env file is read by the script itself.
Outputs: `export` prints one JSON document to stdout (and nothing else on stdout); `delete` changes rows as below and writes
one `audit_log` row (actor `operator`, action `privacy.delete`, target buyer id, reason from `--reason`, detail with row
counts only, no personal value).

Behaviour:

- Guards, both commands: refuse unless stdin is a TTY; refuse when `CI`, `GITHUB_ACTIONS` or an AI session marker is set
  (`terminalEnv`); first line printed is `mode=... db=<kind>` as `safety:status` does, and `delete` asks the operator to type
  the buyer id back before it acts (the D-059 lesson: a command must show which database it will touch). A guard that
  refuses when a database setting in the process differs from the settings file is the follow-up on branch
  `feat/config-env-file-guard`, not on `main`; this script uses it once merged.
- `export`: reads rows where the buyer is the owner: `buyers`, `consents`, `identity_links` (hash only), `briefs`,
  `proposals`, `quotes`, `approvals`, `orders`, `order_units`, `entitlements`, `access_windows`, `access_events` (through
  the buyer's entitlements), `receipts` (through the buyer's orders). No other buyer's row; every query filters by the
  buyer id. Writes nothing to the database.
- `delete`, in one transaction: set `buyers.display_name` to `deleted-<first 8 hex of sha256(buyer_id)>` (the pseudonym) and
  `auth_subject` to `deleted:<pseudonym>`; set `briefs.raw_text` to `[removed]` and `structured` to `{}`; revoke the buyer's
  open `sessions`. Never delete a row. `ledger_entries`, `receipts`, `approvals`, `access_events`, `provider_calls` and
  `audit_log` are append-only and untouched (their triggers refuse change). Running `delete` twice changes nothing more.

Acceptance tests (run, paste output):

- `corepack pnpm exec prettier --check docs/specs/ops-privacy-export-delete.md` passes.
- `env -u DATABASE_URL -u UMS_DB -u UMS_PAYPAL_CONNECT corepack pnpm test:state scripts/privacy` passes, one PGlite
  state test, `scripts/privacy.state.test.ts`: two buyers with orders; export of buyer A holds none of B's ids; delete of A
  leaves A's ledger and receipt rows byte equal, leaves B untouched, writes exactly one audit row, a second delete is a
  no-op, and the text of A's display name and brief appears nowhere in a dump of the changed tables.
- `env -u DATABASE_URL -u UMS_DB -u UMS_PAYPAL_CONNECT corepack pnpm exec node scripts/privacy.mjs export <id> < /dev/null`
  exits non-zero with `refused: not a terminal`; with `CI=1` set it exits non-zero with `refused: CI`.
- `corepack pnpm lint`, `corepack pnpm typecheck`, `corepack pnpm check:secrets-names` pass.

Do not: touch other packages; add a dependency (D-008); read an env file; change a migration, a contract or a trigger; delete
or update any append-only row; print a personal value in the audit row or in a log line; run against the hosted database.
Evidence for the PR: the test output, the two refusal lines, one sanitised export with ids shortened, cost line.
Branch: `feat/scripts-privacy` Commit: `feat(scripts): privacy export and delete (OPS-PRIV)`
Retention (PRIV-3) is separate: logs 30 days, briefs 30 days, orders and ledger to 15 Jan 2027; the script does not enforce it.
