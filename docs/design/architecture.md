# UnitMarket Sandbox track (SBX): architecture

Status: **BASELINE v1.0**, 21 Oct 2026. Author: lead architect (Opus 5.5). Reviewers: Vikram (owner), Sakthi. Nothing here authorises a PayPal call, an account, a credential or a deployment. The MVP plan is `mvp-plan.md`; the non-functional and security standard is `nfr.md`; construction specs are in `lanes/`. The three documents are consistent at v1.0; a later change to one updates the others in the same change.

## Decision record (owner, 21 Oct 2026)

| Id | Decision |
|---|---|
| D-1 (Q1) | Separate repository. Built locally first at `/home/user/unitmarket-sandbox` (own git repo, no remote). The owner creates or authorises the private GitHub repo `unitmarket-sandbox` later; we push then |
| D-2 (Q3) | The access clock starts when payment is verified and delivery is verified possible (section 4.4) |
| D-3 (Q4) | Two-publisher route follows the spike; D2 (one PayPal order per publisher) is the safe default; no commission collection until a commission model is chosen |
| D-4 (Q6) | Dependencies approved: `next`, `react`, `zod`, `@electric-sql/pglite`, `pg` (later), `vitest`, `@playwright/test`, `eslint`, `typescript`, `tailwindcss`, `server-only`; no PayPal SDK. Tooling already in the scaffold (`@eslint/js`, `typescript-eslint`, `eslint-config-prettier`, `globals`, `prettier`, `@types/node`) is treated as part of this list; anything else needs a new approval |
| D-5 (Q2, deferred) | Sandbox accounts (US and Germany) decided by the owner later. Until then SBX builds only against recorded and synthetic fixtures; currency and corridor stay configuration; order of corridors US/USD, then UK, then India |
| D-6 (Q5) | Hosting not blocking; researched separately (Hostinger, Vercel, Render, Fly, Google Cloud). Constraint from this design: one long-lived Node process with a persistent disk while PGlite is the database |
| D-7 | SBX is totally separate from the simulation: separate pipelines, no shared modules or artifacts; learn and copy-adapt only |
| D-8 | Models: design Opus; construction Sonnet 5.5 medium; verification Opus 5.5 medium; core and money functions get the heavy testing |
| D-9 | Nothing connects to any PayPal account, ever, without the owner's explicit approval (section 7) |

Repository layout (matches the lane 00 scaffold at `/home/user/unitmarket-sandbox`): `apps/web`; `domain/{access-clock, approval, catalogue, delivery, discovery, entitlements, fit, ledger, library, offer-entry, payments, receipts, recovery}`; `packages/{config, contracts, db, jobs, model, obs, paypal, runtime, safety, security, testkit, transport}`; `tools/spike-kit`; `scripts/` (repo checks); `fixtures/paypal/{docs-examples, synthetic, sandbox-recordings}` (data, not a package); `docs/` (`design/` holds these three documents, `specs/` the lane specs, plus `decision-log.md`, `PROVENANCE.md`, `threat-model.md`). Package scope `@umsbx/*`. Below, "domain/x" means the workspace package `@umsbx/x` in `domain/x`.

Baseline read: simulation repository `main` at `a36ddc0`. Sources are quoted by path. Official facts are marked **VERIFIED** (checked today against the official PayPal OpenAPI files in `github.com/paypal/paypal-rest-api-specifications`, `info.version` 2.32 for Orders, and pages on `developer.paypal.com`, `paypal.com/in/legalhub` and `supabase.com/docs`) or **UNVERIFIED** (not checked, or not checkable without a sandbox call).

## 0. What changed from the previous report

The report at `scratchpad/sbx/report.md` assumed one trunk with shared `packages/core`, `packages/contracts` and `packages/testkit`. The owner has ruled that out. SBX is a separate product line in its own repository (D-1), with its own packages, lockfile, CI, fixtures and artifacts. Nothing is imported in either direction. SBX copies and adapts code from the simulation; every copied file is then owned by SBX and drifts freely. The simulation stays a lab.

PayPal findings of the previous report, rechecked today:

| Finding | Result | Evidence |
|---|---|---|
| Capture can answer 207 for multi-unit orders | VERIFIED | Orders OpenAPI, `POST /v2/checkout/orders/{id}/capture` responses 200, 201, 202, 207, 400, 401, 403, 404, 409, 422, 500 |
| Capture status enum has no `REVERSED` | VERIFIED | `capture_status.status`: COMPLETED, DECLINED, PARTIALLY_REFUNDED, PENDING, REFUNDED, FAILED |
| Order status also has `SAVED`, `PAYER_ACTION_REQUIRED` | VERIFIED | `order_status`: CREATED, SAVED, APPROVED, VOIDED, COMPLETED, PAYER_ACTION_REQUIRED |
| `Prefer: return=representation` needed for full bodies | VERIFIED | `Prefer` default `return=minimal` (id, status, links only) |
| `PayPal-Request-Id` idempotency | VERIFIED, with a new limit | Max 108 characters; "The server stores keys for 6 hours" (72 h only via an account manager). This bounds safe retries; see section 6 |
| `PayPal-Debug-Id` | Body `debug_id` VERIFIED (required in the error schema). Response header name UNVERIFIED in this pass | Orders `error` schema |
| Webhook self-verification with CRC32 and cert | VERIFIED | Message `transmissionId|timeStamp|webhookId|crc32` (decimal CRC32 of the raw body), SHA256 signature from `paypal-transmission-sig`, cert from `paypal-cert-url`; postback API not supported for mock events; HTTPS port 443 only; up to 25 retries over 3 days |
| Partner Referrals and `platform_fees` need enablement | VERIFIED | `platform_fees` "only applicable to merchants that been enabled for PayPal Complete Payments Platform", `maxItems: 1`; "Partner must be enabled by PayPal to use this feature"; "Test the integration in the PayPal sandbox with a standard developer account"; a fee-receiving partner account must not also sell |
| Payee as `merchant_id` | VERIFIED | `payee_base.merchant_id`: "The encrypted PayPal account ID of the merchant"; `email_address` is the alternative |

New facts found today, all VERIFIED unless marked:

- 202 Accepted on create and capture ("handled asynchronously"); 409 `RESOURCE_CONFLICT` with issue `PREVIOUS_REQUEST_IN_PROGRESS`.
- Capture 422 issues include `ORDER_NOT_APPROVED`, `ORDER_ALREADY_CAPTURED` ("If intent=CAPTURE only one capture per order is allowed"), `INSTRUMENT_DECLINED`, `PAYER_ACTION_REQUIRED`, `DUPLICATE_INVOICE_ID`, `TRANSACTION_REFUSED`, `COMPLIANCE_VIOLATION`, `DOMESTIC_TRANSACTION_REQUIRED`, `PAYEE_BLOCKED_TRANSACTION`, `MAX_NUMBER_OF_PAYMENT_ATTEMPTS_EXCEEDED`, `REDIRECT_PAYER_FOR_ALTERNATE_FUNDING`.
- Create 422 issues include `MULTI_CURRENCY_ORDER`, `DECIMAL_PRECISION`, `INVALID_CURRENCY_CODE`, `PAYEE_ACCOUNT_INVALID`, `PAYEE_ACCOUNT_LOCKED_OR_CLOSED`, `PAYEE_ACCOUNT_RESTRICTED`, `PLATFORM_FEES_NOT_SUPPORTED`, `INVALID_PLATFORM_FEES_AMOUNT`, `REFERENCE_ID_REQUIRED`, `DUPLICATE_REFERENCE_ID`. Create 403 `NOT_AUTHORIZED` includes `PAYEE_NOT_CONSENTED`.
- Order id path parameter: pattern `^[A-Z0-9]+$`, max 36. `custom_id` max 255; `reference_id` max 256 (PayPal sets `default` when omitted on a one-unit order); `invoice_id` max 127 and unique per merchant by default.
- Refund: `POST /v2/payments/captures/{capture_id}/refund`; empty body refunds "captured amount minus previous refunds"; refund status CANCELLED, FAILED, PENDING, COMPLETED; 409 when a previous call is in progress. `GET /v2/payments/refunds/{id}` and `GET /v2/payments/captures/{id}` exist.
- Webhook events: `PAYMENT.CAPTURE.COMPLETED`, `.PENDING`, `.DECLINED`, `.DENIED`, `.REFUNDED`, `.REVERSED`; `CHECKOUT.ORDER.APPROVED`; `CHECKOUT.PAYMENT-APPROVAL.REVERSED`.
- Capture `status_details.reason` includes `RECEIVING_PREFERENCE_MANDATES_MANUAL_ACTION`, `PENDING_REVIEW`, `UNILATERAL`, `CHARGEBACK`. Currency page: a payment in a currency the receiver does not hold "remains pending until you manually approve" unless receiving preferences are set. This is the DE-account USD risk.
- Currency list (page updated 17 Aug 2026) has USD, GBP, EUR and **no INR**. PayPal India legal hub: "effective 1 April 2021, PayPal will no longer offer domestic payment services in India".
- OAuth: `POST https://api-m.sandbox.paypal.com/v1/oauth2/token`, basic auth, `grant_type=client_credentials`; example `expires_in` 31668 s; "When your access token expires, call /v1/oauth2/token again". The example scope list includes payouts: the token can do more than we allow, so the path allow-list matters.
- UNVERIFIED: how long a created or approved order stays capturable; which link rel (`approve` or `payer-action`) a create with `payment_source.paypal.experience_context` returns (both rels exist in the spec); the cert URL host; the 429 issue name; how a reversal shows on `GET` capture; whether the payee is echoed on `GET` when create omitted it; refund idempotency retention.

