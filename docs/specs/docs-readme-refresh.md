# Spec: bring the public README up to date with the live build (DOCS-README)

Task: rewrite the stale parts of `README.md` so that every claim matches `main` at `172e5c7a` (PR 74, the India USD corridor).
Package: docs Owner: Sonnet (builder) Reviewer: not the author
Branch: `feat/docs-readme-refresh` Commit: `docs(readme): <what> (DOCS-README)`

Goal: a visitor who reads only the README learns what is built, what is dry run and what is not built, with no claim that the repository
cannot back. The README goes public, so each kept or added claim is checked against `docs/`, the decision log, the specs, the code or a
test, and nothing is invented.

Inputs: `docs/decision-log.md` (D-089, D-094, D-096, D-108, D-111), `docs/specs/pob-p1-publisher-accounts.md`, `pob-m1-fee-and-payout.md`,
`pob-i1-web-import.md`, `db-in-usd-corridor.md`, `br-4-refund-window.md`, `apps/web/src/pob-journey.state.test.ts`,
`docs/business-rules/business-rules-reference.md`, `docs/submission/*.md`, `package.json`, `.env.example`.

Outputs: `README.md` and this spec. Nothing else changes.

Changes the README must make:

- Replace the false line "Decided but not built": publisher accounts, web import with domain proof, the fee on top, refund window
  enforcement and dry run payouts are built; real PayPal payouts are not.
- Hosted demo URL filled in, with the sandbox (test money) and same address sign in notes. The demo video line stays a placeholder.
- The India USD corridor is stated, without any multi currency claim.
- The real, dry run and simulated table keeps the 7 Nov 2026 sandbox purchase (D-108, D-111), the one test account, dry run payouts,
  operator refunds and no tax.
- The Claude adapter is off on the hosted app. Test counts appear only as measured on the live commit.
- Licence section names `LICENSE` and `THIRD-PARTY-NOTICES.md` (and `NOTICE` only if it is on `main`).

Acceptance tests (run in the worktree):

- `corepack pnpm exec prettier --check README.md docs/specs/docs-readme-refresh.md` prints `All matched files use Prettier code style!`.
- `grep -n -i "no commission" README.md` prints nothing.
- `grep -n "TODO after deploy" README.md` prints nothing.
- `grep -n "Decided but not built" README.md` prints nothing.
- `corepack pnpm run check:secrets-names` ends with an ok line and exit code 0.
- `git diff --stat origin/main` lists only `README.md` and `docs/specs/docs-readme-refresh.md`.

Do not: touch code, config or other docs; add a dependency; name a third party tool other than PayPal and Claude in prose; use italics,
dashes or em dashes in prose; put a secret, a passcode or a personal address anywhere; claim a real payout, a second merchant, a tax
calculation, or that Claude runs in the demo.

Evidence for the PR: a table of each claim changed with the file or test that backs it, and the command output.
