# Spec: add the Apache NOTICE file (LIC-1)

Task: add a root `NOTICE` file for the Apache License 2.0 release of the repository.
Package: repository root, `docs/`. Owner: coordinator. Reviewer: Opus, then Sakthi merges.
Decision: the owner chose Apache-2.0 on behalf of the whole team, 9 Nov 2026 (to be recorded as a new decision-log row, with the currency rule, by a follow-up decision-log PR after the D-112 PR merges). `docs/specs/repo-compliance.md` L2 said NOTICE was not needed; it is added now because the repository is released under Apache-2.0 with one vendored file that is not covered by it.
Goal: the repository carries the notices Apache 2.0 asks for and the trademark and third party statements a public reader expects.
Inputs: `LICENSE`, `THIRD-PARTY-NOTICES.md`, `video/vendor/NOTICE`.
Outputs: `NOTICE`, this spec. No code, no dependency, no change to `LICENSE`.
Acceptance tests:

- `corepack pnpm exec prettier --check docs/specs/docs-notice-file.md` prints "All matched files use Prettier code style!".
- `head -3 NOTICE` shows the product name and the copyright line.
- `corepack pnpm run check:licences` prints "43 production packages, 0 failing, 1 allowed by exception, 0 weak copyleft".
- `test -f video/vendor/NOTICE && grep -c 'video/vendor/NOTICE' NOTICE` prints 1.
- `grep -cE '@|https?://' NOTICE` prints 0.

Do not: edit `LICENSE`, add a dependency, put a name or an address of a person in the file.
Evidence for the PR: the output of the five commands above.
Branch: `feat/docs-notice-file` Commit: `docs(licence): add the NOTICE file (LIC-1)`
