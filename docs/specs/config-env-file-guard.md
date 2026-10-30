# Spec: refuse a process environment that silently overrides `.env.local` (F8, D-059)

Task: on 29 Oct 2026 a terminal that still held `DATABASE_URL`, `UMS_DB` and `UMS_PAYPAL_CONNECT` overrode the
owner's `.env.local`. The rehearsal app and two `safety` commands reached the hosted database instead of the
laptop one. Node's `--env-file-if-exists` and Next never replace a value that is already in the process
environment, and nothing told the owner. Make the boot refuse that situation.
Package: `packages/config` (plus one comment in `.env.example` and one paragraph in `docs/READINESS.md`)
Owner: builder (Sonnet) Reviewer: Opus, one round (D-048); the coordinator merges.
Branch: `feat/config-env-file-guard` Commit: `feat(config): refuse a process environment that overrides .env.local (F8)`
Decisions: D-059, D-060.

Goal: `loadConfigFromProcess()` (the one loader used by the web app, the safety tool and the conformance runner)
refuses to boot when a `.env.local` file exists in the current folder and, for any of the guarded names below, the
value in `process.env` differs from the value in that file. The refusal names the variable, never a value.

Guarded names: `UMS_MODE`, `UMS_PAYPAL_CONNECT`, `UMS_DB`, `UMS_PGLITE_DIR`, `DATABASE_URL`,
`UMS_OUTBOUND_APPROVAL_REF`, `UMS_OUTBOUND_SCOPE`, `UMS_OWN_MERCHANT_ID`, `UMS_PUBLIC_ORIGIN`.

Rule (decided; do not widen): for each guarded name, refuse when the process holds a value and the file either
holds a different value or does not define the name. Do not refuse when the process holds no value (the file was
not loaded, as in tests). Do not refuse when no `.env.local` exists (the hosted app has none). All other names,
including every secret, are never compared. The check runs in every mode, offline included (the rehearsal ran offline).

Requirements (tests first, commit 1 holds only tests, run red; then implement to green):

1. New refusal code `env_overrides_file` in `refusal.ts`; same exit code 78; the line names the variable and says to
   unset it in this terminal (`env -u NAME`) or fix the file.
2. A pure function `findEnvOverride(env, fileText)` returning the first guarded name that violates the rule, or
   `null`. It parses the file with `util.parseEnv` from `node:util` (the same parser as `--env-file`).
3. `loadConfigFromProcess(opts?)` reads `.env.local` from `process.cwd()` through an injectable reader
   (`opts.readEnvFile`), default `fs.readFileSync` returning `null` when the file is missing, and refuses with the
   code above before `loadConfig` runs. `loadConfig` itself stays pure and unchanged.
4. Tests cover: equal values pass; `UMS_DB` differs; `DATABASE_URL` set in the process and absent from the file;
   process value absent and file value present passes; no file passes; quoted values and comments parse as
   `util.parseEnv` does; non-guarded names (`NODE_ENV`, `PATH`, the three secrets) never refuse; the refusal line
   and the returned object contain the name and never a value (use a value that looks like a URL with a password);
   exit code 78 through `bootOrExit`.
5. Check how the hosted image is built (`Dockerfile`, `.dockerignore`, `infra/gcp`): confirm no `.env.local`
   can end up in the image, and say so in your evidence. If one can, stop and report; do not change infra.
6. `.env.example`: one comment line under the mode setting. `docs/READINESS.md`: one paragraph naming the guard and
   the nine names. Nothing else in the owner steps changes; the coordinator updates them.

Acceptance (run, paste output): `corepack pnpm exec vitest run --maxWorkers=2 packages/config`; `corepack pnpm lint`;
`corepack pnpm format:check`; `corepack pnpm typecheck`; `corepack pnpm check:isolation`;
`corepack pnpm check:secrets-names`; `corepack pnpm check:no-live-host`. Plus one scratch demonstration in a temporary
folder outside the repository (a fake `.env.local` holding only `UMS_DB=pglite-memory`, then `UMS_DB=postgres` in the
process) showing the refusal line with no value in it.

Do not: touch another package or an existing test except to add cases; add a dependency; change a contract; read,
create or print any real secret or the real `.env.local`; contact any network or PayPal; run the app against any
settings; run `pkill`; run a suite without `--maxWorkers=2`.
Disk: about 2.5 GB free; run `df -h /home` before heavy steps and stop under 400 MB; remove only your own temp folders.
Evidence: commands with output, the scratch demonstration, the Dockerfile finding, a cost line.

Known limits (review of 30 Oct 2026): Next also loads `.env.development.local`, `.env.production.local` and `.env`; a
guarded name set there and not in `.env.local` is refused (the guard fails closed). Next expands `$NAME` inside values
while `util.parseEnv` does not, so a guarded value containing `$` (for example a database URL password) is refused
falsely; remove the `$` or quote the value. Cloud Run passes only because the image has no `.env.local`.

Review fixes (coordinator approved the extra files): F1 `defaultReadEnvFile` and its `node:fs` import moved from `load.ts`
to `packages/config/src/env-file.ts`, listed in `FS_ALLOWED` in `scripts/maintenance-flag.test.ts`. F2 the tests that spawn
the safety CLI or the conformance runner use their own temp folder as `cwd` instead of the repository root, so a real
`.env.local` there cannot trip the guard: `scripts/safety-launch.test.ts`, `scripts/safety-cli.test.ts`,
`scripts/sandbox-conformance.integration.test.ts`, `scripts/safety-cli.postgres.integration.test.ts`.
