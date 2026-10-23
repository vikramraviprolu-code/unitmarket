# BU-1: production Wire on node:https (N5 fix)

Task: replace the fetch-based production Wire with a `node:https` Wire that does not depend on `globalThis.fetch`, so the Next.js fetch patch can neither stop nor redirect it.
Package: `packages/transport` Owner: Sonnet 5.5 builder, effort high (production network path) Reviewer: Opus 5.5 high; Sakthi merges
Wave: W1, after `fix/mvpb-seal4` (S4) merges. Assumptions: ASM-35, ASM-50 (new), ASM-33.

Goal: today `wire-fetch.ts` captures `globalThis.fetch` and the undici dispatcher when it loads and refuses every request when either differs (SEAL3 M-C). Next.js patches `globalThis.fetch` when its route modules load, which is after our module loads, so the Wire would fail closed on every call, or, if the baseline were taken later, send through Next's wrapper. The new Wire calls `https.request` captured at load with its own `https.Agent` (keep-alive off), `dns.lookup` and `tls.connect` captured at load, `rejectUnauthorized: true`, `minVersion: 'TLSv1.2'`, `servername` equal to the host, a 3 s connect timeout and a 10 s total deadline (architecture 7.6), a 1 MiB streamed response cap, and no redirect following. It rechecks the env and `execArgv` override list before every request (unchanged list) and refuses if any captured builtin was replaced. `wireSelfCheck()` reports, without any I/O: `{ impl: 'node-https', env_override, builtins_intact, global_fetch_changed_since_load }`.

Inputs: `packages/transport/src/{wire.ts, wire-map.ts, wire-fetch.ts, sandbox.ts}` as on main after S4 (`PRODUCTION_WIRE` symbol); `scripts/override-lists.test.ts`; architecture 7.6; READINESS SEAL2 M3, SEAL3 M-C.

Outputs: `packages/transport/src/wire-https.ts` (exports `createHttpsWire()`; internal `makeHttpsWire(deps)` used only by its tests), `wire-selfcheck.ts`, `sandbox.ts` (`pickWire(PRODUCTION_WIRE)` returns `createHttpsWire()`; nothing else changes), `index.ts` (adds `wireSelfCheck`); `wire-fetch.ts`, `wire-fetch.test.ts`, `wire-fetch.env.test.ts` deleted; tests listed below; `eslint.config.mjs` (the `WIRE_FETCH` constant and its exemption entry renamed to the https file, nothing else); `scripts/lint-rules.test.ts` and `scripts/override-lists.test.ts` (path only); `tests/mvp-b/sealed-callers.test.ts` (wire file and function names only: still "only sandbox.ts imports the production Wire file").

Order: commit 1 is tests only (the files below plus the edited pins), run red, failing summary saved in the PR. Then implement.

Acceptance tests (run as `PATH=/tmp/claude-0/shim:$PATH corepack pnpm ...`):

- `corepack pnpm vitest run --project unit packages/transport/src/wire-https.test.ts packages/transport/src/wire-selfcheck.test.ts`: all pass, including `non-https, userinfo, port and fragment refused before any request`, `3xx is returned as a response and its Location is never requested`, `body over 1 MiB gives too_large and the socket is destroyed`, `total deadline gives timeout`, `error codes map: ENOTFOUND dns, ECONNREFUSED connect, CERT_* and ERR_TLS_* tls, ECONNRESET reset`, `selfcheck makes no I/O and names node-https`.
- `corepack pnpm vitest run --project contract packages/transport/src/wire-https.contract.test.ts`: the options handed to the request function carry `rejectUnauthorized: true`, `minVersion: 'TLSv1.2'`, `servername` = host, the own agent, the captured lookup, and only the allow-listed headers.
- `corepack pnpm vitest run --project adversarial packages/transport/src/wire-https.adversarial.test.ts`: `globalThis.fetch replaced after load: the wire still works and the fetch spy is called 0 times`; `undici global dispatcher replaced: no effect`; `https.request, tls.connect or dns.lookup replaced after load: refused other, zero calls to the replacement`; `NODE_OPTIONS or --import set after boot: refused other`.
- `corepack pnpm vitest run --project integration packages/transport/src/sandbox-https.integration.test.ts`: approved transport over `makeHttpsWire` with a fake request function: one send per allowed request, none for a blocked one.
- `grep -rnE "\bfetch\(" packages/transport/src --include=*.ts | grep -v '\.test\.ts'` prints nothing.
- `corepack pnpm lint && corepack pnpm typecheck && corepack pnpm test && corepack pnpm check:isolation && corepack pnpm check:no-live-host`: exit 0. `tests/mvp-b/sealed-callers.test.ts`, `scripts/lint-rules.test.ts`, `scripts/override-lists.test.ts` pass.

Do not: open a socket in any test (spy `net.connect`, `tls.connect`, `http(s).request`, `dns.lookup`, `globalThis.fetch`: zero real calls); use a real certificate or commit a private key; change the override list, the guard, the scope tables or the approval capability; touch composition or `apps/web`; add a dependency; touch `docs/decision-log.md`.

Evidence for the PR: red run summary; each acceptance command with pass counts; `wireSelfCheck()` output from a unit test; the pin diffs in the three pinned tests, each with one line saying why (this spec renames the file).

Branch: `feat/transport-https-wire` Commit: `feat(transport): node:https production wire, no fetch dependency (BU-1)`
