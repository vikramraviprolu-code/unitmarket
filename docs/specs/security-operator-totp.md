# CO-6: operator TOTP (RFC 6238) so refunds and switch changes have a second factor

Task: operators sign in with the passcode plus a TOTP code; only such a session carries `mfa: true`, which refunds (CO-4), switch-on and the refund route (CO-8) require.
Package: `packages/security` (`totp.ts`, `session.ts`), `packages/config`, `apps/web` (sign-in) Owner: Sonnet 5.5 builder, effort high (operator auth gates money) Reviewer: Opus 5.5 high; Sakthi merges
Wave: W3, after BU-2 merges (config and composition). Assumptions: ASM-56 (new), ASM-30. Requirements: nfr.md SOP 4, P9, threat 8; architecture 9.8; C-08.

Goal: `totp.ts` implements RFC 6238 over `node:crypto` (HMAC-SHA1, 30 s step, 6 digits, accept the current step and one either side, constant-time compare). A step already used by that operator is refused (replay): the used step is recorded as an `audit_log` row (`operator.totp_used`, operator id, step) and checked before acceptance, so no migration is needed. Keys come from `UMS_OPERATOR_TOTP_KEYS` (host settings or `.env.local`), format `vikram:<base32>,sakthi:<base32>`, parsed once by `packages/config` into `Secret` values; each key at least 20 bytes; a malformed value refuses boot. Sign-in for the `operator` persona takes operator name, passcode and code; right passcode and right code give an operator actor with `mfa: true` and `operator_id` `opr_<name>`; with no keys configured an operator signs in with `mfa: false` (can view and stop, cannot refund or turn a switch on). Operator sessions end after 30 min idle and 8 h absolute (already in sessions; tests prove it for operators). Wrong codes share the passcode limiter (5 per 15 min). `scripts/totp-enrol.mjs`: TTY only, refuses in CI and AI sessions, generates 20 random bytes, prints the base32 secret and an `otpauth://` URI once to the terminal for the operator's authenticator app, writes no file and logs nothing.

Inputs: `packages/security/src/{session.ts, passcode.ts, rate.ts}`, `packages/config/src/{schema.ts, load.ts, secret.ts}`, composition `engine.signIn`, `apps/web/src/app/signin/*`, RFC 6238 appendix B vectors.

Outputs: `packages/security/src/{totp.ts, session.ts}`, `packages/config/src/{schema.ts, load.ts}`, `.env.example` (name only), `apps/web/composition.server.ts` (sign-in wiring only), `apps/web/src/app/signin/{page.tsx, SignInForm.tsx}`, `scripts/totp-enrol.mjs` and its test, tests below.

Order: commit 1 is tests only, run red; then implement.

Acceptance tests:

- `corepack pnpm vitest run --project unit packages/security/src/totp.test.ts scripts/totp-enrol.test.ts`: RFC 6238 SHA1 vectors truncated to 6 digits (T=59 gives 287082, T=1111111109 gives 081804); steps -1, 0, +1 accepted, -2 and +2 refused; the enrol tool refuses without a TTY and prints a URI with `issuer=UnitMarket%20Sandbox`.
- `corepack pnpm vitest run --project state packages/security/src/totp.state.test.ts`: a used step is refused the second time; idle 30 min ends an operator session; no keys gives `mfa: false`.
- `corepack pnpm vitest run --project integration apps/web/src/operator-mfa.integration.test.ts`: operator without a code gets `mfa: false` and refunds answer 403; with a right code `mfa: true`; switch-on without MFA is refused (C-08).
- `corepack pnpm vitest run --project adversarial packages/security/src/totp.adversarial.test.ts`: six wrong codes lock the persona bucket; a code for another operator's key is refused; timing of right and wrong codes is compared with `timingSafeEqual` (spy); no log line or audit row holds a key or a code.
- `corepack pnpm test:e2e -- operator-mfa.spec.ts` (offline, fixed fake key): sign-in with a generated code reaches `/ops` with refunds enabled.
- `corepack pnpm ci && corepack pnpm check:secrets-names`: exit 0.

Do not: store TOTP keys in the database or a file; send codes by email or SMS; add a dependency (no otp library); change buyer sign-in; touch payments.

Evidence for the PR: red summary; pass counts; the RFC vector table; a screenshot of the sign-in form without any secret.

Branch: `feat/security-operator-totp` Commit: `feat(security): operator TOTP sign-in, mfa flag for refunds and switches (CO-6)`
