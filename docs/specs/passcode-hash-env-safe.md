# BU-6c: passcode hash survives `.env.local` loaders, and a mangled one fails loudly

Task: store the demo passcode hash without any `$`, accept both forms when verifying, and refuse a malformed hash at boot.
Package: `packages/security`, `packages/config`, `scripts/owner-secrets` (plus one sentence in `docs/owner/MVPB-OWNER-STEPS.md`) Owner: Sonnet 5.5 builder Reviewer: Opus 5.5 high; Sakthi merges
Branch: `fix/passcode-hash-env-safe` Commit: `type(<package>): <what> (BU-6c)`

Goal: on the owner's first run (2026-10-24) the hash `scrypt$16384$8$1$<salt>$<key>` (114 characters) was stored by `owner:secrets` as `UMS_DEMO_PASSCODE_HASH` in `.env.local`. Next.js loads `apps/web/.env.local` with dotenv-expand, which reads `$16384` as a variable reference: the value loaded as `scrypt6384`, so sign-in under `next start` always failed, while Node's `--env-file` (the safety CLI) kept the raw value. Fix: the stored form becomes `scrypt:N:r:p:salt_hex:hash_hex` (colons, no `$`). `hashPasscode` and `owner:secrets` emit it. `verifyPasscode` accepts the new form and the old `$` form (existing tests, fixtures, a hash exported in the shell or set in a host dashboard). `loadConfig` refuses `UMS_DEMO_PASSCODE_HASH` when it matches neither shape, in every mode: `invalid_value`, naming the variable, never the value. Behaviour is otherwise identical (limits, NFKC, timing-safe compare, sign-in, personas).

Inputs: `packages/security/src/passcode.ts`, `packages/config/src/load.ts`, `scripts/owner-secrets.mjs`, `@next/env` 15.5.28 already in `node_modules` (read in a test only; no new dependency).

Outputs: `passcode.ts` (separator-agnostic parse, new emit form); `packages/config/src/load.ts` (shape check; `config` may import only `contracts`, so it keeps its own copy of the shape, pinned against `hashPasscode` output by the integration test); tests; `config.test.ts` line 150 changes `scrypt$x` (no longer a valid hash) to a well-formed hash, which contradicts the new rule and is the only edit to an existing test besides the `owner-secrets.test.ts` regex; `docs/owner/MVPB-OWNER-STEPS.md` step 1 (one sentence).

Acceptance tests (commit 1 is tests only, run red; then green):

- `corepack pnpm vitest run --project unit packages/security/src/passcode.test.ts`: new hash has no `$`, matches `^scrypt:16384:8:1:<32 hex>:<64 hex>$`; verify accepts new and old forms; rejects wrong passcode, tampered key, wrong field counts, mixed separators, zero or huge N/r/p in both forms.
- `corepack pnpm vitest run --project contract packages/config`: `UMS_DEMO_PASSCODE_HASH=scrypt6384` (and other mangled values) gives `invalid_value` naming only the variable; both forms and an unset value boot.
- `corepack pnpm vitest run --project integration scripts/passcode-env-load.integration.test.ts`: a temp `.env.local` with a new-form hash loaded by `@next/env` `loadEnvConfig` keeps the value unchanged, and `verifyPasscode` accepts the passcode; the old form loads as `scrypt6384` (documents the bug) and `loadConfig` refuses it.
- `corepack pnpm vitest run --project unit scripts/owner-secrets.test.ts`: the printed hash is the new form and verifies.
- `corepack pnpm lint && corepack pnpm typecheck && corepack pnpm format:check` and the `check:*` scripts: exit 0.

Do not: add a dependency; touch `eslint.config.mjs`, `docs/decision-log.md`, `docs/ASSUMPTIONS.md`; print or store a real passcode or hash; connect to PayPal.

Evidence for the PR: red run of commit 1, green runs, mutation score on the parse and shape code, gitleaks result.
