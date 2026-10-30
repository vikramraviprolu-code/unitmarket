# L2: repo compliance (licence, dependency licence audit, README)

Task: make the repository ready to be public under the contest rules: an Apache-2.0 licence GitHub detects, a dependency licence audit with a notices file, and a README that tells a judge the truth and how to run it offline.
Package: repository root (no product code) Owner: Sonnet 5.5 builder Reviewer: Opus 5.5; the coordinator merges
Branch: `feat/repo-compliance` Commit: `type(repo): <what> (L2)`. Decision items 7, 8 and 11 in `docs/owner/DECISIONS-FOR-VIKRAM.md`.

Goal: `LICENSE` is the canonical, unmodified Apache License 2.0 text (fetched from apache.org and cross checked against the Apache-2.0 copy shipped in two installed packages). The root `package.json` `license` field is `Apache-2.0` (no workspace `package.json` said `UNLICENSED`). `scripts/licenses-report.mjs` reads `pnpm licenses list --json --prod` (offline), writes `THIRD-PARTY-NOTICES.md` (package, version, licence), and exits non-zero when a production dependency has a copyleft or unknown licence (GPL, AGPL, LGPL, SSPL, EUPL, UNLICENSED, unknown) unless it is in the script's allow-list with a written reason and the recorded licence still matches. Weak file-level copyleft (MPL-2.0) does not fail but is listed in its own section. An SPDX `OR` passes when one side passes; `AND` needs every side to pass. `README.md` is rewritten: honest status, the three minute demo path, an offline run in under ten minutes, an optional own-credentials section (variable names only), safety design, licence, and the statement that the work was built from 1 Oct 2026.

Inputs: `pnpm-lock.yaml` and the installed tree (read by `pnpm licenses`), `package.json` scripts, `docs/owner/`, `apps/web` config, `docs/decision-log.md`.

Outputs: `LICENSE`, `README.md`, `THIRD-PARTY-NOTICES.md`, `scripts/licenses-report.mjs`, `scripts/licenses-report.test.ts`, `package.json` (the `license` field and one script, `check:licences`), this spec. `NOTICE` and `docs/PROVENANCE.md` only if needed (not needed).

Acceptance tests:

- `corepack pnpm vitest run --project unit scripts/licenses-report.test.ts`: classifier cases (permissive, weak, copyleft, unknown, `OR`, `AND`, parentheses), allow-list rules (needs a reason; a changed licence is not covered), deterministic sorted notices, CLI exit codes on fixture JSON. Commit 1 holds this test and is run red (the script does not exist yet).
- `node scripts/licenses-report.mjs --check`: exit 0 on the real tree, `THIRD-PARTY-NOTICES.md` is current; prints the allow-listed exception (`@img/sharp-libvips-linux-x64`, LGPL-3.0-or-later) so it is not hidden.
- `head -3 LICENSE` shows `Apache License` and `Version 2.0, January 2004`; `grep '"license"' package.json` shows `"license": "Apache-2.0"`.
- `corepack pnpm lint && corepack pnpm typecheck && corepack pnpm format:check && corepack pnpm check:isolation && corepack pnpm check:no-live-host && corepack pnpm check:secrets-names && corepack pnpm check:provenance`: exit 0.
- The six suites one at a time (`test:unit` to `test:golden`) pass (the state suite has the one known expected failure).
- README offline commands (install, check scripts, `pnpm test:unit`, the app start command given there) were run by the author and worked; nothing else in the README is claimed beyond what the repository shows.

Do not: change product code, `eslint.config.mjs` or any file outside the Outputs list; add a dependency; connect to PayPal; put any secret or value in the README (names only); describe the AI adapter, the publisher console or the two skin screens as finished.

Evidence for the PR: red run of the new test, final pass counts, the audit output, the text of the finding on `@img/sharp-libvips-linux-x64`. The audit reads declared licences from package metadata; it is not legal advice.
