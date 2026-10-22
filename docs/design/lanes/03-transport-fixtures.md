# Lane 03: dry-run transport, egress guard and the recorded-fixture store

Task: the only network-capable package, in its offline form: the dry-run transport, the egress guard both transports share, the fixture format and the first fixture set.
Package: `packages/transport`, `fixtures/paypal/` Owner: Sonnet worker W-03 Reviewer: Opus 5.5 ($)
Wave: 1 (needs lane 01 F2 types). Size: 6 h. Single owner of the fixture format.

## Goal
Everything in SBX can be built and tested with no network. The dry-run transport answers PayPal-shaped HTTP responses from labelled fixtures, refuses requests it has no fixture for, and passes every request through the same egress guard the sandbox transport will use, so the guard is tested from day one. The sandbox HTTPS transport file exists as a sealed stub that throws `blocked: connect_off` (it is completed in MVP-B, lane B-L1).

## Inputs
- Architecture section 7 (points 1, 6, 7), 9.1; nfr.md P1 (cert host), P15, MAINT-5.
- Lane 01 F2: `OutboundRequest`, `TransportResult`, `Transport`, `BlockReason`, `PayPalOperation`, `OutboundGate`.
- Fixture sources: the official PayPal OpenAPI files `checkout_orders_v2.json` and `payments_payment_v2.json` from `github.com/paypal/paypal-rest-api-specifications` (`x-samples` and response `examples`), saved by the architect at `scratchpad/sbx2/dl/`; the coordinator copies them into `fixtures/paypal/_sources/` with their URL and download date. Synthetic cases adapt simulation scenarios (`/home/user/AIC_Hackathon_UnitMarket` at `a36ddc03fd0b962000f686291c145b50ee337f90`): `packages/testkit/src/conformance.ts` S1 to S6 (pending then completed, pending then declined, lost response, all declined, partial 207) and `docs/specs/payment-readback.md` acceptance list 1 to 13. Copy the no-network idea of `simulation/paypal/src/no-network.test.ts`.

## Outputs
- `packages/transport/src/{guard.ts, endpoints.ts, dryrun.ts, fixture-store.ts, fixture-schema.ts, sandbox.ts (sealed stub), index.ts}`.
- `fixtures/paypal/docs-examples/*.json` (at least: create 201 minimal, create 201 representation with `payer-action`, get order CREATED, APPROVED, COMPLETED, capture 201, capture 422 `ORDER_NOT_APPROVED`, capture 422 `ORDER_ALREADY_CAPTURED`, refund 201, 404 `RESOURCE_NOT_FOUND`, 409 `PREVIOUS_REQUEST_IN_PROGRESS`, 401 token).
- `fixtures/paypal/synthetic/*.json` (scenarios: `happy`, `pending_receiving_pref`, `pending_then_completed`, `declined`, `lost_capture_response` (capture times out, later GET shows COMPLETED), `capture_202`, `partial_207`, `mismatch_amount`, `mismatch_payee`, `mismatch_currency`, `mismatch_custom_id`, `duplicate_invoice`, `rate_limited_429`, `server_500`).
- `fixtures/paypal/index.json` (generated) and `fixtures/paypal/README.md`.

