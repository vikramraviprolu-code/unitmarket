# Open a PayPal sitting from Operations Controls (OPS-SW-P, D-120)

Task: let an operator turn PayPal sandbox on from Controls without gcloud, a redeploy or a terminal.
Package: `packages/safety`, `apps/web`, `infra/gcp` Owner: Vikram Reviewer: Sakthi

Goal: before this lane a sitting needed `UMS_PAYPAL_CONNECT=on` set by gcloud, an approval row from
`pnpm safety:approve` at the owner's terminal, and a new `UMS_OUTBOUND_APPROVAL_REF` secret per sitting
(the reference is unique and the gate read only the configured one). After it: an operator signed in with
the authenticator code presses "Open a PayPal sitting", which writes the approval row with the D-094
ceiling fixed in code (5 operations, 500 minor units per order, 40 calls, 4 hours) under
`<configured ref>~<UTC stamp>`; then Start turns `paypal_outbound` on as before. The connect flag is on in
`service.yaml`. Stop, the four-hour end and `cloud:down` still stop every call.

Outputs: `packages/safety/src/{sitting.ts,budget.ts,status.ts,index.ts}`, `apps/web/composition.server.ts`,
`apps/web/src/app/api/ops/sitting/route.ts`, `apps/web/src/app/ops/{OpenSittingButton,KillControls}.tsx`,
`apps/web/src/lib/ops-copy.ts`, `infra/gcp/{service.yaml,deploy.sh,service-offline.yaml}` (and their
fixtures), `scripts/check-hosting-gcp.mjs`, tests listed below, `docs/owner/CLOUD-RUNBOOK.md`, D-120.

Acceptance tests:

- `corepack pnpm vitest run --project state packages/safety/src/sitting.state.test.ts`: 10 passed
  (ceiling, refusals, one at a time, literal reference match, gate allows 500 and blocks 501 and refunds).
- `corepack pnpm vitest run --project state apps/web/src/ops-sitting.state.test.ts`: 3 passed (open then
  Start with no PayPal call; second press 409; no code, publisher, no session, no CSRF, extra field refused).
- `corepack pnpm vitest run --project adversarial apps/web/src/app/api/v1/scope-a.adversarial.test.ts`:
  no API key of any scope opens a sitting; the approval count is unchanged.
- `node scripts/check-hosting-gcp.mjs`: `hosting-gcp ok`; `scripts/check-hosting-gcp.test.ts` passes.
- `corepack pnpm typecheck`, `corepack pnpm lint`: exit 0.

Do not: add a live value anywhere; let the request body carry any limit; touch the transport or the
PayPal adapter.
Branch: `claude/project-thread-iacv0t` (PR 84) Commit: `feat(safety): open a PayPal sitting from Controls (OPS-SW-P)`
