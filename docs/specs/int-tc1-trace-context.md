# Spec: one trace context store per process (INT-TC1)

Task: every write made by the running app (`next start`) carries the trace context of the request, job pass or boot step that made it. After the e2e journeys, INV-T2 must be empty.
Package: `packages/obs` (a new `src/trace-store.ts`, `src/trace-context.ts` and its existing test), plus the lint exemption in `eslint.config.mjs` and its pin in `scripts/lint-rules.test.ts`. Another file changes only under step 4, and the PR names it.
Builder: Sonnet 5.5. Reviewer: Opus 5.5 gate. Branch: `feat/obs-trace-context`.
Commit: `fix(obs): one trace context store per process (INT-TC1)`.
Source: OPS-B gate FU1 (`ops-b-build-scorecard.md`). The count is 223 unattributed rows on main 2cf0847 and on 1192493, across `access_events`, `access_windows`, `approvals`, `audit_log` and more. Sign-in alone gives 2.

## Root cause

This is the architect's reading. The builder confirms it red first.

- `packages/obs/src/trace-context.ts` holds the store as a module-level `new AsyncLocalStorage()`.
- Next bundles `@umsbx/obs` (`transpilePackages`) into each server compilation, so a process can hold more than one copy of that module.
- `src/instrumentation.ts` builds the app first through `getApp()`. That app is a singleton kept on `globalThis`. `composition.server.ts:3543` already says the bundler duplicates modules.
- So the app's `withTraceDb(..., currentTraceContext, ...)` reads the store of the instrumentation copy. `withRoute` opens each request's context in the copy of the route bundle. The database wrapper never sees that context.
- Every route write therefore reaches the capture trigger without `ums.trace`, and the trigger stores it as `unattributed`.
- Job passes and the boot seed are attributed, because they run in the instrumentation copy or pass an explicit context.
- Vitest loads one module graph, so no unit or state test could see the split.

## Fix

Keep one store per process, and keep the `globalThis` access in one tiny file (gate F1, 5 Nov). Lint bars `globalThis` aliasing (`sbx/no-global-alias`, `no-restricted-syntax`, S2), so the access needs a named exemption, the way `apps/web/src/server/singleton.ts` already has one (D-015).

- New `packages/obs/src/trace-store.ts` exports one function, `traceStore(): AsyncLocalStorage<TraceContext>`. It reads or creates `globalThis[Symbol.for('umsbx.obs.traceStore')]` and touches no other key.
- `trace-context.ts` replaces its module-level `new AsyncLocalStorage()` with `traceStore()`. It reads the store in each function rather than keeping it in a module constant.
- `eslint.config.mjs` gets a `NAMED_EXEMPTIONS` entry: `files: ['packages/obs/src/trace-store.ts']`, `reason: 'process-wide trace context store shared by bundle copies (globalThis Symbol key, reads only its own key)'`, `off: ['sbx/no-global-alias', 'no-restricted-syntax']`.
- The pinned list in `scripts/lint-rules.test.ts` gains the line `'packages/obs/src/trace-store.ts -> no-restricted-syntax,sbx/no-global-alias'`.
- The public API (`withTraceContext`, `currentTraceContext`, `extendTraceContext`, `bindTraceMandate`) and its behaviour do not change.

## Acceptance tests

Write the tests first. Commit 1 holds only the test, run red.

1. Add a `describe` block to the existing `packages/obs/src/trace-context.test.ts`:
   - The test imports the module, calls `vi.resetModules()`, then imports it again, so it holds two copies.
   - A context opened with copy A's `withTraceContext` is returned by copy B's `currentTraceContext`. The same holds for `extendTraceContext` and `bindTraceMandate`.
   - Outside a context both copies return `undefined`.
   - Command: `corepack pnpm vitest run packages/obs/src/trace-context.test.ts`. Expected: red on main, all passed after the fix.
2. Reproduce on main first, then check after the fix:
   - Environment (gate F3): `trace:verify` needs the same synthetic `UMS_SESSION_SECRET`, `UMS_APPROVAL_SECRET` and `UMS_LINK_SECRET` that `apps/web/playwright.config.ts` sets for the server. Export them from that file's values, which are test values, not credentials. In the container, set `PLAYWRIGHT_BROWSERS_PATH` to a directory where `chromium_headless_shell-1194` is symlinked from `/opt/pw-browsers`.
   - Run `UMS_DB=pglite-disk UMS_PGLITE_DIR=$(mktemp -d) corepack pnpm test:e2e -- journeys.spec.ts purchase-reader-statement.spec.ts`. Stop the server, then run `corepack pnpm trace:verify` with the same env.
   - Expected on main: INV-T2 lists about 223 rows. Paste the count per table.
   - Expected after the fix: exit 0, INV-T2 empty.
3. Sign-in alone: run the same env with `accounts.spec.ts` (or a sign-in only run), then `trace:verify`. Expected: 0 unattributed. Today the result is 2 `audit_log` rows.
4. Residual rows. If INV-T2 is not empty after the fix, trace each remaining row to its write path. Give it the context it already belongs to (the route's, a job's `jobContext`, or the boot `bootCtx`) and add a test for it. List each one in the PR with file and line.
   - If a residual write happens before the actor is known, stop and report it to the architect. Do not invent an actor kind. `ACTOR_KINDS` does not change.
5. `corepack pnpm lint`, `typecheck`, `test`, `check:isolation`, `check:no-live-host` and `check:secrets-names` all pass. `corepack pnpm vitest run scripts/lint-rules.test.ts` passes with the new pinned line. `packages/obs/src/trace-context.ts` itself has no exemption, and lint still passes on it.

## Do not

- Do not change trigger SQL, migrations, `withTraceDb`, `packages/contracts` or any e2e spec.
- Do not add a dependency.
- Do not make any network or PayPal call. Stay in offline mode.

## Evidence for the PR

- The red and green output of test 1.
- The INV-T2 counts from tests 2 and 3, before and after.
- The `trace:verify` line after the fix.
- Wall time of the e2e run, before and after. Writes now open a short transaction for `set_config`, so the cost appears for the first time.
