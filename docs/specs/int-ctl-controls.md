# INT-CTL: Controls and API exposure

Task: One Controls tab for the PayPal gateway, services and feature switches, and an operator-set registry of which API groups partners may call.
Package: `apps/web` (Controls tab, Agents and API › Exposure, session routes), `packages/security` (exposure check), `packages/db` (migration), `packages/contracts` (group list), MCP dispatch. Builder: Sonnet 5.5 high. Reviewer: Opus 5.5 gate.
Items: CTL.1 to CTL.7, 20 points: CTL.3 "should" (V3 approved), the rest "must". Needs CL1, UI0 and TR0 merged. Sources: operator items 16 to 18; cloud plan items 12, 13; API guide E1 to E4. Includes `int-wave2-conventions.md`.

## Goal

**CTL.1, gateway panel.** The panel on `/ops/controls` shows the five locks with plain reasons and the owner command for each closed lock. Words come from `lib/gateway-view.ts`, built on `gate-lines.ts` and AL's `BLOCKED_BY`. Start and Stop stay the existing controls, unchanged. Nothing here creates an approval or sets the connect flag.

**CTL.2, services panel (L).**
- It shows web, job loop, database, offline judge and PayPal gateway.
- The app's own state comes from `GET /api/v1/status` (`revision`, `db`), read through composition.
- The cloud state comes from a **pasted** `cloud status --json`. The server never runs `gcloud` and holds no cloud permission. The paste is validated against `CloudStatusSchema` in `packages/contracts/src/cloud-status.ts`, which mirrors CL1's `scripts/__fixtures__/cloud-status.json`. It is at most 16 KB and parsed in the browser only; it is never stored, posted or rendered as HTML.
- Each card shows the matching `corepack pnpm cloud:<verb>` command to copy, a Cloud Shell link and a link to Google's audit log. Phase 2 buttons are absent.

**CTL.3, feature switches (L, should).**
- `POST /api/ops/switches/[name]/off` is `fail_safe_without_mfa: true`, like `/api/ops/stop`.
- `POST /api/ops/switches/[name]/on` needs MFA and a reason code.
- Both use `setSwitch` from `packages/safety/src/switches.ts`.
- `on` refuses `paypal_outbound` and `agent_buy_enabled` with 409 `use_existing_control`. Those keep the existing Start and agent-buy paths and their locks.

**CTL.4, registry.**
- `API_GROUPS` (`catalogue`, `orders`, `library`, `mandates`, `webhooks`, `seller`, `ops`, `mcp`, and `mcp:<tool>` for each of the six MCP tools) is a const in `packages/contracts/src/api-exposure.ts`.
- `GROUP_OF_PATH` maps each `/api/v1/*` prefix to one group.
- The migration adds `api_exposure (group_name PK, enabled, changed_by, changed_at, reason_code, created_at, updated_at)`, seeded on with literal seed times. It has no delete (`ums_deny_truncate` and a delete guard) and is added to TR0's `trace_tracked` and golden list.

**CTL.5, enforcement (L).**
- `packages/security/src/exposure.ts` reads the table through a 5-second cache with an injected Clock, like the switch reader.
- `withRoute` checks it before the handler, for `auth: 'apikey'` routes only. A disabled group answers 403 `api_disabled`. Session routes and pages are unaffected.
- MCP dispatch hides disabled tools from `tools/list`, refuses them in `tools/call` with `api_disabled`, and refuses everything when `mcp` is off.

**CTL.6, routes.**
- `POST /api/ops/api-exposure/[group]/off` is `fail_safe_without_mfa: true`, with a reason code.
- `POST /api/ops/api-exposure/[group]/on` needs MFA and a reason code.
- Both use CSRF and an idempotency key, and are `risk: 'high'`.
- Reason codes: `incident`, `partner_request`, `maintenance`, `other`.

**CTL.7, exposure screen.** `/ops/agents/exposure` shows each group's state, the last change (who and when, from the TR0 journal; the operator id only with MFA) and the toggle.

## Outputs (only these files)

