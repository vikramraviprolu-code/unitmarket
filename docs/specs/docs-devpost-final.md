# Spec: refresh the Devpost submission text to the live build (DOCS-2)

Task: bring `docs/submission/submission-text.md` in line with `main` at `75916ff3` and the live build `gcp-pub-14`.
Package: `docs/` only. Owner: coordinator. Reviewer: Sakthi. The owners approve every word (D-065).
Goal: no sentence in the text is older than the build it describes. Publisher onboarding, the web import, the fee on top, the
7 Nov sitting and the deploy are stated as they are. Nothing new is claimed that a file or a test does not back.
Inputs: `docs/decision-log.md` (D-108, D-111), `docs/specs/pob-*.md`, `apps/web/src/pob-journey.state.test.ts`, the deploy output of
8 Nov 2026 (AI adapter off).
Outputs: `docs/submission/submission-text.md`, this spec.
Acceptance tests:

- `corepack pnpm exec prettier --check docs/submission/submission-text.md docs/specs/docs-devpost-final.md` prints "All matched files use Prettier code style!".
- `grep -c "TO FINALISE (deploy, human only)" docs/submission/submission-text.md` prints 0.
- `grep -n "gcp-pub-14" docs/submission/submission-text.md` shows the status line and the hosted URL line.
- `grep -n -i "no commission" docs/submission/submission-text.md` prints nothing.
  Do not: touch other files; state that Claude runs in the hosted demo (it is off); add a dependency; put a secret anywhere.
  Evidence for the PR: the command output above.
  Branch: `feat/docs-devpost-final` Commit: `docs(submission): refresh the Devpost text to gcp-pub-14 (DOCS-2)`
