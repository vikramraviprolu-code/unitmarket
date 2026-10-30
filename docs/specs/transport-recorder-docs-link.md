# Spec: the fixture recorder drops PayPal documentation links (B-13 blocker)

Task: on 29 Oct 2026 the owner's first real `record:fixtures` run on the 26 Oct conformance recording wrote 35
files, and the transport contract test `fixtures.contract.test.ts` ("no fixture contains an email, a bearer token,
a client id, or a live hostname") failed on `capture_before_approval__capture_order__1.json`. PayPal's error body
carries an `information_link` to its developer documentation host. `recorder.ts` deliberately keeps that host
(`DOCS_HOST`, in `scrubUrl` and in the output check near line 694), while the contract test and the absolute rule
"no live PayPal hostname in fixtures" forbid it. The two disagree; the rule wins.
Package: `packages/transport` (`recorder.ts`, `recorder-selftest.ts`, `recorder-corpus.ts` and the recorder tests)
Owner: builder (Sonnet) Reviewer: Opus, one round (D-048); the coordinator merges.
Branch: `feat/transport-recorder-docs-link` Commit: `fix(transport): recorder drops documentation links (B-13)`

Goal: the recorder treats the documentation host like any other foreign host. Any URL on it, in any field or in
free text, becomes `[redacted-url]` and counts under "foreign url". The output check refuses a result that still
holds it. Nothing else about the recorder changes.

Requirements (tests first, commit 1 holds only tests and is run red; then implement to green):

1. A PayPal-style error body whose `details` or top level holds `information_link` with a documentation URL (a
   path and a fragment such as `#error-ORDER_NOT_APPROVED`) is recorded with `[redacted-url]` in its place and the
   statistic "foreign url" counted. Cover: a `links[]` entry with a `rel`, the host inside free text, upper case,
   a trailing dot on the host, and a percent-encoded form. Build the host in tests from parts (rule A-26: no
   literal host text in a tracked file).
2. The sandbox hosts and relative `/v2/...` links behave exactly as today.
3. The existing tests and corpus entries that assert the documentation link is KEPT contradict this spec: change
   them to the new rule and say which ones in your hand-back. Edit no other test.
4. `corepack pnpm record:fixtures --self-test` still passes.
5. A contract-style test shows that a recording built from a representative `capture_before_approval` error
   response passes the same live-host expectation as `fixtures.contract.test.ts` (do not edit that test).

Acceptance (run, paste output): `corepack pnpm exec vitest run --maxWorkers=2 packages/transport`; `corepack pnpm
record:fixtures --self-test`; `corepack pnpm lint`; `corepack pnpm format:check`; `corepack pnpm typecheck`;
`corepack pnpm check:isolation`; `corepack pnpm check:secrets-names`; `corepack pnpm check:no-live-host`;
`corepack pnpm check:fixtures`.

Do not: touch anything under `fixtures/`; run a real recording (the builder has no `calls.json`); edit
`fixtures.contract.test.ts`; add a dependency; contact any network or PayPal; read or create a real secret or read any
`.env.local`; run `pkill`; run a suite without `--maxWorkers=2`.
Disk: run `df -h /home` before heavy steps and stop under 400 MB free; remove only your own temp folders.
Evidence: commands with output, the list of tests you changed under requirement 3, a cost line.