## Interfaces
```ts
export const SANDBOX_API: 'https://api-m.sandbox.paypal.com';
export const PATHS: Record<PayPalOperation, { method: 'GET' | 'POST'; template: string; mvp: 'A' | 'B' | 'C' }>;
// templates: oauth_token POST /v1/oauth2/token; create_order POST /v2/checkout/orders; get_order GET /v2/checkout/orders/{id};
// capture_order POST /v2/checkout/orders/{id}/capture; get_capture GET /v2/payments/captures/{id};
// refund_capture POST /v2/payments/captures/{id}/refund; get_refund GET /v2/payments/refunds/{id};
// verify_webhook_postback POST /v1/notifications/verify-webhook-signature; fetch_webhook_cert GET (absolute cert URL, host rule below)
export function guard(r: OutboundRequest, kind: 'dryrun' | 'sandbox'): { ok: true; url: URL } | { ok: false; by: 'egress' };
// rules: https; host === 'api-m.sandbox.paypal.com' (or, for fetch_webhook_cert only, host ends with '.sandbox.paypal.com' and path starts with '/v1/notifications/certs/');
// port empty or 443; path matches the operation's template with {id} = ^[A-Z0-9]{1,36}$ (capture and refund ids use the same rule); no query string except none; method equals the template's.
export interface FixtureFile { meta: { source: 'docs-example' | 'synthetic' | 'sandbox-recording'; scenario: string; operation: PayPalOperation; step: number; recorded_at: IsoUtc | null; origin: string; redactions: string[] }; request: { method: 'GET' | 'POST'; path_template: string; headers: Record<string, string>; body: unknown | null }; response: { status: number; headers: Record<string, string>; body: unknown } | { timeout: true } }
export function loadFixtures(dir: string): Promise<FixtureFile[]>;   // validates with zod; refuses unknown fields
export function createDryRunTransport(o: { fixtures: FixtureFile[]; gate: OutboundGate; clock: Clock; default_scenario: string; log: Logger }): Transport; // kind 'dryrun'
export function createSandboxTransport(): Transport; // MVP-A stub: every send returns { kind: 'blocked', by: 'connect_off' }
```
Dry-run selection: by `scenario` (request value, else `default_scenario`), `operation`, and step order (nth call of that operation within the scenario). No match: `{ kind: 'blocked', by: 'dry_run_miss' }`. Bodies: POST bodies are parsed and kept for assertions (`dryrun.calls()` test helper). The gate is consulted on every call even in dry-run, so gate behaviour is testable offline; `connect_off` from the gate is ignored by the dry-run transport only.

Dry-run additions (wave 1 review A): `DryRunCall.url` is the guard-normalised `url.href` (null when the guard refused). A fixture may pin `meta.expected_id` (a whole path segment) or `meta.expected_path` (exact path); a request that does not match a pinned fixture is `dry_run_miss` and does not consume the step. Two fixtures for one (scenario, operation, step) make `createDryRunTransport` throw.

### Requirement for the sandbox transport (lane B-L1)
The guard validates the parsed URL, so the real client must send to the `url.href` the guard returns and never to `r.path`. It must also drop any `Host` and `X-HTTP-Method-Override` request header and set its own `Host` from that URL. A request spelled with an inherited name (`__proto__`, `constructor`) is refused by the guard before any lookup.

## Acceptance tests
- `corepack pnpm vitest run --project unit packages/transport`: `guard refuses live host, http, port 8443, redirect target, unknown path, lowercase order id, query string, wrong method` (A-04); `cert host rule allows a sandbox cert path and refuses others` (P1); `dry-run answers by scenario and step`; `unmatched request is dry_run_miss`; `gate verdicts kill_switch, no_approval, budget are returned as blocked`; `sandbox transport stub always blocked connect_off`.
- `corepack pnpm vitest run --project contract packages/transport`: `every fixture file validates and is listed in index.json`; `every fixture has a source label`; `no fixture contains an email, a bearer token, a client id, or a live hostname` (MAINT-5, A-23 first half).
- `offline_opens_no_socket` (adversarial): spies on `net.connect`, `tls.connect`, `globalThis.fetch`; full dry-run journey of 6 calls opens none (A-02).

## Security and NFR gates
P1 (cert host allow-list), P15, MAINT-5, SOP 18 (SSRF), A-02, A-04.

## Do not
Use `fetch` or any socket in `dryrun.ts` or tests; implement the real sandbox client (MVP-B); add dependencies; edit other packages; store any token; claim a `docs-example` or `synthetic` fixture is PayPal evidence.

Branch `feat/transport-dryrun` Commit `feat(transport): dry-run transport, egress guard, fixture store (SBX-A-03)`.
