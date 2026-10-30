# Spec: threat model, privacy export and delete script spec, keyboard pass checklist (DOCS-A)

Task: three documents for the close-out (first half of the requested `docs-close-out`; the second half is DOCS-B).
Package: `docs/` only Owner: builder (Sonnet) Reviewer: Opus, one round; owners approve (H)
Branch: `docs/close-out-a` Commit: `docs(<area>): <what> (DOCS-A)` Decisions: D-065 items 52, 55, 57; D-066 (axe-core
waits). No code, no dependency, no test. Common rules: plan section 2. No dependency on other lanes.

Goal: the repository holds a one-page threat model built from the existing design, an implementable spec for the privacy
script, and a checklist a human can run with a keyboard alone. Every statement cites the file it comes from; anything not
verified says UNVERIFIED.

1. `docs/design/threat-model.md` (one page, about 60 lines). Sources: `docs/design/architecture.md` sections 2.1 (trust
   zones), 7 (connection safety), 9.8 (security middleware), 13 (security SOP); `docs/design/nfr.md` (P and SOP rows,
   PRIV, AI); decision rows D-028, D-029, D-040, D-059, D-061, D-063. Content: assets (payee destination, approval rows,
   sandbox credentials, session and link secrets, buyer data, content); actors (buyer, publisher persona holder, operator,
   coordinating AI session, builder agents, PayPal, hosting provider, an anonymous attacker); a STRIDE table with one row per
   threat, its control and the test or check that pins it (name the test file); the accepted risks with their decision rows
   (shared passcode D-040, race tests waived D-045, single merchant D-041); the new surfaces of the overnight lanes
   (publisher personas, payee requests, the model egress host, the Appearance cookie) with their controls from the specs in
   `docs/specs/`. No secret value, no full merchant id, no hostname other than those already in the architecture.
2. `docs/specs/ops-privacy-export-delete.md` (spec only, under one page, template of `CLAUDE.md`; decision 52; PRIV-3,
   PRIV-4). One operator script `scripts/privacy.mjs` with `export <buyer_id>` (JSON of the buyer's rows: consents,
   briefs, quotes, approvals, orders, units, entitlements, access events, receipts; no other buyer's data) and `delete <buyer_id>` (pseudonymise the buyer row and briefs, keep ledger and receipts with the pseudonym, never delete ledger rows;
   append-only tables untouched; one `audit_log` row), TTY only, refusing in CI, using the same environment guard as the
   safety CLI (D-059 lesson), with `env -u DATABASE_URL -u UMS_DB -u UMS_PAYPAL_CONNECT` in the examples. Tests named: one
   state test on PGlite. Mark "cut first if short of time".
3. `docs/evidence/keyboard-pass-checklist.md`: the A11Y-1, A11Y-4, A11Y-5, A11Y-7 rows of `nfr.md` turned into numbered
   steps for the journey sign in, find, pack, approve, PayPal return (dry run), library, reader, receipt, help, publisher
   pages, ops; for each step the expected focus order, the visible focus, the live announcement text from the copy modules,
   and a result column left empty. State at the top: "axe-core is not added (decision 55 pending Vikram); this pass is
   manual." Include the browser and screen reader to record, and a 400 px pass.

Acceptance (run, paste output): `corepack pnpm format:check` passes on the three files (`corepack pnpm exec prettier
--check docs/design/threat-model.md docs/specs/ops-privacy-export-delete.md docs/evidence/keyboard-pass-checklist.md`);
`corepack pnpm check:no-live-host` and `corepack pnpm check:secrets-names` pass; `wc -l docs/design/threat-model.md`
is 80 or fewer.
Do not: change code, tests or other docs; invent a control that is not in the code or a spec (write "missing" instead); add
axe-core; paste any value from an env file.
Evidence: the three paths, the check output, the list of claims marked UNVERIFIED, cost line.
