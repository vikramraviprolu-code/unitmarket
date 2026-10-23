# MVP-B unseal and MVP-C offline: lane plan, risks, critique

Status: PROPOSED, 23 Oct 2026. Author: architect (Opus 5.5, high effort). Reviewers: Vikram (owner), Sakthi.
Baseline read: `main` at 19f45f7, plus the in-flight branch `fix/mvpb-seal4` (head 954db53 and its
working tree). Nothing in this document authorises a PayPal call, an account, a credential, a
deployment or the unseal itself. Specs live in `docs/specs/` (one per lane, listed below).

Inputs: `CLAUDE.md`, `docs/ASSUMPTIONS.md`, `docs/design/{architecture,mvp-plan,nfr,hosting}.md`,
`docs/design/lanes/*`, `docs/READINESS.md`, `docs/decision-log.md` (to D-023 on main; D-024 on seal4),
`docs/owner/*`, and the code in `packages/{transport,safety,paypal,jobs,testkit,db,config,security}`,
`domain/payments`, `apps/web`, `tools/spike-kit`, `tests/mvp-a`, `tests/mvp-b`.

## 1. What is already done, so the lanes do not redo it

Read from the code, not from the plan:

- The approved sandbox transport exists (`createApprovedSandboxTransport`), sealed behind a capability
  that only `@umsbx/safety` `createScopedGate` mints from a live `outbound_approvals` row. Scope caps
  operations (`SCOPE_OPERATIONS`) and currencies (`SCOPE_CURRENCIES`). Composition still builds the
  zero-argument stub; `tests/mvp-b/sealed-callers.test.ts` pins that.
- `fix/mvpb-seal4` replaces the `'production'` string sentinel with a `PRODUCTION_WIRE` unique symbol,
  makes the minter factory module-private, and amends A-26 (D-024). Every B lane below builds on that
  shape; no spec names the old `'production'` string.
