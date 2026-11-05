# INT-CTL: Controls and API exposure

Task: One Controls tab for the PayPal gateway, services and feature switches, and an operator-set registry of which API groups partners may call.
Package: `apps/web` (Controls tab, Agents and API › Exposure, session routes, MCP route), `packages/security` (exposure check, fail-safe list), `packages/db` (migration, restore seed list), `packages/contracts` (group list, cloud status schema). Builder: Sonnet 5.5 high. Reviewer: Opus 5.5 gate.
Items: CTL.1 to CTL.7, 20 points: CTL.3 "should" (V3 approved), the rest "must". Needs CL1, UI0, TR0 and AL merged (AL moves `BLOCKED_BY` to `packages/contracts/src/gate.ts`). Sources: operator items 16 to 18; cloud plan items 12, 13; API guide E1 to E4. Includes `int-wave2-conventions.md`. Round 2 passed 11/12 (`ctl-scorecard.md`); build notes R2-1 to R2-5 below.

## Goal

**CTL.1, gateway panel.** The panel on `/ops/controls` shows the five locks with plain reasons and the owner action for each closed lock. Words come from `lib/gateway-view.ts`, built on `gate-lines.ts` (`LockView`) and AL's `BLOCKED_BY`. The owner action per closed lock is fixed (F9, V4):

| Lock                    | Line when closed                              | Owner action shown                                                     |
| ----------------------- | --------------------------------------------- | ---------------------------------------------------------------------- |
| L1 mode is sandbox      | "The app runs offline (mode is not sandbox)." | "Owner sets the host's mode setting `UMS_MODE`." (name only, no value) |
| L2 connect flag         | "The connect flag is off."                    | "Owner only: see the owner runbook." (no command)                      |
| L3 approval             | "No active approval covers this call."        | "Owner runs `corepack pnpm safety:approve` at a terminal."             |
| L4 kill switch          | "PayPal calls are switched off."              | "Use the Start button below." (the existing control)                   |
| L5 credentials and wire | "Credentials or the wire self-check failed."  | "Owner checks the host secrets by name."                               |

The golden asserts no line or copy string contains `UMS_PAYPAL_CONNECT=on`, `--update-env-vars` or an approval ref. Start and Stop stay the existing controls, unchanged. Nothing here creates an approval or sets the connect flag.

**CTL.2, services panel (L).**