## 1. Context

```
                 +-------------------+         +----------------------------+
 Buyer browser --|  UnitMarket SBX   |--HTTPS--| PayPal SANDBOX only        |
 (untrusted)     |  web + API + jobs |  (Z4)   | api-m.sandbox.paypal.com   |
                 |  one Node process |         | www.sandbox.paypal.com     |
 Publisher ------|  (Next.js 15)     |<-HTTPS--| webhooks (MVP-C, port 443) |
 console / WP    +---------+---------+         +----------------------------+
 plugin (MVP-E)            |
                           +-- Postgres: PGlite (MVP-A/B) | Supabase (later)
                           +-- Content store: Postgres bytea (default) | Supabase Storage (option)
 Operator (Vikram, Sakthi) +-- Host secrets store (sandbox creds, never in repo)
 kill switch, approvals    +-- No Claude API, no Payouts, no live PayPal, ever in this design
```

## 2. Containers and modules

```
apps/web (Next.js App Router, Node runtime only)
  pages: /o/[publisher]/[offer]  /discover  /approve/[id]  /checkout/return  /library  /receipts  /help/[case]
         /publisher/*  /ops/* (operator)
  route handlers: /api/*  (all through security wrappers)
  src/server/composition.ts  (the one wiring point; reads config; builds ports)
        |
        v
+--------------------------- domain (pure TS + Database port; no network) -------------------+
| offer-entry  discovery  fit  approval  payments  entitlements  access-clock  delivery        |
| ledger  receipts  recovery  catalogue  library                                               |
+---------------------------------------------------------------------------------------------+
        | PayPalPort (interface in contracts)                 | Database, Clock, Ids, ContentStore,
        v                                                     v ModelPort, Logger (ports)
packages/paypal (adapter: oauth, orders, payments, webhooks, mapping, errors)
        | Transport (interface)
        v
packages/safety (kill switch, outbound approval gate, call budget)  -->  packages/transport
                                                                       dry-run | sandbox-https
packages/config (only reader of process.env)   packages/obs (log, redaction, audit)
packages/db (driver: pglite | pg; migrations common/ + supabase/)   packages/model (scripted)
packages/jobs (reconciler loop, window sweeper, health)   packages/testkit   tools/spike-kit
```

### 2.1 Trust zones

| Zone | Contents | May reach | Never |
|---|---|---|---|
| Z0 Browser | UI, cookies | Z1 over HTTPS | secrets, provider URLs other than the approve link we hand over |
| Z1 Edge | route handlers, middleware: session, CSRF, rate limit, size limit, zod input | Z2 via composition | DB driver, transport, `process.env` |
| Z2 Domain | offer-entry, discovery, approval, catalogue, library, recovery | Database port, Z3 service calls | network, secrets |
| Z3 Money core | payments, entitlements, access-clock, ledger, receipts | PayPalPort, Database | network directly; model |
| Z4 Egress | paypal adapter, safety, transport | `api-m.sandbox.paypal.com` and the allow-listed cert host only | any other host; redirects |
| Z5 Secrets | config loader | host env | logs, DB, client bundle |
| Z6 Agent | discovery, model port, fit | catalogue read port | payments, approval writes, transport, entitlements |
| Z7 Operator | ops console, CLIs | kill switch, approvals, recovery decisions, refunds | raw secrets, disabling the live block |

### 2.2 Isolation boundary from the simulation

Decided: option A (D-1). The comparison is kept for the record.

| Option | Isolation | Cost | Verdict |
|---|---|---|---|
| A. Separate repository `unitmarket-sandbox` | Total: own history, lockfile, CI, GitHub environments and secrets, branch rules. No path can resolve into the simulation | Two repos to keep public by 8 Nov; copy by hand with provenance | **Chosen** |
| B. Top-level `sandbox/` in this repo with its own `pnpm-workspace.yaml`, lockfile, ESLint, Vitest, tsconfig and a CI workflow filtered to `sandbox/**` | Good if enforced; same git history | Root `eslint .`, root Vitest and lefthook walk into `sandbox/` unless the root configs ignore it, which is an edit to simulation-owned files; PRs and history mix | Fallback if the owner wants one submission URL |
| C. Shared workspace packages | None | | Ruled out by the owner |

The design works either way because the SBX root is self-contained: its own `package.json`, `pnpm-workspace.yaml`, `pnpm-lock.yaml`, `.nvmrc`, `tsconfig.base.json`, `eslint.config.mjs`, `vitest.config.ts`, `lefthook.yml`, `.gitleaks.toml`, `CLAUDE.md` and `docs/`. In option A that root is the repository root. In option B the same tree sits under `sandbox/` and the simulation repo needs exactly four reviewed `[SIM]` edits: root ESLint `ignores: ['sandbox/**']`, root Vitest `exclude: ['sandbox/**']`, lefthook globs that skip `sandbox/**` (SBX runs its own hooks), and the existing CI workflow gets `paths-ignore: ['sandbox/**']` while a new `sandbox-ci.yml` uses `paths: ['sandbox/**']` and `working-directory: sandbox`. The root `pnpm-workspace.yaml` already globs only `apps/*`, `packages/*` and `simulation/*`, so pnpm treats `sandbox/` as its own workspace. Moving from B to A later is `git subtree split` with no code change.

Either way, enforced rules in SBX:

1. ESLint `no-restricted-imports` bars `@unitmarket/*`, `@unitmarket-sim/*`, any specifier containing `simulation/`, `AIC_Hackathon_UnitMarket` or a relative path that leaves the SBX root. A CI script resolves every import with TypeScript's resolver and fails on any file outside the root.
2. Copied files carry a header `// Origin: AIC_Hackathon_UnitMarket@a36ddc0:<path>. Adapted; owned by SBX.` A CI check lists them in `docs/PROVENANCE.md`. The simulation cannot import SBX (separate repository).
3. Package scope `@umsbx/*`. Environment labels `dryrun` and `sandbox`, deliberately different from the simulation's `simulation` and `sandbox`, so data from the two tracks can never be mixed silently.

### 2.3 Import and runtime rules inside SBX (lint-enforced)