- Domain refunds (`domain/payments/src/refunds.ts`) already send an explicit amount on every
  `refundCapture` call (null means "the remaining amount, fixed at request time"), book only after
  GET refund plus an order read, and revoke access on a full refund. Gaps: no operator MFA check, no
  booking of a dashboard partial refund amount (no list of a capture's refunds), no check against
  PayPal's own remaining amount before sending.
- Polling exists: `runDue` (backoff, 5 h resend limit, 24 h window), abandonment sweep, hourly re-read
  of paid orders for 7 days, startup recovery. Nothing budgets these calls against the approval's
  daily call cap.
- `UMS_TRUSTED_PROXIES` exists (D-022); a hosted demo only has to set it.
- **Gap found: in sandbox mode nothing can turn `paypal_outbound` on.** The migration seeds it off,
  the offline seed only flips it in `offline` mode, `scripts/safety-cli.mjs` has `status`, `stop` and
  `approve` only, and `setSwitch` needs an operator with `mfa: true`, which web sign-in never gives.
  Lock L4 below can therefore never open today. BU-2 adds `pnpm safety:resume` (TTY, owner).
- **Gap found: no passcode-hash or secret generator for the owner.** `UMS_DEMO_PASSCODE_HASH` and the
  three 32-byte secrets have no helper; BU-6 adds `scripts/owner-secrets.mjs`.
- `webhook_events` table exists (unique `event_id` and `transmission_id`). `verifyWebhook` is a stub
  that always answers `unverifiable`.
- The owner-run conformance file `packages/paypal/src/paypal.sandbox.contract.test.ts` exists and is
  skipped unless `UMS_SANDBOX_TESTS=1`; its subject uses a fixed clock and has no way to show the owner
  the approval link.

## 2. The five locks (the term every B spec uses)

An outbound PayPal call from the app needs all five, checked at the time of the call, any one missing
means `blocked` and no byte leaves (architecture 7, CLAUDE.md rules 1 to 3, ASM-30 to ASM-34):

| Lock | What | Where it is checked |
| ---- | ---- | ------------------- |
| L1 | `UMS_MODE=sandbox` | config boot; `createOutboundGate` (`connect_off`) |
| L2 | `UMS_PAYPAL_CONNECT=on` | config boot; `createOutboundGate` (`connect_off`) |
| L3 | An active `outbound_approvals` row for `UMS_OUTBOUND_APPROVAL_REF` whose scope, operations, amount cap and daily budget cover the call (inserted only by `pnpm safety:approve`, TTY, not CI) | `createScopedGate` (capability), gate `check()` per request |
| L4 | `paypal_outbound` switch on (the kill switch; rows are append-only so this is how an approval is revoked) | gate `check()` per request; job loop pause |
| L5 | Sandbox credentials present in the process environment, and no proxy, trust-store or loader override in env or `execArgv` | config boot (`transport_env_override`); the production Wire before every request |

Under the five sit the fixed controls that are not switches: the host constant, the egress guard,
the scope operation list, the amount binding and the no-live-host checks.

## 3. Lane DAG

Ids: `BU-n` (group B-UNSEAL), `CO-n` (group C-OFFLINE). `S4` is the in-flight `fix/mvpb-seal4`.
An arrow means "merges before". `(owner)` marks an owner-only prerequisite.

```
S4 ──► BU-1 ─┐
             ├──► BU-2 ──┬──► BU-3
BU-5 ────────┘   ▲       ├──► BU-6 ──► (owner MVP-B window: MVPB-OWNER-STEPS.md)
     (owner: unseal row D-0xx, for MERGE of BU-2)
                         └──► CO-6 ──► CO-3 ──► CO-8 ──► CO-G ──► (owner MVP-C window)
BU-4 ──► CO-4 ───────────────────────────────────▲  ▲
CO-1 ─────────────────────────────► CO-3         │  │
CO-2 ─────────────────────────────► CO-3         │  │
CO-5 ────────────────────────────────────────────┘  │
CO-7, CO-9, CO-10 ──────────────────────────────────┘ (feed CO-G)
```

Text form: S4 → BU-1. BU-1 and BU-5 → BU-2. BU-2 → BU-3, BU-6, CO-6. CO-6, CO-1, CO-2 → CO-3.
BU-4 → CO-4. CO-3, CO-4, CO-5 → CO-8. CO-8, CO-7, CO-9, CO-10, BU-3 → CO-G.

`apps/web/composition.server.ts` is the merge bottleneck: only BU-2, CO-6, CO-3 and CO-8 touch it, in
that order and never two at once. `eslint.config.mjs` is touched only by BU-1, BU-2 and BU-6, in that
order. `packages/config/src/schema.ts` only by BU-2 then CO-6. `.gitleaks.toml` by nobody (no lane
commits a private key; see CO-1 and BU-1).

Contracts: BU-4 (`paypal.ts`), BU-5 (`config.ts`) and CO-5 (`entitlements.ts`) each change one
contracts file, additively. Each spec is its own contracts change request (lanes README, "Contracts
freeze order"): the Opus reviewer checks every consumer. Only BU-4 may add a new runtime export and
so edit `packages/contracts/src/index.test.ts` (`EXPECTED_EXPORTS`); BU-5 and CO-5 extend existing
schemas and enums only.

## 4. Lanes

Effort follows ASM-41: high for money and safety lanes, medium otherwise. Every lane is test-first
(ASM-45): commit 1 holds only tests and data, is run red and the failing summary goes in the PR.

### Group B-UNSEAL

| Id | Spec | Owns (paths) | Depends on | Effort, why | Parallel |
| -- | ---- | ------------ | ---------- | ----------- | -------- |
| BU-1 | `docs/specs/transport-https-wire.md` | `packages/transport/src/{wire-https.ts, wire-selfcheck.ts, sandbox.ts (pickWire only), index.ts}`, removes `wire-fetch.ts` and its tests, `scripts/override-lists.test.ts`, `eslint.config.mjs` (wire file constant and its exemption entry only), `scripts/lint-rules.test.ts`, `tests/mvp-b/sealed-callers.test.ts` (wire names only) | S4 merged | high: the production network path (N5 fix) | after S4; parallel with BU-4, BU-5, all CO wave 0 |
| BU-2 | `docs/specs/web-unseal-outbound.md` | `apps/web/src/server/outbound.server.ts` (new), `apps/web/composition.server.ts`, `apps/web/src/app/api/ops/stop/route.ts` (new), `apps/web/src/app/ops/page.tsx`, `packages/config/src/{schema.ts,load.ts}`, `.env.example`, `packages/safety/src/{cli-resume.ts, index.ts}`, `scripts/safety-cli.mjs` (`resume`), root `package.json` (`safety:resume`), `eslint.config.mjs` (one pinned exemption), `scripts/lint-rules.test.ts`, `tests/mvp-b/sealed-callers.test.ts`, `tests/mvp-b/unseal*.ts`, `apps/web/src/server/outbound.test.ts`, `apps/web/e2e/ops-stop.spec.ts` | BU-1, BU-5, S4; owner unseal row before merge | high: wires the real transport | no (holds composition, config, eslint) |
| BU-3 | `docs/specs/web-next-start-proof.md` | `scripts/next-start-proof.mjs`, `scripts/next-start-proof.test.ts`, `scripts/next-start-proof.integration.test.ts` | BU-2 | high: the only proof of N5 and the boot override list under `next start` | yes, with BU-6, CO-6 |
| BU-4 | `docs/specs/payments-refund-remaining.md` | `packages/contracts/src/paypal.ts` (additive), `packages/paypal/src/map-order.ts`, `fixtures/paypal/synthetic/refunds_listed__*`, `fixtures/paypal/index.json`, `domain/payments/src/refunds.ts` (send path), its tests | none | high: money | now |
| BU-5 | `docs/specs/jobs-poll-budget.md` | `packages/jobs/src/{loop.ts, budget.ts}`, `domain/payments/src/due.ts`, `packages/contracts/src/config.ts` (additive) | none | high: a starved budget blocks captures | now |
| BU-6 | `docs/specs/testkit-sandbox-subject.md` | `packages/testkit/src/stack.ts` (`sandboxSubject`), `tests/mvp-b/b-l2-sandbox.contract.test.ts` (new, owner-run), `packages/paypal/src/paypal.sandbox.contract.test.ts` (reduced to the guard), `eslint.config.mjs` (one pinned exemption), `scripts/lint-rules.test.ts`, `scripts/{sandbox-conformance.mjs, owner-secrets.mjs}` and their tests, root `package.json` (`sandbox:conformance`, `owner:secrets`), `docs/owner/MVPB-OWNER-STEPS.md` (command check only) | BU-2 | high: owner-run money calls | yes, with BU-3, CO-6 |

Item (f), the owner step list, is delivered by this branch as `docs/owner/MVPB-OWNER-STEPS.md`; BU-6
re-checks every command in it against what merged.

### Group C-OFFLINE

| Id | Spec | Owns (paths) | Depends on | Effort, why | Parallel |
| -- | ---- | ------------ | ---------- | ----------- | -------- |
| CO-1 | `docs/specs/paypal-webhook-verify.md` | `packages/paypal/src/{webhook-verify.ts, crc32.ts, webhook-cert.ts, adapter.ts (verifyWebhook only)}`, `fixtures/paypal/webhooks/**`, `scripts/check-fixtures.mjs` (webhooks dir) | none | high: P1 forgery path | now |
| CO-2 | `docs/specs/payments-webhook-intake.md` | `domain/payments/src/webhooks.ts` (new), `domain/payments/src/index.ts` | none (uses the existing `WebhookVerdict` contract) | high: P2, out-of-order, replay | now |
| CO-3 | `docs/specs/web-webhook-route.md` | `apps/web/src/app/api/webhooks/paypal/route.ts`, `apps/web/src/server/webhook.ts`, `apps/web/composition.server.ts` (wiring), `packages/security/src/route.ts` (raw-body option), `scripts/route-inventory.mjs` pin | CO-1, CO-2, CO-6 | high: public money-adjacent route | no (composition) |
| CO-4 | `docs/specs/payments-refunds-complete.md` | `domain/payments/src/refunds.ts`, `domain/recovery/src/rules.ts` (refund case transitions), tests | BU-4 | high: money | after BU-4 |
| CO-5 | `docs/specs/access-clock-refund-interplay.md` | `domain/access-clock/src/{credit.ts, events.ts, compute.ts}`, `domain/entitlements/src/table.ts`, tests | none | high: access rules | now |
| CO-6 | `docs/specs/security-operator-totp.md` | `packages/security/src/{totp.ts, session.ts}`, `packages/config/src/{schema.ts,load.ts}`, `apps/web/composition.server.ts` (signIn), `apps/web/src/app/signin/*`, `scripts/totp-enrol.mjs`, `.env.example` | BU-2 | high: operator auth gates refunds and the switch | yes, with BU-3, BU-6 |
| CO-7 | `docs/specs/hosting-render-config.md` | `render.yaml`, `scripts/check-hosting.mjs`, `scripts/check-hosting.test.ts`, root `package.json` (`check:hosting`, `ci`), `packages/security/src/proxy.state.test.ts` | none | medium: config as data, checked by a script | now |
| CO-8 | `docs/specs/web-refund-states.md` | `apps/web/src/app/{receipts,library,orders,ops}/**`, `apps/web/src/server/dryrun-model.ts` (refunds), `apps/web/src/app/api/refunds/route.ts`, `apps/web/src/server/refund.ts`, `apps/web/composition.server.ts` (wiring), `apps/web/e2e/refund.spec.ts` | CO-3, CO-4, CO-5, CO-6 | high: operator money route | no (composition) |
| CO-9 | `docs/specs/db-single-opener-and-pg-waiver.md` | `packages/db/src/{pglite.ts, lock.ts}`, `packages/db/src/serial.state.test.ts`, `tests/mvp-c/postgres-refused.integration.test.ts` | none | medium: small, but the waiver rests on it | now |
| CO-10 | `docs/specs/db-backup-restore.md` | `scripts/{backup.mjs, restore.mjs, backup.state.test.ts, restore.integration.test.ts}`, `packages/db/src/export-sql.ts` (import side) | none | medium; first to cut | now |
| CO-G | `docs/specs/mvp-c-offline-gate.md` | `tests/mvp-c/**`, `scripts/c11-restart.integration.test.ts`, `docs/evidence/mvp-c-offline-gate-*.md`, `docs/owner/MVPC-OWNER-STEPS.md`, `docs/READINESS.md` (one section) | all CO, BU-3 | high: gate | last |

### Test matrix per lane (exact files; suite chosen by file name)

| Lane | unit | state | contract | integration | adversarial | golden | e2e |
| ---- | ---- | ----- | -------- | ----------- | ----------- | ------ | --- |
| BU-1 | `packages/transport/src/wire-https.test.ts`, `wire-selfcheck.test.ts` | n/a (no DB) | `wire-https.contract.test.ts` (request shape handed to `https.request`) | `packages/transport/src/sandbox-https.integration.test.ts` (approved transport plus https Wire over a fake request function) | `wire-https.adversarial.test.ts` (fetch, dispatcher, request, lookup and agent swaps) | n/a | via BU-3 |
| BU-2 | `apps/web/src/server/outbound.test.ts` | `tests/mvp-b/unseal-locks.state.test.ts` | `tests/mvp-b/unseal-scope.contract.test.ts` | `tests/mvp-b/unseal-journey.integration.test.ts` (polling journey over a fake Wire) | `tests/mvp-b/unseal.adversarial.test.ts` | `tests/mvp-b/unseal-ops.golden.test.ts` (ops gate block) | `apps/web/e2e/ops-stop.spec.ts` |
| BU-3 | `scripts/next-start-proof.test.ts` (log parser) | n/a (the server's own DB) | n/a | `scripts/next-start-proof.integration.test.ts` (builds and starts) | same file: `NODE_OPTIONS` set gives exit 78 | n/a | it is the e2e |
| BU-4 | `packages/paypal/src/map-order.refunds.test.ts` | `domain/payments/src/refunds.remaining.state.test.ts` | `packages/paypal/src/map-order.refunds.contract.test.ts` | n/a | `domain/payments/src/refunds.remaining.adversarial.test.ts` | n/a | n/a |
| BU-5 | `packages/jobs/src/budget.test.ts` | `domain/payments/src/due.budget.state.test.ts` | n/a | `packages/jobs/src/loop.budget.integration.test.ts` | `domain/payments/src/due.budget.adversarial.test.ts` | n/a | n/a |
| BU-6 | `packages/testkit/src/sandbox-subject.test.ts`, `scripts/owner-secrets.test.ts` | n/a | `tests/mvp-b/b-l2-sandbox.contract.test.ts` (owner-run; offline guard part runs in CI) | `scripts/sandbox-conformance.integration.test.ts` (refusals, child env) | `packages/testkit/src/sandbox-subject.adversarial.test.ts` | n/a | owner window |
| CO-1 | `packages/paypal/src/crc32.test.ts`, `webhook-cert.test.ts` | n/a | `packages/paypal/src/webhook-verify.contract.test.ts` (fixtures) | n/a | `packages/paypal/src/webhook-verify.adversarial.test.ts` | `packages/paypal/src/webhook-message.golden.test.ts` | n/a |
| CO-2 | `domain/payments/src/webhooks.test.ts` | `domain/payments/src/webhooks.state.test.ts` | n/a | n/a | `domain/payments/src/webhooks.adversarial.test.ts` | n/a | n/a |
| CO-3 | n/a | `apps/web/src/webhook.state.test.ts` | n/a | `apps/web/src/webhook.integration.test.ts` | `apps/web/src/webhook.adversarial.test.ts` | n/a | none (no browser) |
| CO-4 | n/a | `domain/payments/src/refunds.complete.state.test.ts` | n/a | `domain/payments/src/refunds.complete.integration.test.ts` | `domain/payments/src/refunds.complete.adversarial.test.ts` | `domain/receipts/src/refund-v2.golden.test.ts` (read-only use of receipts) | via CO-8 |
| CO-5 | `domain/access-clock/src/refund.test.ts` | `domain/access-clock/src/refund.state.test.ts` | n/a | n/a | `domain/access-clock/src/refund.adversarial.test.ts` | n/a | via CO-8; property: `domain/access-clock/src/refund.property.test.ts` (unit project) |
| CO-6 | `packages/security/src/totp.test.ts` (RFC 6238 vectors) | `packages/security/src/totp.state.test.ts` | n/a | `apps/web/src/operator-mfa.integration.test.ts` | `packages/security/src/totp.adversarial.test.ts` | n/a | `apps/web/e2e/operator-mfa.spec.ts` |
| CO-7 | `scripts/check-hosting.test.ts` | `packages/security/src/proxy.state.test.ts` | n/a | n/a | covered in `check-hosting.test.ts` bad fixtures | n/a | n/a |
| CO-8 | n/a | `apps/web/src/refund.state.test.ts` | n/a | `apps/web/src/refund.integration.test.ts` | `apps/web/src/refund.adversarial.test.ts` | `apps/web/src/refund-copy.golden.test.ts` | `apps/web/e2e/refund.spec.ts` |
| CO-9 | `packages/db/src/lock.test.ts` | `packages/db/src/serial.state.test.ts` | n/a | `tests/mvp-c/postgres-refused.integration.test.ts` | `packages/db/src/lock.adversarial.test.ts` | n/a | n/a |
| CO-10 | n/a | `scripts/backup.state.test.ts` | n/a | `scripts/restore.integration.test.ts` | n/a (operator tool, no hostile input) | n/a | n/a |
| CO-G | n/a | n/a | n/a | `tests/mvp-c/c02-c05-webhooks.integration.test.ts`, `c06-c07-refunds.integration.test.ts`, `c08-c09-operator-headers.integration.test.ts`, `c12-race.integration.test.ts`, plus `scripts/c11-restart.integration.test.ts` (only scripts may spawn) | `tests/mvp-c/c-offline.adversarial.test.ts` | n/a | runs the CO-8 and CO-6 journeys |

"n/a" marks a suite a lane does not ship, with its reason in the cell (for example BU-1 has no
database, so no state test; CO-3 has no fixed output, so no golden file). ASM-45 allows a dropped
suite only with an owner decision row and a named reason, so the whole "n/a" list goes to the owner
as one row (O-B7) and each PR repeats its own reasons.

## 5. Parallel waves

| Wave | Starts when | Lanes | Workers |
| ---- | ----------- | ----- | ------- |
| W0 | now (no file shared with S4) | BU-4, BU-5, CO-1, CO-2, CO-5, CO-7, CO-9, CO-10 | 8 |
| W1 | S4 merged | BU-1; CO-4 when BU-4 merges | 2 |
| W2 | BU-1 and BU-5 merged | BU-2 (build now; merge waits for the owner unseal row) | 1 |
| W3 | BU-2 merged | BU-3, BU-6, CO-6 | 3 |
| W4 | CO-6, CO-1, CO-2 merged | CO-3 | 1 |
| W5 | CO-3, CO-4, CO-5 merged | CO-8 | 1 |
| W6 | all above | CO-G, then Opus gate review | 1 |
| Owner B | BU-2, BU-3, BU-6 merged, plus owner rows | `docs/owner/MVPB-OWNER-STEPS.md` | owner |
| Owner C | CO-G green, host and webhook ready | MVP-C owner steps (written by CO-G) | owner |

Critical path, code only: S4 → BU-1 → BU-2 → BU-6 → owner B window. Roughly 4 lane-days of serial
work after S4 merges. Everything in W0 fits beside it.

## 6. New assumptions introduced (proposed; added to `docs/ASSUMPTIONS.md` as `open`)

| ID | Assumption | Used by |
| -- | ---------- | ------- |
| ASM-50 | The production Wire uses `node:https` with `request`, an own `Agent` and `dns.lookup` captured when the module loads; it never calls `globalThis.fetch`, so Next.js's fetch patch cannot change or stop it. Fallback if `node:https` is rejected in review: call the `fetch` reference captured at load and drop only the fetch-identity check. | BU-1, BU-3 |
| ASM-51 | The scope the app serves comes from `UMS_OUTBOUND_SCOPE` (`mvp_b_polling` default, `mvp_c_refunds` later). Moving to MVP-C needs a new approval ref, because `outbound_approvals.approval_ref` is unique and append-only. | BU-2, CO-3, CO-8 |
| ASM-52 | Polling may use at most half of the approval's daily call budget; captures and post-capture reads always keep a reserve. Paid orders are re-read every 6 h (not hourly) for 7 days in sandbox mode. | BU-5 |
| ASM-53 | GET order lists each unit's refunds under `purchase_units[].payments.refunds[]` with id, status and amount (Orders OpenAPI `payment_collection`; not yet seen in the sandbox). It is the source for dashboard refund amounts and PayPal's remaining amount. | BU-4, CO-4 |
| ASM-54 | Webhook cert URLs are https, one host label under `sandbox.paypal.com`, path under `/v1/notifications/certs/` (guard today). Tighten to the exact host after the first recorded delivery. Transmission time accepted from 3 days 1 h in the past to 5 min in the future. | CO-1 |
| ASM-55 | While `UMS_DB` is PGlite, the app runs in one process and PGlite runs one transaction at a time, so Postgres lock races cannot occur. Real-Postgres race tests are waived for MVP-C (owner row needed) and boot refuses `postgres` until they exist. | CO-9 |
| ASM-56 | Operator TOTP secrets live in host settings (`UMS_OPERATOR_TOTP_KEYS`, one per operator), not in the database; enrolment is a TTY script on the owner's machine. | CO-6 |
| ASM-57 | Render runs one instance with one disk and one reverse proxy in front, so `UMS_TRUSTED_PROXIES=1`. Render's `X-Forwarded-For` behaviour is unverified. | CO-7 |
| ASM-58 | Spike Part W is replaced by the MVP-B owner session: the app itself performs create, approve, capture, replay and read-back under the approval row. Part R still runs first. | owner steps |
| ASM-59 | A partial refund leaves the window and `ends_at` unchanged and lets a not-started window start; a full refund revokes; no credit is granted after a revoke; a pending refund does not pause the clock. | CO-5, CO-4 |
| ASM-60 | A webhook is never evidence. One verified event enqueues at most one read-back per order, coalesced with any due poll. | CO-2 |

## 7. Risks and open questions

### 7.1 Only the owner can supply these (blocking)

| # | Item | Blocks | When needed |
| - | ---- | ------ | ----------- |
| O-B1 | Decision-log row approving the unseal (ASM-34 changes from "not wired" to "wired behind five locks"). Without it BU-2 builds but does not merge. | BU-2 merge, everything after | before W3 |
| O-B2 | Spike Part R run by hand (`docs/owner/SPIKE-RUNBOOK.md`), with its own `SPIKE GO` row. Above all: the Business account's receiving preference for USD. | currency choice for B-01 | now; needs no new code |
| O-B3 | `outbound_approvals` row for scope `mvp_b_polling` via `pnpm safety:approve` (owner's machine, TTY), referencing a new decision row with the written go (D-011). Suggested: 20 USD per order, 300 calls per day, 7 days. | B-01 to B-08 | owner B window |
| O-B4 | Answer to O-1 if USD stays PENDING: change the receiving preference, or request a US Business/Personal pair (D-023). | B-01 | after Part R |
| O-B5 | Waiver row for spike Part W (ASM-58), or a `SPIKE GO scope=spike-write` row if the owner keeps Part W. | owner time | before owner B window |
| O-B6 | Policy for turning `paypal_outbound` back on: `setSwitch` needs `mfa: true`. Proposed: the owner at a TTY on their own machine, with an active approval row and the scope typed back, counts as the second factor for `pnpm safety:resume` (same basis as `safety:approve`, ASM-31). Recorded in the unseal row (O-B1). | lock L4, B-01 | with O-B1 |
| O-B7 | One decision row accepting the "n/a" suites of the test matrix (section 4) with their reasons (ASM-45). | lane merges | before W0 merges |
| O-C1 | A GitHub remote for the repository (D-1 says local only). Render deploys from Git. | hosting, MVP-C | by 30 Oct |
| O-C2 | Render account, card, paid plan with a disk (about USD 7.25 a month, hosting.md), and the env values set in Render settings (names from `render.yaml`). | MVP-C | by 30 Oct |
| O-C3 | Webhook registered in the sandbox app for `https://<host>/api/webhooks/paypal`, and its id put into `PAYPAL_WEBHOOK_ID` in Render. | C-01 | after first deploy |
| O-C4 | Second approval ref with scope `mvp_c_refunds` (refund, get refund, cert fetch). | C-06, C-07, C-01 | owner C window |
| O-C5 | Operator TOTP enrolment for Vikram and Sakthi (CO-6 script, on their machines). | C-08, refunds | before owner C window |
| O-C6 | Waiver row for real-Postgres race tests (ASM-55, PORT-1) or approval of `pg` plus a Postgres server. Recommended: waive. | READINESS "required before MVP-C" | before CO-G |
| O-C7 | Spend cap and a reminder to cancel the host after 15 Dec (COST-4). | none technical | with O-C2 |
| O-C8 | How an approval row and a switch resume reach the HOSTED database. `safety:approve` and `safety:resume` are TTY tools that open the PGlite directory, which the running app holds (CO-9 makes them refuse). Options: (a) a maintenance start on Render (app does not open the DB while a flag file exists; owner runs the CLI in the Render shell, removes the flag, restarts); (b) an operator-console approval with TOTP, typed scope and reason (changes how D-011's second key is held). Recommended: (a) for MVP-C, it keeps the key model unchanged. A small follow-up lane (CO-7b, spec written after the answer) implements the chosen option. | any hosted sandbox call | before owner C window |

### 7.2 PayPal behaviour to verify on the first owner run (stays unverified until then)

Nothing below can be proven offline. Fixtures for these are `synthetic` or `docs-example`; the first
owner run turns them into `sandbox-recording` (B-13) or stops the lane (mvp-plan stop conditions).

1. Response shapes our mapping reads: create link rel (`payer-action` or `approve`) and approval host;
   whether `payee` is echoed on GET when create omitted it; `seller_receivable_breakdown`; the exact
   debug header name (`paypal-debug-id` assumed).
2. USD capture on the German Business account: COMPLETED or PENDING with
   `RECEIVING_PREFERENCE_MANDATES_MANUAL_ACTION` (ASM-11). PENDING is a stop condition for MVP-B.
3. Capture replay with the same `PayPal-Request-Id` gives 200 and the same capture (B-03), and create
   replay gives the same order (B-02).
4. 207 on capture: only a multi-unit order can produce it; MVP-B is single-unit, so 207 stays
   fixture-only until MVP-D. Say so in the B gate.
5. 202 and 409 `PREVIOUS_REQUEST_IN_PROGRESS`: unlikely on demand; fixture-only.
6. GET order lists refunds per unit (ASM-53); refund status values; refund `up` link to the capture;
   `refunded_minor` on a refunded capture (D-019 says it may be 0).
7. Webhook: real header names, `paypal-auth-algo` value, cert host and path, cert subject, the
   transmission time format, whether retries keep the transmission id (ASM-54).
8. OAuth: `expires_in`, scope list (whether payouts appears), token reuse across calls.
9. Runtime environment of the owner's machine: whether `next start` and the vitest worker add
   `NODE_OPTIONS` or `execArgv` entries that the override list refuses (BU-3 and BU-6 prove it
   offline on our container; the owner's shell may differ).
10. Render: `X-Forwarded-For` shape (ASM-57), disk persistence over deploys, TLS on port 443 for
    PayPal deliveries.

## 8. Critique of the current plan (blunt)

1. **The seal has passed the point of diminishing returns.** Four review passes (BPREP, SEAL2, SEAL3,
   SEAL4) went into making an in-process capability unforgeable by code that ASM-35 already admits
   can do anything in the same process. The real barrier is that credentials live only on the owner's
   machine. Freeze the seal after S4: no further seal pass unless a review finds a high issue on a
   path a person could take by mistake. Each extra pin makes every later lane edit
   `sealed-callers.test.ts`, `lint-rules.test.ts` and `eslint.config.mjs`, which serialises work.
2. **The kill switch cannot be turned on in sandbox mode at all, and cannot be turned off while the
   app runs.** Nothing sets `paypal_outbound` on outside offline mode (section 1), so lock L4 never
   opens: MVP-B as built cannot make a call even after the unseal. Separately, `pnpm safety:stop` and `safety:approve`
   open the same PGlite directory as the app, and PGlite is single-process. There is no "Stop PayPal
   now" button in `apps/web` (architecture 7.4 promises one). Today the only emergency stop in a live
   session is Ctrl-C. BU-2 adds `safety:resume` and the button; CO-9 makes the CLIs refuse while the
   app holds the directory instead of risking corruption. Hosted, the same problem decides how an
   approval row reaches Render at all (O-C8). The plan mentions none of this.
3. **Polling will eat the call budget.** Each paid order is re-read hourly for 7 days at two calls a
   read. Six demo orders use about 288 calls a day, which is the whole suggested 300-call budget, and
   then checkout is blocked by `budget`. Nothing in the plan partitions the budget. BU-5 fixes this.
4. **The refund cut is not actually available.** Architecture 14.3 cut 3 says "refund in the
   dashboard, then prove by read-back". The read-back cannot book a dashboard partial refund amount
   (READINESS FIX-PAY2 "Not done"). BU-4 reads the refund list from GET order and makes the cut real.
   Refunds through the API also lack the operator MFA check that P9 requires (CO-4).
5. **`pg` is contradictory.** Architecture D-4 lists `pg` "(later)"; the binding list D-008 does not.
   READINESS and D-020 say real-Postgres race tests are required before MVP-C, which needs `pg`, a
   Postgres server and probably a container image pulled from the network. Offline that is
   impossible. Waive it for MVP-C (ASM-55) and keep the boot refusal; do Postgres with Supabase after
   submission.
6. **MVP-C is over-scoped for 3 Nov.** It lists TOTP, webhooks, refunds, hosting, backups, restore
   drill, uptime monitor, alerts to both operators, metrics, a11y with axe (needs O-2), Core Web
   Vitals and a ZAP baseline. Keep: webhooks, refunds, TOTP, hosting, headers and limits (mostly
   done). Downgrade to manual or cut: OBS-5 alert delivery (there is no channel: no email, SMS or
   pager is designed), axe (manual keyboard and contrast check until O-2), CWV (one Lighthouse run),
   restore drill to a scripted offline round trip (CO-10) plus one owner drill, uptime to Render's
   health check plus one free external monitor the owner configures.
7. **Spike Part W duplicates the MVP-B session.** Once BU-2 lands, the app itself does create,
   approve, capture, replay and read-back under an approval row, with recording. A separate Part W
   session costs owner hours and another approval row. Keep Part R (dashboard facts, receiving
   preference, token scopes) and drop Part W (ASM-58). Step 18 (cert host) happens naturally in MVP-C.
8. **`composition.server.ts` is a 1,100-line god file and the merge bottleneck.** Four C lanes must
   edit it in sequence. Do not refactor it before 9 Nov; put every new behaviour in its own module
   under `apps/web/src/server/` and keep the composition edit to wiring lines.
9. **The owner-run sandbox suite has defects.** `sandboxSubject` uses a fixed clock (`T0`) against a
   real service, and its approve hook never shows the owner the approval link, so the owner cannot
   approve. It also cannot build the approved transport by itself. BU-6 fixes all three by reusing
   the app's outbound builder (one wiring for app and suite).
10. **Webhook fallback API is over-built.** `verify_webhook_postback` is on the allow-list and in
    `mvp_c_refunds`. Self-verification is the design (P1); the postback adds an outbound call per
    delivery and cannot verify simulator events. Do not build it; remove it from the scope list in a
    later docs and code change.
11. **Cert host allow-list is looser than the design text.** The guard accepts any one label under
    `sandbox.paypal.com`, including `www.sandbox.paypal.com`. Fine for now (TLS still authenticates
    PayPal), but tighten to the recorded host after the first delivery (ASM-54).
12. **Doc drift.** `CLAUDE.md` says specs go in `docs/specs/`; every lane so far lives in
    `docs/design/lanes/`. `CLAUDE.md` rule 3 names `packages/paypal/src/endpoints.ts`; D-013 moved
    it. Architecture 7.6 says connect timeout 3 s; the Wire has one 10 s deadline. Pick `docs/specs/`
    from now (this branch does) and fix the other two in a docs commit.
13. **Missing from the plan entirely:** a GitHub remote (Render needs Git), `NEXT_TELEMETRY_DISABLED=1`
    (Next's telemetry is an outbound call from the build and the server), and an MVP-C owner step list
    (CO-G writes it).
14. **Calendar.** The plan put the spike on 27 Oct and MVP-B on 27 to 30 Oct. Part R has not run and
    no owner session is booked. The code is not the critical path any more: the owner rows and
    windows are. Book two owner windows now: B (about 2 h, after W3) and C (about 2 h, after W6),
    plus 30 minutes for Part R this weekend.

## 9. Top risks

1. The production Wire or boot refuses under the real runtime (Next's fetch patch, `NODE_OPTIONS` or
   `execArgv` from `next start` or vitest). Every owner call would fail closed. Mitigation: BU-1
   removes the fetch dependency; BU-3 and BU-6 prove both runtimes offline before the window.
2. USD captures stay PENDING on the German Business account. B-01 cannot pass. Mitigation: Part R
   reads the receiving preference now, at zero code cost; O-B4 decided before the window.
3. Owner-only prerequisites (rows, approval, GitHub remote, Render, webhook registration, TOTP
   enrolment) are the critical path, not code. Mitigation: the owner list in 7.1 with dates.
4. Webhook facts (headers, cert host, algorithm) are unverified until a hosted delivery. Mitigation:
   polling stays correct on its own (ASM-07); a failed verification answers 503, never a forgery,
   and changes no state; C-01 may slip without any money risk.
5. Serial merges through composition and the seal pins slip the schedule. Mitigation: freeze the seal
   after S4, new behaviour in separate modules, strict merge order in section 3.

Simulation proves modelled cases only, not PayPal compatibility.
