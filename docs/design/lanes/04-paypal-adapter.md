# Lane 04: PayPal adapter mapping from fixtures

Task: implement `PayPalPort` over `Transport`: request building, OAuth token cache, money conversion, response mapping and the error map, proven against fixtures only.
Package: `packages/paypal` Owner: Sonnet worker W-04 Reviewer: Opus 5.5 ($, heavy testing)
Wave: 2 (needs lane 01 F2 and lane 03 fixtures and dry-run transport). Size: 8 h. Single owner of the mapping tables.

## Goal
Payments core sees only `PayPalPort` results, never PayPal JSON. Every documented answer maps to one result kind; unknown issues map by HTTP class, never by message text. No money value ever passes through floating point.

## Inputs
- Architecture 0 (verified facts), 3 (steps 6, 7, 10, 12, 13), 9.1 (files and error map); nfr.md P3, P5, P7, COST-1.
- Lane 01 F2 types (exact); lane 03 `PATHS`, `SANDBOX_API`, `Transport`.
- Copy and adapt (`/home/user/AIC_Hackathon_UnitMarket` at `a36ddc03fd0b962000f686291c145b50ee337f90`): `docs/specs/sandbox-porting-guide.md` section 4 mapping table (correct it: no `REVERSED` capture status; 200 and 202 and 207 exist; `Prefer: return=representation`), `packages/core/approval/canonical.ts` `formatCents` (generalise to `minor_units`).

## Outputs
`packages/paypal/src/{adapter.ts, oauth.ts, money.ts, build-create.ts, map-create.ts, map-order.ts, map-capture.ts, map-refund.ts, errors.ts, headers.ts, webhook-verify.ts (MVP-A: returns { kind: 'unverifiable' } with a TODO for MVP-C), redact-call.ts, index.ts}` and tests.

## Interfaces
```ts
export interface AdapterDeps { transport: Transport; clock: Clock; log: Logger; credentials: { client_id: Secret; client_secret: Secret } | null; record: (c: ProviderCallRecord) => Promise<void> }
export interface ProviderCallRecord { operation: PayPalOperation; method: 'GET' | 'POST'; path_template: string; http_status: number | null; outcome: string; debug_id: string | null; duration_ms: number; transport_kind: EnvironmentLabel; request_redacted: unknown; response_redacted: unknown }
export function createPayPalAdapter(d: AdapterDeps): PayPalPort;     // environment = transport.kind
export function toDecimalString(m: Money, minor_units: 0 | 2 | 3): string;   // 250 -> "2.50"
export function fromDecimalString(v: string, currency: string, minor_units: 0 | 2 | 3): Result<Money, 'bad_amount'>; // refuses more decimals than minor_units, signs, exponents
export function mapError(status: number, body: unknown, headers: Record<string, string>): PayPalFail;
```
Request rules: every POST sends `PayPal-Request-Id` (refuse ids over 108 chars before sending), `Prefer: return=representation`, `Content-Type: application/json`, `Authorization: Bearer <token>` (dry-run fixtures ignore the token value). Create body: `intent: 'CAPTURE'`; per unit `reference_id`, `custom_id = order_ref`, `invoice_id = order_ref` (single unit) or `${order_ref}-${index}` (multi-unit), `amount { currency_code, value }`, `payee { merchant_id }` only when not null; `payment_source.paypal.experience_context { return_url, cancel_url, user_action: 'PAY_NOW', shipping_preference: 'NO_SHIPPING' }`. Approve URL: link with rel `payer-action`, else `approve`; refuse (map to `rejected` with name `APPROVE_LINK_INVALID`) unless https and host `www.sandbox.paypal.com`. Debug id: response header `paypal-debug-id` if present, else body `debug_id`. Token: cache in memory, refresh when `now >= issued + expires_in - 300 s`, single-flight; a 401 on a GET refreshes once and retries once; a POST is never retried by the adapter. Mapping: architecture 9.1 table, exactly; 202 is a `claim` with the units known so far (possibly empty); 207 maps per unit; `ORDER_ALREADY_CAPTURED` maps to `rejected` (payments treats it as unknown and reads back); `PAYER_ACTION_REQUIRED`, `INSTRUMENT_DECLINED`, `REDIRECT_PAYER_FOR_ALTERNATE_FUNDING` map to `payer_action` with the `payer-action` or `redirect` link from `links` when present. Read mapping: per purchase unit pick the latest capture (by `create_time`, then id); `refunded_minor` from `seller_receivable_breakdown` or the capture's refunded total when present, else 0 (record which source in the call record); fee from `seller_receivable_breakdown.paypal_fee`. Every call writes a `ProviderCallRecord` with request and response passed through `redact` (from `@umsbx/obs`).

## Acceptance tests
- `corepack pnpm vitest run --project unit packages/paypal`: `money round trip property, 10k cases, minor_units 0 and 2` ; `"2.505" and "1e2" and "-1.00" refused`; `create body built exactly as the rules for 1 and 2 units`; `request id over 108 chars refused before send`; `approve link with other host refused`; `token refreshed 300 s before expiry, single-flight under 20 concurrent calls`; `error map: one test per row of architecture 9.1` (expected kind and fields from the table, not from the code).
- `--project contract packages/paypal`: `every fixture under fixtures/paypal maps without throwing and the result parses with its contracts schema` (A-23); `docs-example capture 201 maps to claim with COMPLETED units and capture ids`; `get order COMPLETED maps payee, amount, capture status, fee, refunded`; `207 maps per unit`; `202 maps to claim with no final units`; `404 maps to not_found`; `409 maps to in_progress`; `429 maps to unavailable with retry_after_ms from Retry-After`.
- `--project adversarial packages/paypal`: `call records contain no token, secret, email or payer id` (P7); `a response with an amount "0.1" for USD 0.10 maps to 10 minor units, never 0.1`; `unknown issue name maps by HTTP class`.

## Security and NFR gates
P3 (key header and length), P5 (exact amounts), P7, COST-1 (backoff hints passed up, no retry storm in adapter), SOP 18, A-23.

## Do not
Use `fetch` or sockets (only `Transport`); add a PayPal SDK or any dependency; retry POSTs; read `process.env`; decide money state (that is payments); edit fixtures (request changes from lane 03); connect to PayPal.

Branch `feat/paypal-adapter-mapping` Commit `feat(paypal): adapter mapping, OAuth cache, error map from fixtures (SBX-A-04)`.