- S1 `domain/*` imports only `@umsbx/contracts` and sibling domain modules' public `index.ts`.
- S2 Only `packages/transport/src/sandbox*.ts` (and the standalone `tools/spike-kit`) may use `fetch`, `node:http`, `node:https`, `node:net`, `node:tls`, `node:dns` or `undici` (`no-restricted-globals` and `no-restricted-imports` everywhere else). Only `packages/paypal` imports `transport`. Only `apps/web/src/server/composition.ts`, `packages/jobs` and `packages/testkit` import `paypal`. Lane 00 implements these rules exactly.
- S3 Only `packages/config` reads `process.env` (`no-restricted-properties`).
- S4 `discovery`, `fit` and `model` never import `payments`, `approval` internals, `entitlements`, `paypal`, `safety` or `transport`.
- S5 Client components import only `@umsbx/contracts` types and `ui/`; server modules carry `import 'server-only'`.
- S6 No `Date.now()`, `new Date()` without an argument, `Math.random()`, `crypto.randomUUID()` outside `packages/runtime` (clock, ids). Copy the `NO_REAL_TIME` rule from `eslint.config.mjs` lines 117 to 140.
- S7 CI grep fails on the live hostnames `api-m.paypal.com`, `api.paypal.com`, `www.paypal.com` anywhere in source, fixtures or config (the guard's own test builds the string at runtime).

## 3. Core journey data flow (single publisher, article-specific offer)

Every PayPal call is named. "Gate" means kill switch, outbound approval, egress policy and call budget, in that order (section 7).

| Step | Actor | What happens | PayPal call |
|---|---|---|---|
| 1 | Buyer | Opens `/o/{publisher}/{offer}` (or a WordPress button in MVP-E) | none |
| 2 | Server | `startFromOffer`: authorised current offer, corridor allowed, all-in price within the buyer's ceiling if given, not already owned. Returns a scoped `Quote` (15 min) or `NoMatch` with a reason. No substitute is offered automatically | none |
| 3 | Buyer | Picks access option (Download and keep: 5 days to retrieve; or Online reading: 5 days), sees publisher, payee label, rights, price, currency, "Sandbox" label; ticks terms and (optional) identity sharing | none |
| 4 | Server | `requestApproval`: frozen snapshot (offer id and version, terms version, payee merchant id, amount, currency, rights, access policy and version, reader identity, rule and pricing versions), canonical hash, 128-bit nonce, HMAC token, expiry 15 min | none |
| 5 | Server | `placeOrder` in one transaction: verify token, one open order per (buyer, content hash), write order, expected transaction, unit, pending entitlement, operation `create` `prepared` with `PayPal-Request-Id` | none |
| 6 | Adapter | Token if cache empty or within 300 s of expiry | `POST /v1/oauth2/token` |
| 7 | Adapter | Create order: `intent: CAPTURE`; one purchase unit: `reference_id` = unit id, `custom_id` and `invoice_id` = order reference, `amount {currency_code, value}`, `payee {merchant_id}` (spike decides whether to send it when payee = API caller), `payment_source.paypal.experience_context {return_url, cancel_url, user_action: PAY_NOW, shipping_preference: NO_SHIPPING}`. Headers `PayPal-Request-Id`, `Prefer: return=representation` | `POST /v2/checkout/orders` |
| 8 | Server | Store provider order id. Take the link with rel `payer-action` or `approve`; refuse it unless host is `www.sandbox.paypal.com` and scheme https. Redirect buyer | none |
| 9 | Buyer | Approves at PayPal sandbox as the sandbox buyer; PayPal returns to `/checkout/return?ref=...` with `token` and `PayerID`. The return is a trigger, never evidence | none |
| 10 | Server | Pre-capture read-back: order status `APPROVED`; amount, currency, `custom_id`, payee per unit equal the expected transaction. Any difference freezes the order; nothing is captured | `GET /v2/checkout/orders/{id}` |
| 11 | Server | Delivery readiness check before charging: content object present, sha256 equals the snapshot's article hash, link signer works. If not, no capture; order `failed` with "not charged"; recovery case for the publisher | none |
| 12 | Adapter | Capture with `PayPal-Request-Id` and `Prefer: return=representation`, body `{}`. 201 or 200 is a claim; 202, 409, timeout and 5xx are "unknown"; 207 is per-unit; 422 mapped (section 9.1) | `POST /v2/checkout/orders/{id}/capture` |
| 13 | Server | Separate post-capture read-back; per-unit match | `GET /v2/checkout/orders/{id}`; plus `GET /v2/payments/captures/{capture_id}` for `status_details` and the receivable breakdown |
| 14 | Server | One transaction: unit `captured_verified`, entitlement money `captured`, `access_ready` evidence, window `running` (start = this moment; end = start + 5 days), ledger `sale` and `paypal_fee` (observed), receipt v1 | none |
| 15 | Buyer | Library shows the item. Download streams through our content route; online reading renders server-side. Delivery evidence recorded | none |
| 16 | Jobs | Reconciler polls unknown operations; sweeper ends windows; paid orders re-read hourly for 7 days to catch refunds or reversals made in the dashboard (no webhooks until MVP-C) | `GET /v2/checkout/orders/{id}`, `GET /v2/payments/captures/{id}` |
| 17 | MVP-C | Webhook verified, stored, enqueues step 13. Refund by operator | `POST /v2/payments/captures/{id}/refund`, `GET /v2/payments/refunds/{id}`; cert fetch from the allow-listed cert host |

Agent-led path: `/discover` parses a need and a ceiling with the scripted model, ranks authorised offers, shows the visual fit cards, and the buyer picks; from step 3 the path is identical. Both entry paths reach the same approval screen (PAY-10).

## 4. State machines

### 4.1 Order

| From | Event | To |
|---|---|---|
| `created` | create `created` | `awaiting_buyer` |
| `created` | create `rejected` | `failed` (nothing charged) |
| `created` | create unknown | `created` (reconciler resends with same key within 5 h, then reads) |
| `awaiting_buyer` | read-back `APPROVED` and match and readiness ok | `capture_requested` |
| `awaiting_buyer` | read-back mismatch | `frozen` |
| `awaiting_buyer` | 24 h abandonment sweep (separate from the 15-min approval): read back first; `APPROVED` and match and readiness ok runs the normal capture path once (nfr.md P17); anything else | `capture_requested` or `abandoned` (nothing charged) |
| `awaiting_buyer` | readiness fails | `failed` |
| `capture_requested` | claim stored | `capture_claimed` |
| `capture_requested` or `capture_claimed` | evidence missing or `PENDING` | `unresolved` |
| any of the three | every unit terminal, all captured | `paid` |
| any of the three | every unit terminal, some captured | `paid_partial` (composite only) |
| any of the three | every unit terminal, none captured | `failed` |
| any unpaid | order-level mismatch | `frozen` (human) |
| `paid`, `paid_partial` | order-level mismatch | stays; `mismatch = true`; alert (copy of RB-5) |

Provider status mapping: CREATED, SAVED, PAYER_ACTION_REQUIRED mean "not approved"; APPROVED means "capturable"; COMPLETED means "read units"; VOIDED means "no capture possible".

### 4.2 Capture unit (one per publisher unit)

`expected` then, from read-back only: `captured_verified` (COMPLETED and match), `pending` (PENDING, reason stored), `declined` (DECLINED or FAILED with a debug id), `mismatch` (payee, amount, currency, capture id reuse), then after capture `partially_refunded`, `refunded`, `reversal_suspected` (verified `PAYMENT.CAPTURE.REVERSED` event), `reversed` (confirmed by capture read-back plus operator, because the status a reversal shows is UNVERIFIED). Claims from the capture response are stored as notes and never move a unit except to "unknown". A unit never moves backwards; `refunded` and `reversed` are terminal.

### 4.3 Entitlement (per item)

Money state: copy of the simulation table (`packages/core/entitlements/table.ts`, spec `docs/specs/core-payments-entitlements.md` E1), with `reversal_verified` fed only by the confirmed reversal above. Access state: `locked`, `available`, `ended`, `revoked`. Licence: `null`, `granted`, `terminated`. Invariant (DB CHECK and test): `available` implies money `captured` and a `captured_verified` unit.

### 4.4 Access window (per entitlement)

| From | Event (evidence) | To | Effect |
|---|---|---|---|
| `not_started` | `access_ready` (verified capture and readiness ok) | `running` | `started_at` = event time; `ends_at` = start + policy window (5 d) |
| `running` | `delivery_failed` (system evidence: content route 5xx, store unhealthy, link signing failed for this item) | `paused` | `paused_at` |
| `paused` | `delivery_restored` (next successful delivery or health) | `running` | credit = restored minus paused, rounded up to the hour; `ends_at` += credit |
| `running` or `paused` | recovery case credit (operator or rule) | same | `ends_at` += credit; never reduced |
| `running` | now >= `ends_at` | `ended` | keep: "retrieval closed, your copy is yours"; online: "reading ended"; history stays |
| any | refund or reversal verified for the item | `revoked` | links stop; no recall of a downloaded copy is promised |

`ends_at` is materialised but always recomputable from the append-only `access_events` log by a pure function; a test asserts both agree after every event. Re-issued links never restart the clock and are free.

Definition of working access (decided, D-2): the moment UnitMarket has verified payment and verified it can deliver this item (object present, hash matches, signed link issued). The clock does not wait for the buyer to click, otherwise "5 days to retrieve" has no end.

### 4.5 Recovery case

| From | Event | To |
|---|---|---|
| (none) | system evidence (delivery failed, payment unresolved > 30 min, frozen order, partial composite) or buyer report | `open` |
| `open` | diagnosis attaches evidence | `diagnosing` |
| `diagnosing` | delivery fixed; credit granted | `restored` |
| `diagnosing` | payment proven failed, nothing captured | `closed_not_charged` |
| `diagnosing` | operator offers refund | `refund_pending` |
| `refund_pending` | refund read-back COMPLETED | `refunded` |
| `diagnosing` | evidence shows no fault | `closed_no_fault` (reason shown to buyer) |
| any resolved | buyer acknowledges or 7 days | `closed` |

Rules: never charge for a retry; never create an order from a case; every action appended to `recovery_actions`; SLA timer per kind; the buyer sees one plain status, not internals.

## 5. Idempotency and reconciliation

| Layer | Key | Rule |
|---|---|---|
| Our API | `Idempotency-Key` header on `POST /api/orders`, `/api/refunds`, `/api/recovery` | Stored with actor, route and body hash; replay returns the stored answer; same key with another body is 422 |
| Create | `PayPal-Request-Id = umsC-{order_ref}` | Saved at `prepared` before the call; resend only with the same key |
| Capture | `umsK-{order_ref}` | At most `1 + max_capture_retries` (1) calls; only after a read-back shows no capture |
| Refund | `umsR-{refund_request_id}` | One refund request, one key |
| Serialisation | one call in flight per order and kind | Row lock on the operation (`SELECT ... FOR UPDATE`) before send, and a conditional `UPDATE operations SET state='sent' WHERE id=$1 AND state='prepared' RETURNING id` gates every capture: the return route, the sweep and retries share this one path (nfr.md P3, P4), because two simultaneous calls with one key "may fail the second" |
| Retention | PayPal keeps keys 6 h (VERIFIED) | `idem_safe_window_ms = 5 h` from first send. After it, never resend; read-back only; an unresolved create past it becomes a recovery case, never a new order |
| Invoice | `invoice_id = order_ref` | Second net: a duplicate order for one reference is refused by PayPal (`DUPLICATE_INVOICE_ID`), mapped to `frozen` plus alert |
| Database | unique open order per (buyer, content hash); unique `capture_id`; unique `(capture_id, kind, refund_id)` on the ledger; unique webhook event id; unique `(link_id, kind)` on delivery evidence | Races resolve in the database, not in code |

Reconciler (copy-adapt of `packages/core/payments/due.ts` and `reconcile.ts`): backoff 30 s, 2 min, 10 min, 1 h, capped by `reconcile_until` (24 h); sandbox call budget aware; never calls inside a transaction; recovery first reads. Startup recovery: every `prepared` or `sent` operation becomes `unknown` and is read first (copy of P12, P12a). Daily reconciliation report (operator page): orders by state; unresolved over 1 h; invariants INV1 (ledger sale minus refunds equals verified captured amount per unit), INV2 (every available item has a verified capture), INV3 (no captured unit without entitlements), INV4 (window end equals recomputed end). Copy the invariant idea from `packages/core/app/platform-invariants.ts`.

## 6. Environment and configuration model

| Mode | Transport | DB | Model | Use |
|---|---|---|---|---|
| `offline` (default) | dry-run (recorded fixtures) | PGlite memory or disk | scripted | CI, all developers, the AI builders |
| `sandbox` | sandbox HTTPS, only with every gate open | PGlite disk (MVP-B) or Postgres (later) | scripted | Owner-run sessions and the hosted demo |
| `live` | does not exist | | | Any value naming live refuses to boot |

Configuration (zod, parsed once at boot in `packages/config`; names only, values in host settings or the owner's shell):

`UMS_MODE` (`offline` or `sandbox`), `UMS_PAYPAL_CONNECT` (`off` default, `on`), `UMS_OUTBOUND_APPROVAL_REF`, `PAYPAL_CLIENT_ID`, `PAYPAL_CLIENT_SECRET`, `PAYPAL_WEBHOOK_ID` (MVP-C), `UMS_DB` (`pglite-memory`, `pglite-disk`, `postgres`), `UMS_PGLITE_DIR`, `DATABASE_URL`, `UMS_SESSION_SECRET`, `UMS_APPROVAL_SECRET`, `UMS_LINK_SECRET`, `UMS_DEMO_PASSCODE_HASH` (scrypt), `UMS_PUBLIC_ORIGIN`, `UMS_CORRIDORS` (ids enabled). Only `NEXT_PUBLIC_UMS_ENV_LABEL` is public.

There is no `PAYPAL_ENV` variable: `UMS_MODE` alone selects dry-run or sandbox, and the base URL is a code constant (nfr.md P15 at v1.0). Boot refuses (exit code 78, message without values) when: any configuration value contains `live` or `production` as a mode, or a PayPal hostname other than the sandbox constant appears in any value; `sandbox` mode without `UMS_OUTBOUND_APPROVAL_REF` or credentials; `UMS_PUBLIC_ORIGIN` is not https outside localhost; any secret under 32 bytes; two secrets equal; `NODE_ENV=production` with `offline` mode and no passcode hash. The base URL is never configurable (section 7).

## 7. Connection safety design

Structural rule: reaching PayPal needs five independent things to be true, and reaching live PayPal needs a source change that CI rejects.

1. **Sandbox constant.** `packages/paypal/src/endpoints.ts` exports `SANDBOX_API = 'https://api-m.sandbox.paypal.com'` and an allow-list of path templates: `POST /v1/oauth2/token`, `POST /v2/checkout/orders`, `GET /v2/checkout/orders/{id}`, `POST /v2/checkout/orders/{id}/capture`, `GET /v2/payments/captures/{id}`, `POST /v2/payments/captures/{id}/refund` (MVP-C), `GET /v2/payments/refunds/{id}` (MVP-C), `POST /v1/notifications/verify-webhook-signature` (MVP-C fallback only). Partner Referrals is added only in MVP-D after its approval. Payouts, Vault, v1 payments and identity are never on the list. Path ids are checked against `^[A-Z0-9]{1,36}$` before substitution.
2. **Live disabled, fail closed.** No live host string in the codebase (S7); no `live` enum value in config, contracts or DB (`environment CHECK (environment IN ('dryrun','sandbox'))`); boot refusal (section 6).
3. **Credentials server-side only.** Read once by `config`, wrapped in an opaque `Secret` whose `toString` and `toJSON` return `[redacted]`; passed only to `paypal/oauth.ts`. OAuth token held in process memory, single-flight refresh, never written to DB, log or trace. A build check scans `.next/static` and server chunks for secret names and the value of a canary secret set during the check build.
4. **Kill switches.** Two layers: `UMS_PAYPAL_CONNECT=off` (default) forces the dry-run transport at composition time; DB rows in `safety_switches` read per request (cache at most 5 s). `paypal_outbound` is the emergency stop: every PayPal call, reads included, returns `blocked`, which payments treats like `unavailable` (no money state changes), the reconciler pauses, the UI shows "Payments paused". The finer switches of nfr.md RLR-3 sit beside it: `checkout_enabled` (no new orders or captures; reconciler keeps reading), `refunds_enabled`, `unlock_enabled`, `ai_enabled`, and `webhook_enabled` (off answers 503, PayPal retries for 3 days, RLR-5). Operator console button "Stop PayPal now" and CLI `pnpm safety:stop` trip `paypal_outbound`; any reset needs a reason and the approval ref and is written to `audit_log`.
5. **Outbound approval gate.** Table `outbound_approvals` (append-only): `approval_ref` (the decision-log row), scope (`mvp_b_polling`, `mvp_c_refunds`, ...), allowed operations, `max_amount_cents` per order (e.g. 2000), `max_calls_per_day` (e.g. 300), `valid_until`, `approved_by`. Inserted only by `pnpm safety:approve`, which requires a TTY, refuses when `CI` is set, and asks the owner to type the scope name. The transport sends only if `UMS_OUTBOUND_APPROVAL_REF` equals an active row whose scope covers the operation and the budgets hold.
6. **Egress guard in the transport.** https only; host equal to the constant (or, for webhook certs, a host that ends in `.sandbox.paypal.com` with path prefix `/v1/notifications/certs/`, both to be confirmed by the spike; PayPal's sample listener fetches `paypal-cert-url` without checking it, which is an SSRF and forgery path, so an off-list cert URL is rejected before any fetch, nfr.md P1); port 443; `redirect: 'error'`; connect timeout 3 s, total 10 s; response cap 1 MB; every call written to `provider_calls` (redacted).
7. **Dry-run transport.** Same `Transport` interface; answers from fixtures keyed by operation and scenario; validates request bodies against the adapter's own request schemas; deterministic ids. Fixtures are labelled `docs-example` (from the OpenAPI `x-samples`), `synthetic` (hand-written, from simulation scenarios), or `sandbox-recording` (redacted, from the owner's spike). Only `sandbox-recording` is evidence of PayPal behaviour.

## 8. Database (PGlite now, Supabase-ready)

Driver abstraction (`packages/db`): `interface SqlDriver { dialect: 'pglite' | 'pg'; query; exec; transaction; close }`; adapters `pglite` (memory or disk dir) and `pg` (node-postgres pool, `pg` is a new dependency for owner approval). Supabase connection: direct or Supavisor session mode on port 5432 for the long-lived server; not transaction mode, which "does not support prepared statements" (VERIFIED). The shared pooler is IPv4 only (VERIFIED), which matters for some hosts.

Migrations: plain SQL in `migrations/common/` that run on both (no `now()` defaults, no extensions, application timestamps from the clock, domains `ums_id`, `ums_cents`, `ums_currency`, append-only triggers and truncate guards copied from `packages/db/migrations/0001_init.sql` and `0102_truncate_guards.sql`), plus `migrations/supabase/` (roles, grants, RLS policies referencing Supabase roles, storage) applied only when the target is Supabase. Runner copied from `packages/db/src/migrate.ts`.

Schema outline (all tables: `id`, `created_at`, `updated_at`, `environment` where money or evidence is involved):

| Group | Tables |
|---|---|
| Supply | `publishers` (slug, country, `paypal_merchant_id`, `payee_verified_at`), `articles` (sha256, bytes, mime, rights source), `content_blobs` (bytea, sha256), `offers` (version, status draft/authorised/withdrawn, currency, `access_options` jsonb with price and policy per option, `affordability` jsonb: renegotiation allowed and publisher floor, terms version, AI scope, valid from/until, superseded by), `publisher_authorisations` (append-only), `access_policies` (kind, window_ms, start rule, version) |
| Buyers | `buyers` (auth subject, country), `consents` (kind, text version, granted, revoked), `identity_links` (provider, hashed subject, consent id, revoked) |
| Entry | `briefs`, `discovery_runs`, `proposals`, `proposal_items` (fit dimensions), `quotes` |
| Consent | `approvals` (frozen snapshot, content hash, nonce unique, rule version, expires, used; immutable trigger) |
| Money | `orders` (approval unique, buyer, content hash, reference unique, expected jsonb, status, corridor, currency, total), `provider_orders` (order, provider order id unique, route, approve url host checked) so one internal order can map to 1..N PayPal orders (composite route D2), `order_units` (provider order, publisher, reference id, payee, amount, platform fee, capture id unique, status, status reason, observed fee, verified at, mismatch reason), `operations` (kind create/capture/readback/refund/refund_readback, state, attempt, request id unique, `first_sent_at`, `idem_safe_until`, lease, next retry, reconcile until, failure reason), `provider_calls` (append-only redacted audit of every outbound call with debug id and transport kind), `webhook_events`, `refund_requests`, `ledger_entries` (append-only, unique `(capture_id, kind, refund_id)` with `NULLS NOT DISTINCT`, fixing the one-refund limit ASM-LED-1), `receipts` (versioned, immutable) |
| Access | `entitlements`, `access_windows`, `access_events` (append-only), `links` (token hash, expiry, uses) |
| Recovery | `recovery_cases`, `recovery_actions` (append-only), `alerts` |
| Platform | `api_idempotency`, `sessions`, `rate_buckets`, `audit_log` (append-only), `safety_switches`, `outbound_approvals` (append-only), `schema_migrations` |

RLS plan (written now; enforced on Supabase; on PGlite the primary control is app-level, as nfr.md section 1 argues):

- On PGlite the app is the only client and owns every table, so RLS adds no boundary there. The control is one data-access module per domain whose every query takes the actor and filters by it, plus cross-buyer tests (nfr.md P6, P13). The policies below are still written in `migrations/supabase/` from MVP-A and, if lane L-DB shows PGlite enforces them under `SET ROLE`, also run in CI as a second check.
- On Supabase, RLS is enabled on every table. On Supabase: `revoke all on all tables in schema public from anon, authenticated` (Supabase docs: "Adding policies doesn't take those grants back"); the browser never talks to Supabase; no anon or publishable key ships to the client.
- The server connects as role `ums_app` (LOGIN, no BYPASSRLS, not `postgres`, not `service_role`), granted only the tables and verbs it needs (no UPDATE or DELETE on append-only tables). Jobs connect as `ums_worker`.
- Every request transaction starts with `select set_config('ums.actor_kind', $1, true), set_config('ums.actor_id', $2, true)`. Policies: buyer-scoped tables (`orders`, `order_units` via order, `entitlements`, `access_windows`, `access_events`, `links`, `receipts`, `recovery_cases`, `refund_requests`, `consents`, `identity_links`, `quotes`, `briefs`, `proposals`) use `buyer_id = current_setting('ums.actor_id', true)` for kind `buyer`; publisher-scoped (`offers`, `articles`, own `order_units`, own ledger lines) for kind `publisher`; kind `system` (worker) and `operator` get explicit policies; system-only tables (`operations`, `provider_calls`, `webhook_events`, `alerts`, `safety_switches`, `outbound_approvals`, `audit_log`, `api_idempotency`, `sessions`) have no buyer or publisher policy.
- With Supabase Auth later, `ums.actor_id` is set from the verified session subject; policies can move to `auth.uid()` without schema change.
- Storage: content in `content_blobs` by default (same on both targets, demo scale under 2 MB per article). Optional Supabase Storage adapter behind `ContentStore`, private bucket, service key used only by that adapter, never for DB.
- Backups: PGlite `dumpDataDir` every 15 min and before each deploy, copied off the host, 7 days kept (nfr.md REL-5, RPO 15 min, RTO 30 min). That tarball restores only into PGlite, so `tools/export-sql` also writes a nightly logical export: per table in foreign-key order, `COPY ... TO STDOUT` style rows rendered as `INSERT` statements with a schema version header, checked by restoring into a fresh PGlite and into stock Postgres in CI. This export is the Supabase migration path. Append-only triggers are disabled only inside the import transaction by the session setting copied from `resetDatabase` in `packages/db/src/database.ts`.
- Hosting: a PGlite data directory on disk needs one long-running Node process with a persistent volume; serverless hosting is excluded until Postgres (nfr.md REL-8).
- Currency: no literal `CHECK (currency = 'USD')` (nfr.md section 1 suggests it); instead a `corridors` table and a foreign key from `orders.corridor_id`, with the corridor's currency checked equal to the order currency by trigger. US/USD is the only enabled row in phase 1, which gives the same protection and keeps corridors as data.
- Open risk: whether PGlite supports `CREATE ROLE`, `SET ROLE` and RLS enforcement is UNVERIFIED; lane L-DB settles it.

## 9. Detailed design: core slices

### 9.1 PayPal adapter (`packages/paypal`)

```ts
export interface PayPalPort {
  readonly environment: 'dryrun' | 'sandbox';
  createOrder(r: CreateOrderReq): Promise<CreateOrderRes>;
  getOrder(id: ProviderOrderId): Promise<OrderRead>;
  captureOrder(r: { provider_order_id: ProviderOrderId; request_id: RequestId }): Promise<CaptureRes>;
  getCapture(id: CaptureId): Promise<CaptureRead>;
  refundCapture(r: { capture_id: CaptureId; request_id: RequestId; amount?: Money; note: string }): Promise<RefundRes>;
  getRefund(id: RefundId): Promise<RefundRead>;
  verifyWebhook(w: { headers: Record<string, string>; raw_body: string }): Promise<WebhookVerdict>;
}
type Fail =
  | { kind: 'rejected'; http: 400 | 403 | 422; name: string; issue: string | null; debug_id: string }
  | { kind: 'not_found'; debug_id: string | null }
  | { kind: 'in_progress'; debug_id: string | null }            // 409 PREVIOUS_REQUEST_IN_PROGRESS
  | { kind: 'payer_action'; redirect_url: string | null }       // PAYER_ACTION_REQUIRED, INSTRUMENT_DECLINED
  | { kind: 'unavailable'; retry_after_ms: number | null }      // 5xx, 429, 401 after one refresh
  | { kind: 'timeout' }                                         // no answer; outcome unknown
  | { kind: 'blocked'; by: 'kill_switch' | 'no_approval' | 'egress' | 'budget' | 'dry_run_miss' };
type CaptureRes = { kind: 'claim'; http: 200 | 201 | 202 | 207; units: ClaimUnit[]; debug_id: string } | Fail;
```

Files: `endpoints.ts`, `oauth.ts` (cache, single-flight, refresh at `expires_in - 300`), `money.ts` (integer minor units to decimal strings and back; refuse more than the currency's decimals; copy `formatCents` logic from `packages/core/approval/canonical.ts`), `map-create.ts`, `map-order.ts` (order GET to `OrderRead`: status, `custom_id`, per unit payee, amount, currency, latest capture id, status, `status_details.reason`, `seller_receivable_breakdown.paypal_fee`, refunded total), `map-capture.ts`, `map-refund.ts`, `errors.ts`, `webhook-verify.ts`, `redact.ts`.

Error map (official shapes: `{ name, message, debug_id, details[{ field, value, location, issue, description }], links }`):

| HTTP / name | Issue | Mapped to | Payments effect |
|---|---|---|---|
| 400 `INVALID_REQUEST` | `MALFORMED_REQUEST_JSON`, `INVALID_PARAMETER_VALUE`, ... | `rejected` | Programmer error: operation `failed/invalid_request`, alert, no retry |
| 401 `AUTHENTICATION_FAILURE` | | refresh once, then `unavailable` | Retry later |
| 403 `NOT_AUTHORIZED` | `PERMISSION_DENIED`, `PAYEE_NOT_CONSENTED` | `rejected` | Create fails, nothing charged; config alert |
| 404 `RESOURCE_NOT_FOUND` | `INVALID_RESOURCE_ID` | `not_found` | Absence, never failure; keep polling |
| 409 `RESOURCE_CONFLICT` | `PREVIOUS_REQUEST_IN_PROGRESS` | `in_progress` | Unknown; retry same key after backoff |
| 422 capture | `ORDER_NOT_APPROVED` | `rejected` | No state change; ask buyer to approve |
| 422 capture | `ORDER_ALREADY_CAPTURED` | `rejected` | Treat as unknown claim; read back decides |
| 422 capture | `PAYER_ACTION_REQUIRED`, `INSTRUMENT_DECLINED`, `REDIRECT_PAYER_FOR_ALTERNATE_FUNDING` | `payer_action` | Send buyer back to PayPal; same order |
| 422 capture | `DUPLICATE_INVOICE_ID` | `rejected` | Freeze order, alert (suspected duplicate) |
| 422 capture | `TRANSACTION_REFUSED`, `COMPLIANCE_VIOLATION`, `PAYEE_BLOCKED_TRANSACTION`, `DOMESTIC_TRANSACTION_REQUIRED`, `MAX_NUMBER_OF_PAYMENT_ATTEMPTS_EXCEEDED` | `rejected` | Read back; declined only when the read shows it |
| 422 create | `MULTI_CURRENCY_ORDER`, `DECIMAL_PRECISION`, `INVALID_CURRENCY_CODE`, `PAYEE_ACCOUNT_*`, `PLATFORM_FEES_NOT_SUPPORTED` | `rejected` | Create fails, nothing charged; config alert |
| 429 | (issue name UNVERIFIED) | `unavailable` with `Retry-After` | Backoff |
| 5xx, network | | `unavailable` or `timeout` | Unknown; read first |
| 202 | | claim with no final units | Unknown; read back |

Unknown issues map by HTTP class, never by message text (the docs warn `description` can change).

Webhook verification (MVP-C): raw body via `await request.text()`, cap 64 KB; required headers `paypal-transmission-id`, `paypal-transmission-time`, `paypal-transmission-sig`, `paypal-cert-url`, `paypal-auth-algo`; cert URL host and path allow-listed; cert cached by URL and checked for validity dates; message `id|time|PAYPAL_WEBHOOK_ID|crc32(raw)`; `crypto.createVerify('SHA256')`. Outcomes: `verified(event)`, `bad_signature` (400 plus audit row: forged signature, changed byte, wrong webhook id, off-list cert URL rejected without a fetch), `malformed` (400), `unverifiable` (an allow-listed cert that cannot be fetched or parsed: 503, so PayPal retries; never recorded as forgery). nfr.md P1 states the same split at v1.0. Dedupe by event id and transmission id (P2). No tight time window, since retries span 3 days. A refund event's resource is a refund: map via its `up` link to the capture id, then to our unit (link presence UNVERIFIED; fallback: look up by `refund.id` stored at request time, or by capture read-back).

### 9.2 Payments core (`domain/payments`)

```ts
placeOrder(d: PaymentsDeps, i: { approval_id: Id; token: string; idem_key: string; actor: BuyerActor }): Promise<Result<{ order_id: Id; next: 'redirect' | 'wait' }, PlaceError>>;
beginCheckout(d, i: { order_id: Id; actor }): Promise<Result<{ approve_url: string }, CheckoutError>>;
onBuyerReturn(d, i: { order_ref: Id; actor }): Promise<Result<OrderView, ReturnError>>;  // steps 10 to 14
reconcileOrder(d, i: { order_id: Id; trigger: 'return' | 'capture' | 'poll' | 'webhook' }): Promise<ReconcileReport>;
runDue(d, i: { max_items: number }): Promise<DueReport>;  nextDueAt(db): Promise<string | null>;  recoverOnStartup(d): Promise<void>;
handleWebhook(d, raw): Promise<{ http: 200 | 400 | 503; outcome: 'applied' | 'no_op' | 'duplicate' | 'rejected' }>;
matchReadback(i: { expected: ExpectedTransaction; read: OrderRead; claims: ClaimUnit[]; foreign_capture_ids: string[] }): MatchResult;  // pure
```

Copy-adapt `packages/core/payments/match.ts` (order checks: provider id, reference echo, one currency, unit set; unit checks: payee, amount, status, capture id reuse, claim id, read after claim). Changes: statuses are PayPal's six; `REVERSED` removed; `status_details.reason` carried for display; the expected side is never rebuilt from a response (RB do-not). Expected transaction written before any call (RB-1). Copy the operation lease and compare-and-set unlock pattern (`packages/core/payments/reconcile.ts`, P7, P8). Never call the provider inside a transaction (P14).

### 9.3 Approval and snapshot (`domain/approval`)

Copy `packages/core/approval/canonical.ts` (canonical JSON, cents as two-decimal strings; generalise to the currency's minor units), `token.ts` (HMAC, `timingSafeEqual`), `snapshot.ts` (sorted items and publishers). Adapt: nonce is 128 random bits from the ids port (the simulation used a counter, ASM-ID-1); snapshot schema adds `snapshot_version`, `corridor_id`, `access_option`, `access_policy {id, version, window_ms, start_rule}`, `rights {scope, ai_scope, personal_use}`, `reader {buyer_id}`, `pricing_rule_version`, `rule_version`. Expiry 15 min (410 after), separate from the 24 h abandonment timer on the order (P4). One currency per snapshot; mixed currency refused with `mixed_currency` before approval. Approval records immutable (trigger copied from `0001_init.sql`).

### 9.4 Entitlements, access clock and lost time (`domain/entitlements`, `domain/access-clock`)

```ts
applyMoneyEvent(tx, d, i: { entitlement_id: Id; event: MoneyEvent }): Promise<Result<Transition, 'forbidden_transition'>>;
markAccessReady(tx, d, i: { entitlement_id: Id; evidence: ReadyEvidence }): Promise<WindowState>;
recordDeliveryEvent(d, i: { entitlement_id: Id; link_id: Id | null; kind: DeliveryKind; evidence: DeliveryEvidence }): Promise<WindowState>;
grantCredit(tx, d, i: { entitlement_id: Id; credit_ms: number; case_id: Id; by: OperatorId | 'rule' }): Promise<WindowState>;
computeWindow(events: AccessEvent[], policy: AccessPolicy): WindowState;  // pure, property-tested
sweepWindows(d, i: { max_items: number }): Promise<{ ended: number }>;
```

Copy the 36-cell table and its tests (`packages/core/entitlements/table.ts`, `table.test.ts`), replacing `view48h` with policy-driven windows. `DEFAULT_CORE_CONFIG.view48h_access_ms` becomes `access_policies.window_ms = 432000000` (5 days), frozen in the snapshot. Evidence kinds: `access_ready`, `link_issued`, `download_completed` (server stream finished, bytes and sha256 equal the article), `download_aborted`, `reader_rendered` (server render) and `reader_beacon` (client signal, labelled untrusted), `delivery_failed`, `delivery_restored`, `credit_granted`, `window_ended`, `revoked`. Honesty rule: "download completed" means the server finished sending, not that the device saved it; the UI and receipt say "sent".

### 9.5 Ledger and receipts

Copy `packages/core/ledger/ledger.ts` (append-only, `ON CONFLICT DO NOTHING`, no update function) and the receipt versioning of `packages/core/receipts/receipts.ts`. Changes: amounts in minor units with currency; kinds `sale`, `paypal_fee` (observed, never computed for charging), `platform_fee` (MVP-D only, and only if collected through `platform_fees`), `refund` (per refund id), `reversal`, `commission_reversal`; no `platform_share_due` until the owner chooses a commission model (merchant of record not selected; never collect then pay out). Receipt v1 at verified capture; new versions on refund, reversal, window credit or delivery milestones. Receipt shows snapshot hash, capture id, PayPal debug id (sanitised), access option and window dates, delivery evidence summary, "Sandbox" label.

### 9.6 Content delivery and signed links (`domain/delivery`)

`ContentStore` port (`get(object_key)`, `head`, `health`). Links: `/c/{link_token}`, token = base64url(`link_id.exp.hmac`) with `UMS_LINK_SECRET`, TTL 10 min, bound to entitlement and buyer session (a link opened under another session is refused 404). Route streams bytes, computes sha256 while streaming, sets `Content-Disposition: attachment`, `Cache-Control: private, no-store`, `Referrer-Policy: no-referrer` (P14), `X-Content-Type-Options: nosniff`, and the stored mime (never the client's). A link or entitlement of another buyer answers 404; the buyer's own revoked or ended item answers 403 with a plain reason (P13). Online reading: server-rendered page, `no-store`, watermark with buyer display name; no DRM promise in copy. Errors record `delivery_failed` and pause the window.

### 9.7 Recovery (`domain/recovery`)

```ts
openCase(d, i: { kind: CaseKind; order_id?: Id; entitlement_id?: Id; opened_by: 'system' | 'buyer' | 'operator'; note?: string }): Promise<Result<CaseView, CaseError>>;
diagnose(d, i: { case_id: Id }): Promise<Diagnosis>;      // gathers evidence; read-back if payment
resolve(d, i: { case_id: Id; action: 'restore' | 'credit' | 'offer_refund' | 'close_no_fault'; credit_ms?: number; by: OperatorId | 'rule' }): Promise<CaseView>;
listForBuyer(d, i: { actor: BuyerActor }): Promise<CaseView[]>;
```

Kinds: `delivery_failed`, `payment_unresolved`, `frozen_order`, `partial_composite`, `refund_requested`, `reversal`. Automatic rule: a system-detected delivery failure that is restored grants measured credit without a human; buyer reports with no system evidence go to an operator.

### 9.8 Security middleware (`packages/security`)

`withRoute({ auth: 'public' | 'buyer' | 'publisher' | 'operator', csrf: boolean, rate: RateRule, maxBody: number, input: ZodSchema, idempotent?: boolean }, handler)`. Authorisation runs in the route wrapper and again in the data-access module, never in Next.js middleware alone (CVE-2025-29927 class, nfr.md SOP 1). Session: `__Host-` prefixed, signed, HttpOnly, Secure, SameSite=Lax cookie with a server-side `sessions` row (absolute 8 h, idle 30 min, rotate on login, revoke-all), passcode-gated buyer and publisher personas for the demo (scrypt hash, 5 attempts per 15 min per IP). Operator sign-in adds TOTP (RFC 6238 over `node:crypto`, no new dependency) from MVP-C (nfr.md SOP 4). Checkout uses a full redirect to the PayPal approval page, not the JS SDK, so no PayPal script or client id reaches our pages and no card field exists in our DOM (P8). CSRF: Origin check plus double-submit token on every state-changing route. Object-level authorisation: every lookup includes the actor (`WHERE id = $1 AND buyer_id = $2`) and RLS repeats it; another buyer's id answers 404. Mass assignment: zod `.strict()` schemas. Headers (middleware): HSTS, CSP with nonce (`default-src 'self'; frame-ancestors 'none'; form-action 'self'; connect-src 'self'`), `X-Content-Type-Options`, `Referrer-Policy: strict-origin-when-cross-origin`, `Permissions-Policy`. Rate limits (single instance, DB buckets): passcode 5/15 min, quote 30/min, approval 10/min, order 5/min, content 60/min, webhook 300/min, discovery 20/min. No production source maps. Errors to users are generic with a support code; details go to logs.

### 9.9 Config, logging and redaction (`packages/config`, `packages/obs`)

One JSON line per event: `ts`, `level`, `env_label`, `req_id`, `actor_kind`, hashed actor id, `order_ref`, `op`, `paypal_debug_id`, `duration_ms`. Redaction by key (`authorization`, `access_token`, `client_secret`, `cookie`, `set-cookie`, `passcode`, `payer`, `email_address`, `name`, `address`, `phone`, `payer_id`, `paypal-transmission-sig`) and by value pattern (bearer tokens, emails). Redaction runs in the logger and in `provider_calls` and fixture recording; a test feeds a fixture full of canaries and asserts none survive. `audit_log` (append-only) records kill switch, approvals, refunds, credits, operator overrides and recovery decisions with actor and reason. Retention: logs 30 days at the host; `provider_calls` 90 days.

### 9.10 Agent port and scripted model (`packages/model`, `domain/discovery`)

`ModelPort` as in `packages/contracts/src/ports.ts` (`complete({ purpose, system, input })`). `ScriptedModel`: deterministic brief parser (copy-adapt `simulation/consumers/src/parse.ts`) and keyword ranker. Output is untrusted: zod-parsed, offer ids must be among the candidates, price and payee always from the catalogue (copy rule G3 of `packages/core/agent/compose.ts`). Read-only tool allow-list `search_catalogue`, `get_article_summary`, `propose_pack` (nfr.md AI-3), recorded and never executed; any other name is rejected by the dispatcher (adapt `AGENT_TOOLS` and `COMPOSE_SYSTEM` from `packages/core/agent/prompts.ts`; `request_approval` is removed because approval needs a human click). Copy the injection cases of `packages/core/agent/injection.adversarial.test.ts` as data. The agent cannot approve, order or pay (S4). A Claude adapter is a later, separately approved lane with spend caps.

### 9.11 Buyer-fit visual match component

```ts
type FitDimension = {
  key: 'topic' | 'budget' | 'access' | 'language' | 'recency';
  label: string;                 // 1 to 3 words
  level: 0 | 1 | 2 | 3 | null;   // null: not assessed, rendered as an empty outline
  basis: 'keyword_overlap' | 'price_vs_ceiling' | 'option_offered' | 'language_equal' | 'publish_date';
  evidence: string;              // short, from facts: "3 of 4 terms", "$4 of your $6"
};
type FitCard = { offer_id: Id; dimensions: FitDimension[]; band: 'strong' | 'good' | 'partial' | null };
computeFit(brief: Brief, offer: OfferFacts): FitCard;   // pure; band derived from dimensions only
```

Rules: no number that looks like a probability or a percentage; every level traceable to its `basis` and `evidence`; `null` rather than a guess; same inputs, same card (property test); buyer chooses, ranking is advice. UI: one card per offer, five dot rows with icons, band chip, price and access option prominent, text alternative for screen readers, WCAG 2.2 AA contrast.

### 9.12 Publisher article-specific entry (`domain/offer-entry`)

```ts
startFromOffer(d: CoreDeps, i: {
  offer: { publisher_slug: string; offer_code: string } | { offer_id: Id };
  buyer: BuyerActor | null; ceiling_minor?: number; access_option?: AccessOption;
  source: 'direct' | 'wordpress'; wp_link?: string;   // MVP-E: HMAC-signed, verified, carries no price
  proposed_minor?: number;                            // permissioned renegotiation, only if the offer allows it
}): Promise<Result<Quote | NoMatch, EntryError>>;
type NoMatch = { kind: 'no_match'; reason: 'above_ceiling' | 'withdrawn' | 'not_authorised' | 'corridor_unsupported' | 'already_owned' | 'below_publisher_floor' };
```

Price comes from the offer's publisher-set option prices; there is no universal floor (the simulation's `LINE_FLOOR_CENTS = 100` in `packages/core/catalogue/price.ts` and `line_floor_cents` in `packages/core/veto/rules.articles.json` are dropped). Permissioned renegotiation: a proposal at or above the publisher's floor for that offer is accepted at the proposed price; below it is `no_match` with no counter-offer generated by us. No crowd wait, no wallet, no pass.

## 10. Module catalogue

Copy sources are paths in the simulation repository at `a36ddc0`. "Copy" means copy then adapt; SBX owns the result.

| Module | Responsibility | Key interface | Depends on | Copied from | New | Tests |
|---|---|---|---|---|---|---|
| `contracts` | zod schemas, port types, result type | `PayPalPort`, `Database`, `Clock`, `Ids`, `ContentStore`, `ModelPort`, snapshot, expected transaction, operation, entitlement, window | zod | `packages/contracts/src/primitives.ts`, `snapshot.ts`, `approval.ts`, `expected-transaction.ts`, `payment-operation.ts`, `entitlement.ts`, `ports.ts` | window, evidence, recovery, quote, fit, corridor schemas | schema unit tests copied and extended |
| `config` | parse env once, refuse unsafe boots | `loadConfig(env): Result<Config, BootRefusal>` | zod | idea of `.env.example` | all | table test per refusal |
| `runtime` | real clock, crypto ids, rng | `systemClock`, `cryptoIds` | node:crypto | | all | determinism with fakes |
| `safety` | kill switch, approval gate, budgets | `OutboundGate.check(call)`, `KillSwitch` | db port | | all | state tests; adversarial: no approval, expired, over budget |
| `transport` | the only network code | `Transport.send(req)` | node:https | idea of `simulation/paypal/src/no-network.test.ts` | dry-run, sandbox, egress guard, recorder | no-socket test in offline; guard tests (host, port, redirect, size) |
| `paypal` | adapter | `PayPalPort` | transport, contracts | mapping table of `docs/specs/sandbox-porting-guide.md` section 4 (corrected) | all mapping, OAuth, webhook verify, error map | fixture replay for every fixture; error map table test; money round-trip property test; webhook vectors (valid, one byte changed, wrong cert host, cert fetch failure) |
| `db` | drivers, migrations, RLS | `openDriver(cfg)`, `migrate(driver, clock)` | pglite, pg | `packages/db/src/migrate.ts`, `database.ts`, migrations `0001` domains, triggers, `0102` guards, unique open-order index | `pg` driver, roles, RLS, new tables | migration tests on PGlite; RLS tests; race test with two `pg` connections (MVP-C) |
| `obs` | logger, redaction, audit | `log`, `redact`, `audit` | | | all | canary redaction test |
| `security` | route wrapper, session, CSRF, rate, headers | `withRoute` | db, config | cookie checks of `apps/web/server/session.ts` | all | adversarial: IDOR, CSRF, oversize, rate |
| `catalogue` | publishers, articles, offers, authorisations | `getOffer`, `listAuthorised` | db | `packages/core/catalogue/offers.ts` | options, affordability, authorisation | state tests |
| `offer-entry` | `startFromOffer` | see 9.12 | catalogue, corridors | | all | each no-match reason; no substitution |
| `discovery`, `fit`, `model` | need parsing, ranking, fit cards | see 9.10, 9.11 | catalogue read | `simulation/consumers/src/parse.ts`, `packages/core/agent/compose.ts` (G1 to G8), `prompts.ts`, `injection.adversarial.test.ts` | fit, smaller composer | property tests; injection set; isolation lint |
| `approval` | snapshot, hash, token, expiry | `requestApproval`, `verifyApproval`, `markUsed` | db | `packages/core/approval/canonical.ts`, `token.ts`, `snapshot.ts`, `approval.ts`, tests `canonical.test.ts`, `approval.adversarial.test.ts` | new snapshot fields, random nonce | tamper 403, expiry 410, reuse 409 |
| `payments` | orders, operations, match, reconcile, webhooks, refunds | see 9.2 | approval, entitlements, ledger, receipts, PayPalPort | `packages/core/payments/match.ts`, `place.ts`, `capture.ts`, `checkout.ts`, `reconcile.ts`, `due.ts`, `webhooks.ts`, tests and `support/fake-provider.ts` | readiness check, provider orders, refund flow, idempotency window | heaviest: section 11 |
| `entitlements`, `access-clock` | states, windows, credits | see 9.4 | db | `packages/core/entitlements/table.ts`, `entitlements.ts`, `links.ts`, tests | windows, evidence | exhaustive table; property tests on `computeWindow` |
| `delivery` | links, content route, evidence | `issueLink`, `serve` | content store | `links.ts` idea | streaming evidence | integration with aborted streams |
| `ledger`, `receipts` | money record, evidence document | `append`, `issueReceiptIfChanged` | db | `packages/core/ledger/ledger.ts`, `packages/core/receipts/receipts.ts`, `html.ts` | refund id key, window and evidence lines | append-only, sums, sha256 shown equals stored |
| `recovery` | cases | see 9.7 | payments read, access-clock | | all | state tests; never-charge test |
| `jobs` | reconciler loop, sweeper, health | `startLoop(deps)` | payments, access-clock | harness loop idea in `simulation/harness` | all | fake-clock loop tests |
| `testkit` | fakes, fixtures, conformance | `describePayPalConformance(subject)` | | `packages/testkit/src/conformance.ts` (C1 to C15), S1 to S6 as scripted fixtures | HTTP-level fake PayPal | runs against dry-run in CI, sandbox by owner |
| `apps/web` | screens and routes | `apps/web/src/server/composition.ts` | all through composition | screen ideas only from `apps/web/app/*`; no code shared | production design system | Playwright offline e2e; route authz tests |
| `tools/spike-kit` | owner-run checks | CLI | node only | | all | dry-run self-test only |

## 11. Test strategy for core and money

Tiers: unit (pure), state (PGlite, fake clock), contract (fixture replay through the adapter; conformance C1 to C15 against dry-run), adversarial, integration, e2e (Playwright, offline), sandbox (owner-run, gated by `UMS_SANDBOX_TESTS=1`, never in CI). Money modules (paypal mapping, match, payments, entitlements, access clock, ledger) also get: exhaustive state tables; property tests (random event sequences never make an item available without a verified capture; window end never decreases; ledger never negative; minor-unit round trip); mutation tests on `match` and `reconcile` (copy `scripts/mutation-checks.mjs` idea); race tests (webhook versus poller, double submit) on PGlite and later on two `pg` connections. Coverage gate on money modules: 90 percent branches and 95 percent lines (nfr.md MAINT-6). Mutation checks use a dependency-free script adapted from `scripts/mutation-checks.mjs` (score at least 80 percent, MAINT-4); Stryker would need a new approval. Acceptance tests are written from requirements before code (TDD), by the builder, and reviewed by the verifier against the requirement, not the implementation.

## 12. Corridor phasing (configuration, not code)

`corridors/*.json`, validated by a schema; the engine reads only the corridor record.

| Field | US-USD (phase 1) | UK-GBP (phase 2) | IN (phase 3) |
|---|---|---|---|
| `currency`, `minor_units` | USD, 2 | GBP, 2 | INR absent from the PayPal REST currency list (VERIFIED); quote in USD or GBP for cross-border only |
| buyer and payee countries | US buyer, US payee (or DE pair if the spike shows USD completes) | UK buyer, UK payee | IN buyer paying a non-IN publisher, or IN publisher receiving from abroad |
| `domestic_supported` | true | true | false: India to India refused with `corridor_unsupported` (PayPal ended domestic India payments 1 Apr 2021, VERIFIED) |
| account types | Business payee, Personal buyer | same | cross-border rules UNVERIFIED |
| `min_charge_minor` | UNVERIFIED; spike or doc check | UNVERIFIED | UNVERIFIED |
| fee table | display only, labelled estimate; charging never depends on it; actual fee from `seller_receivable_breakdown` | same | same |
| tax | prices all-in as set by the publisher (the seller); UnitMarket computes no tax; copy says "price set by publisher, includes any taxes they charge". UK VAT and Indian GST obligations are publisher-side questions for an adviser, out of scope | same | same |
| receiving preferences | payee must hold or auto-accept the currency, else PENDING (VERIFIED behaviour) | same | same |

One currency per order everywhere; mixed currency rejected at quote and approval, and PayPal itself refuses `MULTI_CURRENCY_ORDER` (VERIFIED). Adding a corridor is a JSON file, fixtures and a config flag; the acceptance test is the same suite run with the corridor id.

## 13. Security SOP and non-functional coverage

The SOP (`/tmp/claude-0/security-sop.txt`) sections map to design elements and to the MVP that gates them (details per gate in `mvp-plan.md`):

| SOP section | Covered by | Gate |
|---|---|---|
| 1 Dependency currency, 12 supply chain | Pinned versions; owner-approved dependency list; lockfile review; `pnpm audit` and licence check in CI; no package not on the list | A, F |
| 2 Secrets | Section 7.3; gitleaks staged and full history; bundle canary scan | A |
| 3 Database | Section 8 RLS plan; `ums_app` role; no service role in DB path | A (PGlite), C/F (Supabase) |
| 4 AuthN/AuthZ | 9.8; passcode personas; operator role; IDOR tests. Passwords: none stored; passcode hashed with scrypt. MFA: on host, PayPal and Supabase dashboards for the two operators; app-level MFA is a WARN for the demo | A, F |
| 5 Public exposure | Route inventory generated from `withRoute` metadata; CI fails on a route without it | A |
| 6, 19 AI | Scripted model only; untrusted output; no tools that write; injection suite; no spend possible (no API key) | A |
| 7 Input validation | zod strict on every input; parameterised SQL only; no shell; path ids regex-checked | A |
| 8, 9 DoS and rate limits | 9.8 limits, body caps, timeouts; edge DDoS depends on host (D-6) | C |
| 10 Frontend | CSP nonce, HttpOnly cookies, no secrets in bundle, no localStorage for auth | A |
| 11 Production readiness | Generic errors, no debug, health endpoint, backups, runbook | C, F |
| 13 Privacy | Data inventory (buyer display name, passcode session, PayPal payer id hashed, no card data ever); retention; export and delete for buyers (receipts kept as financial records, anonymised) | F |
| 14 Infrastructure | HTTPS only, HSTS, headers, CORS same-origin, host secrets store, rotation note | C |
| 15 Sessions | Section 9.8 | A |
| 16 File upload | Publisher content upload in MVP-E only: size cap, mime sniff server-side, stored as bytea, never executed | E |
| 17 Logging | 9.9; audit log; alert thresholds (unresolved > 30 min, frozen order, webhook 4xx burst, kill switch tripped) | B, C |
| 18 API/object level | IDOR, mass assignment, SSRF (egress guard), webhook signature first | A, C |
| 20 Build | CI gates: lint, typecheck, tests, gitleaks, audit, live-host grep, provenance check; no source maps | A |
| 21 Threat model | `docs/threat-model.md` from sections 2.1 and 7; race tests | B, F |

The non-functional package `nfr.md` (beside this file) is the authority for controls P1 to P19, AI-1 to AI-5 and the PERF, REL, OBS, PRIV, COMP, A11Y, MAINT, PORT, COST, SUP, RLR and INC targets; `mvp-plan.md` cites those ids in every gate. Where this design differs, it says so: webhook cert fetch failure answers 503 not 400 (9.1); the corridor foreign key replaces a literal USD check (8); a stricter `paypal_outbound` switch sits beside RLR-3 (7); no JS SDK, so no public PayPal client id (9.8). Areas covered here: availability (REL-1, one instance with restart policy, external uptime check, `/healthz`), recoverability (startup recovery, 15-min PGlite dumps plus logical export, restore drill in MVP-C, RPO 15 min, RTO 30 min), performance budgets (quote and approval API p95 under 300 ms offline; library page under 1 s; PayPal latency shown as a progress line), observability (logs, debug ids, reconciliation report), accessibility (WCAG 2.2 AA on buyer screens), cost (no paid API; host and Supabase owner-chosen), maintainability (module rules S1 to S7), portability (PGlite to Postgres by config).

## 14. Risks, open questions, cuts

### 14.1 Risks (most likely to break the design first)

1. **DE accounts and USD.** Capture may sit `PENDING` with `RECEIVING_PREFERENCE_MANDATES_MANUAL_ACTION` (VERIFIED mechanism). Mitigation: spike step W5; corridor config lets MVP-B run in EUR on the DE pair if the owner prefers, but the owner's direction says US/USD first, so a US Business payee may be needed (owner decides, O-1).
2. **Idempotency retention of 6 h** versus a 24 h reconcile window. Mitigated by the 5 h resend limit and read-first recovery; a create left unknown past 5 h becomes a recovery case.
3. **Reversal evidence.** No `REVERSED` capture status. Reversal is a verified event plus an operator-confirmed read; access revoke on reversal is manual until a sandbox recording shows the read-back fields.
4. **Multi-payee permission** (`PAYEE_NOT_CONSENTED` exists, 403). MVP-D route depends on the spike.
5. **Webhook cert host and timing** unknown; mitigated by polling being sufficient for correctness.
6. **PGlite is single-connection, in-process**: web and jobs must share one process until Postgres. Hosting must allow one long-lived Node process with a persistent disk.
7. **Bottleneck**: only Vikram and Sakthi can run sandbox steps.

### 14.2 Open items for the owner (essential only)

Q1, Q3, Q4 and Q6 are decided (D-1, D-2, D-3, D-4). Q5 is researched separately (D-6). Remaining:

| # | Question | Recommendation | Blocks |
|---|---|---|---|
| O-1 (was Q2) | Which sandbox accounts: the existing DE pair, a new US Business payee and US Personal buyer, or both? | Create the US pair for US/USD; keep the DE pair for the EUR comparison step of the spike | MVP-B only; MVP-A builds on fixtures |
| O-2 | Approve `axe-core` (or `@axe-core/playwright`) for the accessibility scan of nfr.md A11Y-2 and A11Y-3 | Approve at MVP-C; until then manual checks | MVP-C gate |
| O-3 | Approve the spike (Part R, then Part W separately) and the first `outbound_approvals` scope, with the decision-log row reference | Part R as soon as accounts are chosen | MVP-B |
| O-4 | Approve `@vitest/coverage-v8` (same version line as `vitest`) so the coverage gate of nfr.md MAINT-6 can run | Approve now; without it the coverage gate is reported manually | MVP-A gate (lane 17) |

### 14.3 What I would cut, in order

1. WordPress plugin (MVP-E): keep the signed deep-link format and a static demo page.
2. Composite route D3 (platform fees): use D2.
3. Refunds through the API: refund in the sandbox dashboard, then prove by read-back.
4. Supabase: stay on PGlite disk; keep the `pg` driver and RLS migrations tested offline where possible.
5. Consented identity linking: keep the table and consent record, no UI.
6. UK and India: configuration and labelled fixtures only.

Never cut: the sandbox constant and live block, the kill switch and approval gate, read-back before access, the readiness check before capture, the frozen snapshot, buyer isolation, verified webhooks once hosted, the "Sandbox" label.

Simulation proves modelled cases only, not PayPal compatibility.