New:
- `packages/db/migrations/common/00NN_api_exposure.sql` (next free at merge)
- `packages/contracts/src/{api-exposure,cloud-status}.ts`
- `packages/security/src/exposure.ts`
- routes `apps/web/src/app/api/ops/switches/[name]/{on,off}/route.ts`, `apps/web/src/app/api/ops/api-exposure/[group]/{on,off}/route.ts`
- pages `apps/web/src/app/ops/controls/page.tsx` (panels added to UI0's page), `apps/web/src/app/ops/agents/exposure/page.tsx`
- `apps/web/src/ui/ops/{GatewayPanel,ServicesPanel,SwitchList,ExposureTable}.tsx`, `apps/web/src/lib/{gateway-view,services-view,switches-view,exposure-view}.ts`
- the tests below

Changed:
- `packages/security/src/route.ts` (one check before the handler), `packages/security/src/index.ts`
- `apps/web/src/app/api/v1/mcp/dispatch.ts`
- `packages/contracts/src/index.ts`, `packages/contracts/src/trace.ts` (golden list)
- composition modules `ops-controls.ts`, `ops-agents.ts`
- `apps/web/composition.server.ts` (wire the exposure reader beside the switch reader; one block)
- `docs/decision-log.md` (one row for the registry, next free id)

## Acceptance tests (commit 1: tests only, run red)

| Item | Test file | Command | Expected |
|---|---|---|---|
| CTL.1 | `apps/web/src/gateway-view.golden.test.ts` | `corepack pnpm vitest run apps/web/src/gateway-view.golden.test.ts` | Each lock state and `BLOCKED_BY` value maps to a sentence and the owner command; the panel source has no form posting to approvals, env or start |
| CTL.2 | `apps/web/src/services-view.state.test.ts`, `apps/web/src/services-paste.adversarial.test.ts` | `corepack pnpm vitest run apps/web/src/services-view.state.test.ts apps/web/src/services-paste.adversarial.test.ts` | CL1's fixture renders five cards; the commands equal the seven `cloud:*` scripts in `package.json`. A paste with `<script>`, extra fields, a bad enum or over 16 KB is refused with a plain message, and its text never reaches the DOM as HTML; the panel source makes no fetch and no POST |
| CTL.3 | `apps/web/src/ops-switches.adversarial.test.ts` | `corepack pnpm vitest run apps/web/src/ops-switches.adversarial.test.ts` | Off without MFA works and is journaled with channel `web`; on without MFA gives 403; on without a reason code gives 400; `on` for `paypal_outbound` or `agent_buy_enabled` gives 409; buyer, seller and bearer callers are refused; missing CSRF gives 403; a replay returns the stored answer |
| CTL.4 | `packages/contracts/src/api-exposure.golden.test.ts`, `packages/db/src/migration-api-exposure.state.test.ts` | `corepack pnpm vitest run packages/contracts/src/api-exposure.golden.test.ts packages/db/src/migration-api-exposure.state.test.ts` | Every apikey route in the route inventory maps to exactly one group; every MCP tool has a group; the table is seeded on; DELETE and TRUNCATE raise; a change writes one journal event |
| CTL.5 | `packages/security/src/exposure.adversarial.test.ts`, `apps/web/src/app/api/v1/mcp/exposure.state.test.ts` | `corepack pnpm vitest run packages/security/src/exposure.adversarial.test.ts apps/web/src/app/api/v1/mcp/exposure.state.test.ts` | With `orders` disabled, bearer `GET /api/v1/orders` gives 403 `api_disabled`, while the buyer session page and `/api/buyer/*` work. A disabled tool is absent from `tools/list` and refused in `tools/call`; `mcp` off refuses all. The cache serves the old value for under 5 s and the new one after (injected clock). A table read failure fails closed (403) for apikey routes only |
| CTL.6, CTL.7 | `apps/web/src/ops-exposure.adversarial.test.ts`, `apps/web/src/exposure-view.state.test.ts` | `corepack pnpm vitest run apps/web/src/ops-exposure.adversarial.test.ts apps/web/src/exposure-view.state.test.ts` | Off without MFA works; on needs MFA and a reason code; CSRF and replay as CTL.3. The screen shows the last change from the journal, with the operator id only with MFA |

Mutation (CTL.2, CTL.3 and CTL.5 are L): `pnpm mutation --require-targets --targets packages/security/src/exposure.ts,apps/web/src/lib/services-view.ts,apps/web/src/app/api/ops/switches/[name]/on/route.ts --test-cmd "corepack pnpm vitest run packages/security/src/exposure.adversarial.test.ts apps/web/src/services-paste.adversarial.test.ts apps/web/src/ops-switches.adversarial.test.ts" --threshold 80`. C4 to C7 apply. The `route.ts` change is also covered by the existing route-wrapper suites, which must stay green.

## Do not

Add an "on" control for the connect flag, any approval insert, or a server-side `gcloud` call; add a cloud permission; add a partner owner kind (API guide E7, deferred); change Start, Stop or agent-buy.

Branch: `feat/int-ctl-controls`. Commit: `feat(web): controls tab and API exposure registry (INT-CTL)`.
