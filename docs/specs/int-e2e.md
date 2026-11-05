# INT-E2E: integrated proof and tamper demo

Task: Prove the whole story offline through the public routes, and script the tamper demo for the video.
Package: new `tests/int/` (the pattern of `tests/mvp1-api/`). Builder: Sonnet 5.5 high. Reviewer: Opus 5.5 gate.
Items: E2E.1 and E2E.2, 4 points, "must". Needs every "must" lane merged (TR0, SR0, UI0, CL1, TR1, AL, SR1, OPS-A, OPS-B, CTL must items, BUY.1 to BUY.5, BUY.8, SEL.1 to SEL.3). Includes `int-wave2-conventions.md`. Round 2 passed 11/12 (`e2e-scorecard.md`); R2-1 to R2-4 applied in the text. Build notes in the scorecard bind (e.g. `raiseAlert` needs `{clock, ids}`; the `alert_events` chain comes from AL's `trace_tracked` row).

## Ground rules

- **Verify in-process (F1).** Every "verify exits N" in this spec means the exit code and lines returned by the function in `packages/db/src/trace-verify.ts` that `scripts/trace-verify.mjs` calls, run in-process on `rig.app.db`. INV-T2 comes from the same call. A spawned `pnpm trace:verify` would open a fresh empty database and is never used here. If TR0 merged no such export, stop and report.
- **Every test-side write is attributed (F2).** A seed or forcing write runs inside `withTraceContext({actor_kind: 'system', channel: 'seed'}, …)` from `@umsbx/obs`, or `{actor_kind: 'system', channel: 'job'}` for the forced alert. The only direct writes allowed are: the seed offers (`extraOffers`, priced $0.10), the forced alert of step 8, and the tamper edits of E2E.2. Everything else goes through a route or a job pass.
- **Clock and job passes (R2-3).** The rig's injected clock. `tests/int/support.ts` defines `runJobPass(app)`: call `startJobs()`, wait until `engine.health().last_pass_at` advances, then stop (the pattern of `refund.integration.test.ts:188-192`). Step 8 may take up to 3 passes.
- **The table is the contract (R2-4).** If a row disagrees with merged behaviour, the builder stops and reports; it never edits the table.
- **Amendments, 5 Nov 17:15Z (spec owner, ruling on `/mnt/project-files/int-e2e/findings.md`):**
  - **B1.** Every `/api/v1/*` call is journaled on channel `api`, including a session call from the keys page (`route.ts`, `V1_PREFIX`). Steps 2 and 12 now say `api`. A session and a key stay distinct through the context's `api_key_id`, which is null for a session, so steps 2 and 12 also assert that it is null.
  - **B2.** A refused buy is journaled, which is the traceability we want. No money row moves. Step 11 now lists the rows that may appear: one `approvals` insert plus the request's `audit_log` rows, all with actor `agent`.
  - **B5** is new. That leftover approval carries `snapshot.mandate_id`. `readPendingApprovals` (`apps/web/src/composition/buyer.ts:127`) would show it in the buyer's "needs your OK" list for its 15 minutes, which is wrong: an agent approval is never for the buyer to act on. A fix lane excludes approvals whose snapshot has a `mandate_id`, and step 11 asserts that the leftover approval does not appear.
  - **B3 and B4** are product bugs fixed in their own lanes. E2E merges main after them.

## E2E.1, the story

One test drives the dry-run app through the route handlers and the web composition, as `tests/mvp1-api/story.ts` does. Units cost $0.10, so the 10-purchase count cap binds before the $5.00 money cap (F4). The numbered steps (F6):

1. A buyer signs in and buys two units as a person (order P1, scenario `happy`, a two-unit cart selection). Dry-run captures inline on the buyer return (`onBuyerReturn`); no job pass is needed.
2. The buyer creates an agent key through `POST /api/v1/api-keys` (owner session route, the one BUY.8's page uses).
3. An MFA operator turns agent buying on through `POST /api/ops/agent-buy` (off by default).
4. The buyer creates a cap of $5.00 and 10 purchases for that key through `POST /api/buyer/mandates`.
5. The agent buys three units over MCP `buy_unit` (orders A1 to A3).
6. The buyer downloads A1's unit.
7. An MFA operator refunds P1's second unit (a person unit, so the cap counts are unchanged). Dry-run completes the refund inside the operator POST.
8. **Forced `payment_unresolved` (F3).** The buyer buys one unit as a person with scenario `pending_then_completed` (order P2), so P2 stays non-terminal. The test calls `raiseAlert` from `@umsbx/payments` for P2, kind `payment_unresolved`, inside a `system`/`job` context (the one named seam). An MFA operator acknowledges it through `POST /api/ops/alerts/[id]/acknowledge`. The clock advances, a job pass reconciles P2 to `paid`, and the alert gets `auto_resolved`. If this needs product code, stop and report.
9. The agent buys six more units (9 of 10). A job pass raises `mandate_near_cap` with reason `cap90_<mandate_id>` (AL.5).
10. The agent buys the 10th unit; the mandate gets `exhausted_at`. The next job pass writes `auto_resolved` on the near-cap alert (AL.4).
11. The agent's 11th buy answers `cap_exhausted`, with no new order and no new reservation row.
12. An MFA operator creates an `ops:read` key, and the seller creates a `sales:read` key, both through `POST /api/v1/api-keys`, for the v1 reads below.

**Expected journal table (F5).** One marker event per step, found in the named view. "Exactly once" counts the marker in that view. The test's expected table equals this table; it is never copied from a first run.

| Step | View                                     | Marker (source table, change)                                                                                                                                                                                                                                                                      | actor_kind          | channel  | mfa         |
| ---- | ---------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------- | -------- | ----------- |
| 1    | buyer timeline of P1                     | `orders` insert                                                                                                                                                                                                                                                                                    | buyer               | web      | false       |
| 1    | buyer timeline of P1                     | `order_units` to `captured_verified` (×2)                                                                                                                                                                                                                                                          | buyer               | web      | false       |
| 2    | `/api/ops/activity` chain `key:<id>`     | `api_keys` insert (context `api_key_id` null: a session, not a key)                                                                                                                                                                                                                                | buyer               | api      | false       |
| 3    | `/api/ops/activity` chain `plat`         | `safety_switches` `agent_buy_enabled` on                                                                                                                                                                                                                                                           | operator            | web      | true        |
| 4    | `/api/ops/activity` chain `mdt:<id>`     | `mandates` insert                                                                                                                                                                                                                                                                                  | buyer               | web      | false       |
| 5    | operator MFA timeline of A1, A2, A3      | `orders` insert (on_behalf_of buyer, mandate_id set)                                                                                                                                                                                                                                               | agent               | mcp      | false       |
| 6    | buyer timeline of A1                     | `access_events` insert                                                                                                                                                                                                                                                                             | buyer               | web      | false       |
| 7    | operator MFA timeline of P1              | `refund_requests` insert                                                                                                                                                                                                                                                                           | operator            | web      | true        |
| 7    | operator MFA timeline of P1              | `refund_requests` to `completed`                                                                                                                                                                                                                                                                   | operator            | web      | true        |
| 8    | operator MFA timeline of P2              | `alerts` insert `payment_unresolved`                                                                                                                                                                                                                                                               | system              | job      | false       |
| 8    | `/api/ops/activity` chain of P2          | `alert_events` `acknowledged`                                                                                                                                                                                                                                                                      | operator            | web      | true        |
| 8    | `/api/ops/activity` chain of P2          | `alert_events` `auto_resolved`                                                                                                                                                                                                                                                                     | system              | job      | false       |
| 9    | operator MFA timelines of the six orders | `orders` insert (×6)                                                                                                                                                                                                                                                                               | agent               | mcp      | false       |
| 9    | `/api/ops/activity` chain `plat`         | `alerts` insert `mandate_near_cap`                                                                                                                                                                                                                                                                 | system              | job      | false       |
| 10   | `/api/ops/activity` chain `mdt:<id>`     | `mandates` `exhausted_at` set                                                                                                                                                                                                                                                                      | agent               | mcp      | false       |
| 10   | `/api/ops/activity` chain `plat`         | `alert_events` `auto_resolved`                                                                                                                                                                                                                                                                     | system              | job      | false       |
| 11   | none                                     | no new `orders`, `order_units`, `mandate_reservations`, `ledger_entries` or `provider_calls` row; the only new journal rows are one `approvals` insert and the request's `audit_log` rows (`approval.requested`, `api.request`); the refused approval is not in the buyer's pending approvals (B5) | agent               | mcp; api | false       |
| 12   | `/api/ops/activity`                      | `api_keys` insert (×2) (context `api_key_id` null for both)                                                                                                                                                                                                                                        | operator; publisher | api      | true; false |

**Checks after the story.**

- The table above holds exactly.
- **Deep scans (F11).** Canaries: the buyer id, buyer display name, agent key id, `req_id`, `ip_hash`, `ua_family` and the full PayPal ids of every order. None appears in:
  - seller answers: `/api/v1/seller/sales/[unit]/timeline`, `/api/v1/seller/sales/export` (SR1.5), `/api/publisher/sales/export` (SEL.2);
  - v1 operator answers (with the `ops:read` key): `/api/v1/ops/orders/[ref]/timeline`, `/api/v1/ops/transactions`, `/api/v1/ops/alerts`, `/api/v1/ops/alerts/[id]`, `/api/v1/ops/needs-you`, `/api/v1/ops/cases`, `/api/v1/ops/trace/verify`.
- INV-T2 is empty and in-process verify exits 0.
- **Offline (F7).** `tests/int/offline.adversarial.test.ts` rebuilds the recorder of `tests/mvp1-api/offline.adversarial.test.ts` (the file-local `vi.mock`/`vi.hoisted` harness plus the `net.client.socket` diagnostics channel), runs the canaries of `tests/mvp-c/c-net-probe.ts` first, then the story steps from `story.ts`. The record is empty, and every `provider_calls` row has `transport_kind = 'dryrun'`.

## E2E.2, tamper (F8)

On the in-memory database only. The test asserts `config.db.kind === 'pglite-memory'` before any edit; the PG-1 throwaway (`UMS_TEST_DB=postgres`) is not allowed. It builds its state with story steps 1 to 5, so a ledger row exists.

1. `ALTER TABLE ledger_entries DISABLE TRIGGER USER`, then change one row's `amount_minor`. Verify exits 1, and its lines include `drift ledger_entries <id> amount_minor`. Other lines may also appear (TR0.5 reports a ledger edit with chain and seq too), so the test does not require it to be the only line.
2. Restore the value while the triggers are still off, then `ENABLE TRIGGER USER`. Verify exits 0.
3. `ALTER TABLE trace_events DISABLE TRIGGER USER`, then change one row's `body`. Verify exits 1, and its lines name that row's chain and seq. Restore and re-enable as in step 2.

**`scripts/demo-tamper.mjs` (F9)** replays these steps for the video:

- It reads the target through `loadConfigFromProcess()` and `config.db.kind`, as `scripts/lib/safety-cli-main.mjs` does (S3: no `process.env` in `scripts/**`). Unset `UMS_DB` defaults to `pglite-memory` and is accepted. Any other kind exits 2 with "demo-tamper runs on pglite-memory only", **before any database import**.
- It boots the dry-run app in-process (`registerTs`, as `scripts/safety-cli.mjs` does) and runs one purchase inside a trace context, so a ledger row exists.
- It runs the three steps with in-process verify, prints each step in plain words, and ends with exit 0.

## Outputs (only these files)

New:

- `tests/int/{package.json,tsconfig.json,story.ts,support.ts}` (`package.json` lists `@umsbx/obs`, `@umsbx/payments`, `@umsbx/db`, `@umsbx/config`, `@umsbx/contracts`, `@umsbx/security`)
- `tests/int/integrated-story.integration.test.ts`, `tests/int/offline.adversarial.test.ts`, `tests/int/tamper.adversarial.test.ts`
- `scripts/demo-tamper.mjs`, `scripts/demo-tamper.test.ts`
- `docs/demo/integrated-story.md` (steps and expected screen states)

Changed:

- `eslint.config.mjs`: one exception entry for `tests/int/**/*.ts` with `sbx/no-package-escape` off, worded like the `tests/mvp1-api/**` entry
- `pnpm-lock.yaml` (workspace package)

No product code.

## Acceptance tests

Commit 1 holds every test file, `story.ts` and `support.ts` (F10). Because every lane is merged first, the story may already pass at commit 1; the expected red comes from `scripts/demo-tamper.test.ts`, since the script is missing. The builder never fakes red in the story.

| Item  | Command                                                                                                                          | Expected                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| ----- | -------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| E2E.1 | `corepack pnpm vitest run tests/int/integrated-story.integration.test.ts tests/int/offline.adversarial.test.ts`                  | Pass. The printed journal table equals the spec table. The deep scans find no canary in the named seller and v1 operator answers. INV-T2 is empty and in-process verify exits 0. The offline record is empty and every `provider_calls.transport_kind` is `dryrun`                                                                                                                                                                                                                     |
| E2E.2 | `corepack pnpm vitest run tests/int/tamper.adversarial.test.ts scripts/demo-tamper.test.ts`, then `node scripts/demo-tamper.mjs` | The tamper test shows exit 1 with `drift ledger_entries <id> amount_minor`, exit 0 after restore, and exit 1 naming the chain and seq after the body edit. The script test: `UMS_DB=postgres` with `DATABASE_URL` at loopback port 1, and `UMS_DB=pglite-disk` with `UMS_PGLITE_DIR` at a temp path that does not exist, each exit 2 with the refusal line, and the temp path still does not exist afterwards. Unset `UMS_DB` runs. The demo run prints the steps and ends with exit 0 |

This lane is the proof, so mutation does not apply. C4, C5 and C7 apply.

## Do not

Change product code; reach a network; run the tamper steps on any database but in-memory; spawn `trace:verify` as proof; skip or reorder a step to make the story pass; copy the expected table from a run.

Branch: `feat/int-e2e`. Commit: `test(int): integrated story and tamper proof (INT-E2E)`.
