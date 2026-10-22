# PayPal fixtures (lane 03)

Data for the dry-run transport. Nothing here is PayPal evidence unless its `meta.source` is
`sandbox-recording`, and no such file exists yet. No fixture holds a credential, an email address or a
live hostname; `packages/transport/src/fixtures.contract.test.ts` enforces this.

## Layout

| Folder                | `meta.source`       | What it is                                                                                                                                                                                                                                                                                                                                                        |
| --------------------- | ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `docs-examples/`      | `docs-example`      | Examples from the official OpenAPI files (`checkout_orders_v2.json`, `payments_payment_v2.json`, github.com/paypal/paypal-rest-api-specifications), downloaded 21 Oct 2026. Hosts removed from links, emails replaced; `meta.redactions` lists each change. Error bodies are composed from the OpenAPI error shape and `orders-errors.md`; `meta.origin` says so. |
| `synthetic/`          | `synthetic`         | Hand-written from simulation scenarios (conformance S1 to S6, payment-readback acceptance list), simulation repo at a36ddc03fd0b962000f686291c145b50ee337f90.                                                                                                                                                                                                     |
| `sandbox-recordings/` | `sandbox-recording` | Redacted recordings from the owner's spike. Empty in MVP-A.                                                                                                                                                                                                                                                                                                       |
| `index.json`          |                     | Generated list: file, sha256, source, scenario, operation, step.                                                                                                                                                                                                                                                                                                  |

Regenerate the index after adding or editing a fixture: run `corepack pnpm exec prettier --write fixtures`
first (the hashes cover the formatted bytes), then
`corepack pnpm vitest run -u --project contract packages/transport`. Without `-u` a stale index fails the test.

## Format

One file is one exchange, named `<scenario>__<operation>__<step>.json`. Shape: `FixtureFile` in
`packages/transport/src/fixture-schema.ts` (zod, unknown fields refused). The dry-run transport picks
a file by `scenario` (the request value, else the default), `operation`, and `step`, which is the nth
call of that operation within the scenario (counted from 1, blocked calls do not count). A call with
no file is `blocked: dry_run_miss`. `response: { "timeout": true }` answers `{ kind: 'timeout' }`.
Money is a decimal string in PayPal bodies (`"5.00"`), as PayPal sends it.

## Synthetic scenarios and the call sequence each one expects

Standard identifiers: order `SBX<TAG>ORD00001`, capture `SBX<TAG>CAP00001`, payee merchant
`SBXMERCHANT01`, unit `unit-1`, `custom_id` `ord_SBX0001`, amount 5.00 USD unless stated.

| Scenario                 | Calls in order (operation, step) and what they return                                                                                                                        |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `happy`                  | create 1 (201); get_order 1 (APPROVED); capture 1 (201 COMPLETED); get_order 2 (COMPLETED); get_capture 1; refund_capture 1 (201); get_refund 1                              |
| `pending_receiving_pref` | create 1; get_order 1 (APPROVED); capture 1 (201, capture PENDING, reason RECEIVING_PREFERENCE_MANDATES_MANUAL_ACTION); get_order 2 (still PENDING); get_capture 1 (PENDING) |
| `pending_then_completed` | create 1; get_order 1 (APPROVED); capture 1 (201 PENDING); get_order 2 (PENDING); get_order 3 (COMPLETED); get_capture 1 (PENDING); get_capture 2 (COMPLETED)                |
| `declined`               | create 1; get_order 1 (APPROVED); capture 1 (201, capture DECLINED); get_order 2 and get_capture 1 (DECLINED)                                                                |
| `lost_capture_response`  | create 1; get_order 1 (APPROVED); capture 1 (timeout, the capture happened); get_order 2 (COMPLETED); capture 2 (200 idempotent replay, COMPLETED); get_capture 1            |
| `capture_202`            | create 1; get_order 1 (APPROVED); capture 1 (202, no capture data); get_order 2 (COMPLETED); get_capture 1                                                                   |
| `partial_207`            | two units (3.00 payee SBXMERCHANT01, 2.00 payee SBXMERCHANT02): create 1; get_order 1; capture 1 (207, unit 1 COMPLETED, unit 2 DECLINED); get_order 2; get_capture 1 and 2  |
| `mismatch_amount`        | create 1 (for 5.00); get_order 1 shows 4.00; get_capture 1 shows 4.00                                                                                                        |
| `mismatch_payee`         | get_order 1 shows payee SBXMERCHANT99                                                                                                                                        |
| `mismatch_currency`      | get_order 1 shows EUR                                                                                                                                                        |
| `mismatch_custom_id`     | get_order 1 shows custom_id ord_OTHER99                                                                                                                                      |
| `duplicate_invoice`      | create 1 (422 DUPLICATE_INVOICE_ID)                                                                                                                                          |
| `rate_limited_429`       | create 1 (429, `retry-after: 2`); create 2 (201)                                                                                                                             |
| `server_500`             | create 1 (500); create 2 (201)                                                                                                                                               |

`docs-examples` scenarios each hold one step, named `docs_<case>`.
