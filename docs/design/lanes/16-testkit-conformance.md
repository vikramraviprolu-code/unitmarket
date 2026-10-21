# Lane 16: test kit and the adapter conformance suite

Task: shared test helpers (fresh PGlite with schema, fake clock and ids, seeded catalogue, dry-run PayPal stack) and the portable conformance suite for `PayPalPort`, runnable against the dry-run transport in CI and, later, against the sandbox by the owner only.
Package: `packages/testkit` Owner: Sonnet worker W-16 Reviewer: Opus 5.5 ($)
Wave: 3 (needs lanes 01, 03, 04, 12, 14a). Size: 6 h. Owner of `describePayPalConformance` and the case list.

## Goal
One suite defines what "behaves like PayPal for our purposes" means. It is written from verified PayPal facts and the adopted rules, never edited to make an implementation pass. Sandbox runs are impossible unless the owner opens every gate.

## Inputs
- Architecture 0, 9.1, 11; nfr.md MAINT-3, MAINT-5.
- Copy and adapt (`/home/user/AIC_Hackathon_UnitMarket` at `a36ddc03fd0b962000f686291c145b50ee337f90`): `packages/testkit/src/conformance.ts` (C1 to C15 structure, helpers that parse every answer with its schema, subject shape `{ name, make(), orderRequest() }`), and its S1 to S6 cases rewritten as dry-run scenarios (pending then completed, pending then declined, lost response, all declined, partial 207) under the name D1 to D6.

## Outputs
`packages/testkit/src/{db.ts, clock.ts, stack.ts, catalogue.ts, conformance.ts, scenarios.ts, index.ts}`; `packages/paypal/src/paypal.dryrun.contract.test.ts` (calls the suite with the dry-run subject); `packages/paypal/src/paypal.sandbox.contract.test.ts` (skipped unless `UMS_SANDBOX_TESTS=1`; the subject is built from `@umsbx/config` so all gates apply; MVP-A ships it skipped).

## Interfaces
```ts
export function testDb(): Promise<Database & { close(): Promise<void> }>;            // PGlite memory, migrated, seeded switches, corridor, policies
export function testDeps(o?: { start?: IsoUtc; scenario?: string }): Promise<PaymentsDeps & AgentDeps & { clock: ReturnType<typeof fakeClock>; transport: Transport; calls(): OutboundRequest[] }>;
export function seedTestCatalogue(db: Database): Promise<{ offer_ids: Id[]; publisher_ids: Id[] }>;
export interface ConformanceHooks { approve(provider_order_id: ProviderOrderId): Promise<void>; scenario(name: string): void }
export interface ConformanceSubject { name: string; make(): Promise<{ port: PayPalPort; hooks: ConformanceHooks }>; orderRequest(): CreateOrderReq }
export function describePayPalConformance(s: ConformanceSubject): void;   // P1 to P15 below
export function describeDryRunOnly(s: ConformanceSubject): void;           // D1 to D6
```
Cases (expected results from verified facts): P1 create gives `created` with an approve URL on `www.sandbox.paypal.com`; P2 same request id twice gives the same order id; P3 read before approval gives `CREATED` (or `PAYER_ACTION_REQUIRED`) with units, amounts and `custom_id` echoed; P4 read after approve gives `APPROVED`; P5 capture gives a claim with `COMPLETED` units and capture ids; P6 capture again with the same key gives the same capture ids; P7 capture with a new key after capture gives `rejected` `ORDER_ALREADY_CAPTURED`; P8 read after capture gives `COMPLETED` with matching capture ids and `read_at` in UTC with Z; P9 unknown order id gives `not_found`; P10 capture before approval gives `rejected` `ORDER_NOT_APPROVED`; P11 every result parses with its contracts schema and carries the environment; P12 amounts round-trip exactly; P13 one currency per read; P14 a request id over 108 characters is refused before sending; P15 no call leaves for a host other than the sandbox constant (transport spy). D1 pending then completed; D2 pending then declined; D3 lost capture response then read `COMPLETED`; D4 202 then read; D5 207 partial; D6 429 then success with backoff hint.

## Acceptance tests
- `corepack pnpm vitest run --project contract packages/paypal`: P1 to P15 and D1 to D6 green against the dry-run subject (A-24).
- `UMS_SANDBOX_TESTS` unset: the sandbox file reports skipped, opens no socket (spied).
- `--project unit packages/testkit`: `testDb is migrated and isolated per call`; `testDeps transport is dry-run and every call is recorded`.

## Security and NFR gates
MAINT-3, MAINT-5, A-23, A-24, P15.

## Do not
Edit a case to make an implementation pass (raise it with the reviewer); enable the sandbox subject; read credentials; add dependencies; change contracts.

Branch `feat/testkit-conformance` Commit `feat(testkit): test stack and PayPal conformance suite (SBX-A-16)`.
