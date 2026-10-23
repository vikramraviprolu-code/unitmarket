# BU-3: prove the unsealed app boots and fails closed under `next start`, offline

Task: build and start the real Next.js server in sandbox mode with fake credentials and a deliberately useless approval row, and prove from its own logs that boot is not refused, Next's fetch patch does not touch the Wire, and no call leaves.
Package: `scripts/` (proof script and test only) Owner: Sonnet 5.5 builder, effort high (only proof of N5 and the boot override list) Reviewer: Opus 5.5 high; Sakthi merges
Wave: W3, after BU-2 merges; parallel with BU-6 and CO-6. Assumptions: ASM-50, ASM-34, ASM-35.

Goal: READINESS warns that (1) Next patches `globalThis.fetch` after our modules load and (2) a runner that adds `--require`, `--import` or `NODE_OPTIONS` makes sandbox boot refuse (`transport_env_override`). Unit tests cannot see either. `scripts/next-start-proof.mjs` runs, under `flock /tmp/sbx-next-build.lock`: `next build` and `next start -H 127.0.0.1 -p <free port>` for `apps/web`, with `NEXT_TELEMETRY_DISABLED=1` (Next telemetry is itself an outbound call), `UMS_MODE=sandbox`, `UMS_PAYPAL_CONNECT=on`, `NEXT_PUBLIC_UMS_ENV_LABEL=Sandbox`, `UMS_DB=pglite-disk` in a fresh temp dir, fake credentials assembled at run time, and no `NODE_OPTIONS`. Before start it migrates that temp DB and inserts one `outbound_approvals` row for scope `mvp_b_polling` whose `operations` list is `['get_capture']` only, and turns `paypal_outbound` on. So the scoped gate mints a capability and the approved transport is built with the production Wire, but the first call the adapter makes (`oauth_token`) is blocked `no_approval` by the gate before the Wire. The script then GETs `/` and an offer page (Next loads route modules and patches fetch), signs in as buyer A, starts a checkout, GETs `/healthz`, stops the server, and reads its stdout JSON lines. A second run with `NODE_OPTIONS=--require=./x.cjs` must exit 78 before listening. The temp dir is deleted afterwards. Direct insertion of the row is test-only and allowed here because the credentials are fake and every operation the adapter needs is excluded; say so in the PR.

Inputs: BU-1 (`wireSelfCheck`), BU-2 (`buildOutbound`, `transport.selfcheck` log line, lock state), `apps/web`, `scripts/next-build-stable.test.ts` (pattern for running next under flock), `packages/db` (migrate, open).

Outputs: `scripts/next-start-proof.mjs`; `scripts/next-start-proof.test.ts` (unit: the log-line parser and the verdict rules on canned lines); `scripts/next-start-proof.integration.test.ts` (runs the script; skipped with a printed reason only if `next` is not installed).

Order: commit 1 is the two test files and canned log lines, run red; then the script.

Acceptance tests:

- `corepack pnpm vitest run --project unit scripts/next-start-proof.test.ts`: parser and verdict rules pass on canned good and bad logs.
- `corepack pnpm vitest run --project integration scripts/next-start-proof.integration.test.ts` (several minutes): `server listened (no exit 78)`; `transport.selfcheck: impl node-https, env_override false, builtins_intact true`; `global_fetch_changed_since_load is recorded` (expected true; the value goes into the evidence either way); `every sandbox.send line is blocked:no_approval for oauth_token; none has outcome response or network_error`; `every provider_calls row is blocked`; `no stdout or stderr line contains the fake secret or the fake client id`; `with NODE_OPTIONS=--require the process exits 78 with transport_env_override before listening`.
- `corepack pnpm lint && corepack pnpm typecheck`: exit 0. The working tree is clean after the run (`git status --porcelain` empty).

Do not: use real credentials, a real approval row or the owner's data directory; run `next build` outside the flock; leave the server running; add the proof to `pnpm test` (it is opt-in: `corepack pnpm vitest run --project integration scripts/next-start-proof.integration.test.ts`); change `apps/web`, `packages/*` or lint config (a needed change is a stop-and-report to BU-2).

Evidence for the PR: the parsed verdict table; the `transport.selfcheck` line; the value of `global_fetch_changed_since_load`; build and start times; the exit-78 line.

Branch: `feat/web-next-start-proof` Commit: `test(web): next start proof of the sandbox boot and wire, offline (BU-3)`
