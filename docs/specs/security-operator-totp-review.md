# CO-6b: follow-ups from the Opus review of CO-6 (operator TOTP)

Task: close the review findings L1, L2, L3, M1 and the runbook note for operator TOTP.
Package: `packages/security` (plus docs and `package.json`) Owner: Sonnet 5.5 builder Reviewer: Opus 5.5; Sakthi merges
Goal: after a step S is accepted for an operator, no code with a step at or below the highest used step of that operator is accepted (reuse and an older unused S-1 are both refused); mfa on a resolved session needs an mfa signature and a named operator row; the CO-6 spec matches the code; operators have a `totp:enrol` script and a runbook note.

Inputs: `packages/security/src/{totp.ts, session.ts}` and their tests, `docs/specs/{security-operator-totp.md, mvp-c-offline-gate.md}`, `docs/owner/`, `package.json`.

Outputs, exactly these changes:

1. L1 `totp.ts` (`acceptTotp`): inside the existing transaction and advisory lock, read the highest `operator.totp_used` step of the operator; accept only a candidate step above it; otherwise `replay`.
2. L2 `session.ts` (`resolveSessionRecord`): `mfa = verified.mfa && actor_id !== 'opr_demo'`. A named row with a plain signature stays a non-mfa session; an `opr_demo` row never gets mfa.
3. L3 `docs/specs/security-operator-totp.md`: Outputs list `apps/web/src/app/api/session/route.ts` and the config constraints (no key named `demo`, unique keys, max 8 operators); note the per-operator failure bucket (5 per 15 minutes).
4. `package.json`: script `totp:enrol` = `node scripts/totp-enrol.mjs`.
5. M1 `docs/specs/mvp-c-offline-gate.md`: the C-08 bullet also requires "switch-on without mfa is refused" through the public path in `tests/mvp-c/c08-c09-operator-headers.integration.test.ts` (spec text only; the test is a later lane).
6. `docs/owner/MVPC-OWNER-NOTES.md`: section "Operator TOTP keys" (host settings and own `.env.local` only, never the cloud session; who enrols; revoke sessions or rotate `UMS_SESSION_SECRET` after removing a key; rotate `UMS_DEMO_PASSCODE_HASH` to clear a demo-passcode lockout).
7. Tests (commit 1, red): `totp.state.test.ts`, `totp.adversarial.test.ts`, `session.state.test.ts`.

Acceptance tests:

- `corepack pnpm vitest run --project state packages/security/src/totp.state.test.ts`: older unused code after a newer accept refused; same code refused; later step accepted.
- `corepack pnpm vitest run --project adversarial packages/security/src/totp.adversarial.test.ts`: four parallel sign-ins with one code give exactly one accept; parallel older codes give none.
- `corepack pnpm vitest run --project state packages/security/src/session.state.test.ts`: `opr_demo` row with an mfa signature has `mfa: false`; named row with a plain signature `mfa: false`.
- `corepack pnpm totp:enrol --operator x < /dev/null`: refuses (no TTY), prints no secret, exit non-zero.
- `corepack pnpm lint && corepack pnpm typecheck && corepack pnpm test && corepack pnpm check:isolation && corepack pnpm check:no-live-host && corepack pnpm check:secrets-names && corepack pnpm check:routes && corepack pnpm format:check`: exit 0.

Do not: touch other packages or tests; add a dependency; change contracts or the audit table; put a key or code anywhere.
Evidence for the PR: red summary of commit 1, green summary, diff stat.
Branch: `fix/operator-totp-review` Commit: `type(security): <what> (CO-6b)`