- It shows web, job loop, database, offline judge and PayPal gateway.
- The app's own state comes from `GET /api/v1/status` (`revision`, `db`, from CL1), read through composition.
- The cloud state comes from a **pasted** `cloud status --json`. The server never runs `gcloud` and holds no cloud permission. The paste is validated in the browser against `CloudStatusSchema` in `packages/contracts/src/cloud-status.ts` (strict, mirrors CL1's `scripts/__fixtures__/cloud-status.json`), at most 16 KB. It is never stored or posted.
- `CloudStatusSchema.project` matches `^[a-z][a-z0-9-]{4,28}[a-z0-9]$` (F10). Links are built only by `services-view.ts` on the fixed base `https://console.cloud.google.com/` with `encodeURIComponent(project)`.
- The view returns plain strings. `ServicesPanel.tsx` holds no `dangerouslySetInnerHTML` and no `innerHTML`, proven by a text read of the file (C2).
- Each card shows the matching `corepack pnpm cloud:<verb>` command to copy, a Cloud Shell link and a link to Google's audit log. Phase 2 buttons are absent.

**CTL.3, feature switches (L, should).**

- `POST /api/ops/switches/[name]/off` is `fail_safe_without_mfa: true`, like `/api/ops/stop`. Its handler calls `setSwitch(name, false, …)` with a literal `false`; no code path in it can turn a switch on.
- `POST /api/ops/switches/[name]/on` needs MFA.
- Both take a reason code from the CTL.6 list (F13); the code is stored as the `setSwitch` reason, which refuses an empty reason (`switches.ts:93`).
- `on` refuses `paypal_outbound` and `agent_buy_enabled` with 409 `use_existing_control`. Those keep the existing Start and agent-buy paths and their locks. The other five switches (`ai_enabled`, `checkout_enabled`, `refunds_enabled`, `unlock_enabled`, `webhook_enabled`) can be turned on. An unknown `[name]` gives 404.

**CTL.4, registry.**

- `API_GROUPS` in `packages/contracts/src/api-exposure.ts` is a const: `catalogue`, `orders`, `library`, `mandates`, `webhooks`, `seller`, `ops`, `mcp`, and the six literals `mcp:search_catalogue`, `mcp:get_offer`, `mcp:propose_pack`, `mcp:open_unit`, `mcp:check_budget`, `mcp:buy_unit` (F7).
- `GROUP_OF_PATH` maps every `/api/v1/*` prefix of an `auth: 'apikey'` route to one group (F1):

| Prefix                          | Group       |
| ------------------------------- | ----------- |
| `catalogue`, `briefs`, `offers` | `catalogue` |
| `orders`, `quotes`, `approvals` | `orders`    |
| `library`                       | `library`   |
| `mandates`                      | `mandates`  |
| `webhook-subscriptions`         | `webhooks`  |
| `seller`                        | `seller`    |
| `ops`                           | `ops`       |
| `mcp`                           | `mcp`       |

- `api-keys` (`auth: 'owner'`) and `status` (`public`) are not apikey routes and are never gated. Any `/api/v1` prefix added by SR1 or TR1 before CTL merges joins this table. The golden fails on any apikey route whose prefix is unmapped.
- REST groups and MCP groups are independent: `orders` off does not hide `mcp:buy_unit`, and `mcp:buy_unit` off does not refuse `POST /api/v1/orders`.
- **Migration** `00NN_api_exposure.sql` (next free at merge) runs in this order (F3, F4):
  1. Create `api_exposure (group_name text PK, enabled boolean NOT NULL, changed_by text, changed_at timestamptz NOT NULL, reason_code text, created_at, updated_at)`, with a check that `group_name` is in the `API_GROUPS` list and `reason_code` in the CTL.6 list or null.
  2. Insert one row per group, `enabled = true`, with `created_at`, `updated_at` and `changed_at` all `1970-01-01T00:00:00Z` (`SEED_EPOCH`).
  3. Add triggers `api_exposure_no_delete` (`ums_deny_delete`) and `api_exposure_no_truncate` (`ums_deny_truncate`).
  4. Insert the `trace_tracked` row: columns `enabled`, `changed_by`, `changed_at`, `reason_code`; no digest or hashed columns; time column `changed_at`; `chain_expr` `'plat'`.
  5. Attach TR0's capture trigger.
  6. Call `trace_backfill()` last, so the seeds land as `system`/`backfill` `api_exposure.imported` events.
- `packages/contracts/src/trace.ts` adds `api_exposure` to the golden tracked-table list.
- **Restore** (F4): `export-sql.ts` adds `api_exposure` to `SEED_TABLES` and lifts `api_exposure_no_delete` for the seed delete only, inside the import transaction, exactly like `safety_switches_no_delete`. `expectedTriggers` and `guardProblems` list the two new triggers.

**CTL.5, enforcement (L).**

- `packages/security/src/exposure.ts` exports `createExposureReader({db, clock})`, read through a 5-second cache with an injected Clock, like `createSwitchReader`. A read failure answers "disabled" for every group (fail closed).
- `SecurityDeps.exposure?: ExposureReader` is optional (F5). Absent means all groups enabled, so existing test deps stay valid. The app sets it in both `composition.server.ts` blocks that build security deps (the deps object near line 1836 and the `securityDeps` getter near line 3440). A wiring test asserts the app's `securityDeps.exposure` is defined.
- **Position in `withRoute` (F6):** for `auth: 'apikey'` routes only, the check runs right after the bearer key is verified (the `verifyKey` block) and before the operator-key rule, the scope check and the idempotency lookup. A disabled group answers 403 `api_disabled`. So an unauthenticated call still gets 401 `unauthenticated`, and a replayed `Idempotency-Key` after disable gets 403 `api_disabled`, never the stored 200. Session routes and pages are unaffected.
- **MCP:** `apps/web/src/app/api/v1/mcp/route.ts` passes the reader into `AgentCall` as `exposure` (a new optional field in `apps/web/src/api-v1/agent.ts`; absent means all enabled). `dispatch.ts` hides disabled tools from `tools/list` and refuses them in `tools/call` with a tool result `{isError: true}` whose text code is `api_disabled` (the dispatch convention, F14). When `mcp` is off, `withRoute` already refuses the route with 403 `api_disabled`.

**CTL.6, routes.**

- `POST /api/ops/api-exposure/[group]/off` is `fail_safe_without_mfa: true`, with a reason code. Its handler writes `enabled = false` as a literal.
- `POST /api/ops/api-exposure/[group]/on` needs MFA and a reason code.
- Both are `auth: 'operator'`, `csrf: true`, `idempotent: true`, `risk: 'high'`, `rate` 10 per minute per actor. `[group]` is URL-decoded (`mcp%3Abuy_unit`) and checked against `API_GROUPS`; unknown gives 404.
- Reason codes: `incident`, `partner_request`, `maintenance`, `other`.
- Each change runs in the route's trace context, so TR0 journals one `api_exposure` event with the operator actor and channel `web`.
- **Fail-safe widening (F2).** `FAIL_SAFE_WITHOUT_MFA_ROUTES` in `packages/security/src/inventory.ts` becomes exactly `['/api/ops/stop', '/api/ops/switches/[name]/off', '/api/ops/api-exposure/[group]/off']`. `route.ts:231` imports that constant instead of the literal `/api/ops/stop`, so the build-time check and `pnpm check:routes` read one list.

**CTL.7, exposure screen.** `/ops/agents/exposure` shows each group's state, the last change and the toggle. The last change is read from the `api_exposure` row (`changed_by`, `changed_at`, `reason_code`), not from `trace_events` (F12). `changed_by` is shown only on an MFA session; without MFA the screen shows "an operator". A test asserts the row equals the newest `api_exposure` journal event for that group.

## Outputs (only these files)

New:

- `packages/db/migrations/common/00NN_api_exposure.sql`
- `packages/contracts/src/{api-exposure,cloud-status}.ts`
- `packages/security/src/exposure.ts`
- routes `apps/web/src/app/api/ops/switches/[name]/{on,off}/route.ts`, `apps/web/src/app/api/ops/api-exposure/[group]/{on,off}/route.ts`
- page `apps/web/src/app/ops/agents/exposure/page.tsx`
- `apps/web/src/ui/ops/{GatewayPanel,ServicesPanel,SwitchList,ExposureTable}.tsx`, `apps/web/src/lib/{gateway-view,services-view,switches-view,exposure-view}.ts`
- the tests below

Changed:

- `apps/web/src/app/ops/controls/page.tsx` (UI0's page; panels added)
- `packages/security/src/route.ts` (the exposure check at the stated position; the fail-safe check reads the inventory constant), `packages/security/src/inventory.ts` (the three paths), `packages/security/src/index.ts`
- `packages/security/src/route.failsafe.adversarial.test.ts` and `scripts/route-inventory.failsafe.test.ts`: renamed and extended from "stop only" to "these three only" (C6: the rule widens by decision row; every old case stays)
- `packages/db/src/export-sql.ts` (`SEED_TABLES`, seed delete guard, trigger lists)
- `apps/web/src/app/api/v1/mcp/{route,dispatch}.ts`, `apps/web/src/api-v1/agent.ts` (optional `exposure` on `AgentCall`)
- `packages/contracts/src/index.ts`, `packages/contracts/src/trace.ts` (golden list)
- composition modules `ops-controls.ts`, `ops-agents.ts`
- `apps/web/composition.server.ts` (two blocks: both security deps objects)
- `apps/web/src/flow-a11y.state.test.ts` (adds the two pages)
- `docs/decision-log.md` (one row, next free id, covering both the registry and the fail-safe widening)

The decision row states the trade-off: an operator session without the authenticator code can turn off any partner API group and any of the seven switches, and can turn nothing on.

## Acceptance tests (commit 1: tests only, run red)

| Item                   | Test file                                                                                                                                                | Command                                                                                                                                                                     | Expected                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| CTL.1                  | `apps/web/src/gateway-view.golden.test.ts`                                                                                                               | `corepack pnpm vitest run apps/web/src/gateway-view.golden.test.ts`                                                                                                         | Each lock and each `BLOCKED_BY` value maps to the table's sentence and owner action; no string holds `UMS_PAYPAL_CONNECT=on`, `--update-env-vars` or an approval ref; the panel source has no form posting to approvals, env or start                                                                                                                                                                                                                                                                                                                                                                                                          |
| CTL.2                  | `apps/web/src/services-view.state.test.ts`, `apps/web/src/services-paste.adversarial.test.ts`                                                            | `corepack pnpm vitest run apps/web/src/services-view.state.test.ts apps/web/src/services-paste.adversarial.test.ts`                                                         | CL1's fixture renders five cards; the commands equal the seven `cloud:*` scripts in `package.json`; links start with `https://console.cloud.google.com/`. Refused with a plain message: `<script>`, extra fields, a bad enum, over 16 KB, and a project of `javascript:alert(1)`, one holding `"` or `/`, one holding `?`. `ServicesPanel.tsx` and `services-view.ts` hold no `dangerouslySetInnerHTML`, `innerHTML`, `fetch(` or `method: 'POST'`                                                                                                                                                                                             |
| CTL.3                  | `apps/web/src/ops-switches.adversarial.test.ts`                                                                                                          | `corepack pnpm vitest run apps/web/src/ops-switches.adversarial.test.ts`                                                                                                    | Off without MFA works and is journaled with channel `web`; off without a reason code gives 400; on without MFA gives 403; on without a reason code gives 400; `on` for `paypal_outbound` or `agent_buy_enabled` gives 409; unknown name 404; buyer, seller and bearer callers are refused; missing CSRF gives 403; a replay returns the stored answer                                                                                                                                                                                                                                                                                          |
| CTL.3, CTL.6 fail-safe | `packages/security/src/route.failsafe.adversarial.test.ts`, `scripts/route-inventory.failsafe.test.ts`                                                   | `corepack pnpm vitest run packages/security/src/route.failsafe.adversarial.test.ts scripts/route-inventory.failsafe.test.ts`                                                | The flag is accepted on exactly the three paths; on either `…/on` path or any other path it throws at build time and `check:routes` reports it; the off handlers' source passes only literal `false`                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| CTL.4                  | `packages/contracts/src/api-exposure.golden.test.ts`, `packages/db/src/migration-api-exposure.state.test.ts`                                             | `corepack pnpm vitest run packages/contracts/src/api-exposure.golden.test.ts packages/db/src/migration-api-exposure.state.test.ts`                                          | Every apikey route in the route inventory maps to exactly one group; `api-keys` and `status` map to none; the table is seeded on with epoch times; DELETE and TRUNCATE raise; after migrate INV-T2 is empty and `trace:verify` exits 0; a change writes one journal event; export then import into a fresh database succeeds and keeps the exposure rows                                                                                                                                                                                                                                                                                       |
| CTL.4b                 | `packages/db/src/migration-0026-journal.state.test.ts`                                                                                                   | `corepack pnpm vitest run packages/db/src/migration-0026-journal.state.test.ts`                                                                                             | 3 passed: fresh migrate to head; reset refills every tracked row (0023 rows plus `api_exposure`); `trace:verify` ok, 0 unattributed (consolidation.md section 2, F1)                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| CTL.5                  | `packages/security/src/exposure.adversarial.test.ts`, `apps/web/src/app/api/v1/mcp/exposure.state.test.ts`, `apps/web/src/exposure-wiring.state.test.ts` | `corepack pnpm vitest run packages/security/src/exposure.adversarial.test.ts apps/web/src/app/api/v1/mcp/exposure.state.test.ts apps/web/src/exposure-wiring.state.test.ts` | With `orders` disabled: bearer `GET /api/v1/orders` gives 403 `api_disabled`; with no key it gives 401 `unauthenticated`; a replayed `Idempotency-Key` gives 403 `api_disabled`; the buyer session `GET /api/library` and `POST /api/orders` still work; `mcp:buy_unit` still works. A disabled tool is absent from `tools/list` and refused in `tools/call` with `isError`; `mcp` off refuses the route. The MCP entries of `API_GROUPS` equal `TOOL_NAMES`. The cache serves the old value under 5 s and the new one after (injected clock). A read failure answers 403 for apikey routes only. The app's `securityDeps.exposure` is defined |
| CTL.6, CTL.7           | `apps/web/src/ops-exposure.adversarial.test.ts`, `apps/web/src/exposure-view.state.test.ts`                                                              | `corepack pnpm vitest run apps/web/src/ops-exposure.adversarial.test.ts apps/web/src/exposure-view.state.test.ts`                                                           | Off without MFA works; on needs MFA and a reason code; `mcp%3Abuy_unit` decodes and works; an unknown group gives 404; CSRF and replay as CTL.3. The screen shows `changed_by` only with MFA; the row equals the newest journal event                                                                                                                                                                                                                                                                                                                                                                                                          |
| a11y                   | `apps/web/src/flow-a11y.state.test.ts`                                                                                                                   | `corepack pnpm vitest run apps/web/src/flow-a11y.state.test.ts`                                                                                                             | The text-read check passes for `/ops/controls` and `/ops/agents/exposure`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |

Mutation (CTL.2, CTL.3 and CTL.5 are L): `pnpm mutation --require-targets --targets packages/security/src/exposure.ts,apps/web/src/lib/services-view.ts,apps/web/src/app/api/ops/switches/[name]/on/route.ts,apps/web/src/app/api/v1/mcp/dispatch.ts --test-cmd "corepack pnpm vitest run packages/security/src/exposure.adversarial.test.ts apps/web/src/services-paste.adversarial.test.ts apps/web/src/ops-switches.adversarial.test.ts apps/web/src/app/api/v1/mcp/exposure.state.test.ts" --threshold 80`. C4 to C7 apply. The `route.ts` change is also covered by the existing route-wrapper suites, which must stay green.

## Build notes (round 2, binding)

- R2-1: `api_exposure.changed_by` goes in the `trace_tracked` row's `hashed_columns` (as TR0 does for `safety_switches.changed_by`). The CTL.7 row-equals-journal test compares it by sha256.
- R2-2: the CTL.4 golden asserts that the SQL CHECK lists equal `API_GROUPS` and the reason codes.
- R2-3: the exposure routes get CTL.3's role refusals too: buyer, seller, bearer and operator key.
- R2-4: the switch routes use the rate rule 10 per minute per actor.
- R2-5: the gate re-runs the CTL.4 golden after SR1 and TR1 merge.
- N-J1 (journal seed convention, binding): `api_exposure` is a tracked table. Migration 0026 follows `consolidation.md` section 2 "Adding a tracked table in a later migration": it creates only `trace_tracked_seed_0026()`, `trace_tracked_reseed_0026()` and the trigger `trace_tracked_reseed_0026`, never renames or replaces 0023's functions, and its tests prove a fresh migrate to head, a reset that refills every tracked row, and `trace:verify` ok with 0 unattributed. Paste the TRACE-PERF line in the PR.

## Do not

Add an "on" control for the connect flag, any approval insert, or a server-side `gcloud` call; add a cloud permission; add a partner owner kind (API guide E7, deferred); change Start, Stop or agent-buy; read `trace_events` in CTL's composition.

Branch: `feat/int-ctl-controls`. Commit: `feat(web): controls tab and API exposure registry (INT-CTL)`.
