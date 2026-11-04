# INT-CTL: Controls and API exposure

Task: One Controls tab for the PayPal gateway, services and feature switches, and an operator-set registry of which API groups are exposed.
Package: `apps/web` (Controls tab, Agents and API › Exposure), `packages/security` (exposure check), `packages/db` (migration), `apps/web/src/app/api/v1/mcp/dispatch.ts`. Builder: Sonnet 5.5 high. Reviewer: Opus 5.5 gate.
Items: CTL.1 to CTL.7, 20 points (CTL.3 is "should", needs V3). Needs CL1, UI0. Sources: operator items 16 to 18; cloud plan items 12, 13; API guide thread E1 to E4.

## Goal

The gateway panel shows the five locks with plain reasons and the owner command for each closed lock; Start and Stop stay the existing controls; nothing here creates an approval or sets the connect flag. The services panel shows web, database, job loop, offline judge and gateway from `GET /api/v1/status` (CL1 adds `revision` and `db`) plus a pasted or fetched `cloud status --json`, with the command to copy, a Cloud Shell link and a link to Google's audit log. Feature switches (if V3): off in one click, on with authenticator code and reason. API exposure: a seeded registry of API groups (catalogue, orders, library, mandates, webhooks, seller, ops, MCP and each MCP tool) checked by `withRoute` for bearer routes and by MCP `tools/list` and `tools/call`; a disabled group answers 403 `api_disabled` and is hidden from `tools/list`; off needs no code, on needs code and reason; every change is journaled.

## Outputs

Migration `00NN_api_exposure.sql` (table `api_exposure (group_name PK, enabled, changed_by, changed_at, reason, created_at, updated_at)`, seeded on, no delete, tracked by the journal), `packages/security/src/exposure.ts` (reader with 5 s cache, like the switch reader), changes in `packages/security/src/route.ts` (one check before the handler for `auth: 'apikey'`) and MCP dispatch, routes `apps/web/src/app/api/ops/api-exposure/route.ts` and `apps/web/src/app/api/ops/switches/[name]/route.ts` (CTL.3), pages under `apps/web/src/app/ops/controls/` and `apps/web/src/app/ops/agents/exposure/`.

## Acceptance tests (commit 1: tests only, run red)

| Item | Test file | Command | Expected |
|---|---|---|---|
| CTL.1 | `apps/web/src/ops-gateway.golden.test.ts` | `pnpm test:golden -- ops-gateway` | Each lock state and `blocked_by` reason maps to a sentence and the owner command; no control posts to approvals or env |
| CTL.2 | `apps/web/src/ops-services.state.test.ts` | `pnpm test:state -- ops-services` | Fixture status JSON renders five cards; commands match `cloud.sh` verbs |
| CTL.3 | `apps/web/src/ops-switches.adversarial.test.ts` | `pnpm test:adversarial -- ops-switches` | Off without code works; on without code 403; `paypal_outbound` on still needs the existing Start path and locks |
| CTL.4, CTL.5 | `packages/security/src/exposure.adversarial.test.ts` | `pnpm test:adversarial -- exposure` | Disabled `orders` group: bearer `GET /api/v1/orders` 403 `api_disabled`, session web page unaffected; disabled MCP tool absent from `tools/list` and refused in `tools/call`; cache expires within 5 s |
| CTL.6, CTL.7 | `apps/web/src/ops-exposure.state.test.ts` | `pnpm test:state -- ops-exposure` | On needs MFA and reason; the screen shows last change from the journal |

Mutation: `exposure.ts` and the route check at least 80 percent.

## Do not

Add an "on" control for the connect flag or any approval insert; add a cloud permission; add a partner owner kind (API guide E7, deferred).

Branch: `feat/int-ctl-controls`. Commit: `feat(web): controls tab and API exposure registry (INT-CTL)`.
