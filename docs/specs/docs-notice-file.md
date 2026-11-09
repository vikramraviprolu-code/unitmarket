# Spec: add the Apache NOTICE file (LIC-1)

Task: add a root `NOTICE` file for the Apache License 2.0 release of the repository.
Package: repository root, `docs/`. Owner: coordinator. Reviewer: Sakthi.
Decision: the owner chose Apache-2.0 on behalf of the whole team, 9 Nov 2026.
Goal: the repository carries the notices Apache 2.0 asks for and the trademark and third party statements a public reader expects.
Outputs: `NOTICE`, this spec. No code, no dependency, no change to `LICENSE`.
Acceptance tests:

- `corepack pnpm exec prettier --check docs/specs/docs-notice-file.md` prints "All matched files use Prettier code style!".
- `head -3 NOTICE` shows the product name and the copyright line.
- `corepack pnpm run check:licences` prints "0 failing".
  Do not: edit `LICENSE`, add a dependency, put a name or an address of a person in the file.
  Branch: `feat/docs-notice-file` Commit: `docs(licence): add the NOTICE file (LIC-1)`
