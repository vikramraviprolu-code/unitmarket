# Lane 07: entitlements and the five-day access clock

Task: per-item money, access and licence states with the exhaustive transition table, and the access window driven by an append-only evidence log, with lost-time restoration.
Package: `domain/entitlements`, `domain/access-clock` Owner: Sonnet worker W-07 Reviewer: Opus 5.5 ($, heavy testing)
Wave: 2 (needs lane 01 F3, lane 12 tables `entitlements`, `access_windows`, `access_events`). Size: 8 h. Owner of `applyMoneyEvent`, `computeWindow` and the evidence semantics.

## Goal
An item is available only while money is `captured` from a verified read-back. The window starts when payment is verified and delivery is verified possible (D-2), lasts five days, pauses while UnitMarket cannot deliver, resumes with the lost time added, never shrinks, and ends into history. Refund or reversal revokes. Re-issued links never restart the clock and cost nothing.

## Inputs
- Architecture 4.3, 4.4, 9.4; nfr.md P13, REL-4; requirements: download-and-keep five days to retrieve then keep the copy; online reading five days; history stays; restore lost time; never charge for retry.
- Lane 01 F3: `MoneyState`, `MoneyEvent`, `AccessState`, `LicenceState`, `WindowState`, `AccessEvent`, `AccessEventKind`, `AccessPolicy`, `CoreDeps`.
- Copy and adapt (`/home/user/AIC_Hackathon_UnitMarket` at `a36ddc03fd0b962000f686291c145b50ee337f90`): `packages/core/entitlements/table.ts` and `table.test.ts` (36-cell money table, kept exactly; `REVERSED` now fed only by `reversal_verified`), `entitlements.ts` (compare-and-set `UPDATE ... WHERE id = $1 AND money_state = $before`, transition log order money, access, licence), `entitlements.state.test.ts`. Drop `view48h` logic.

## Outputs
`domain/entitlements/src/{table.ts, entitlements.ts, index.ts}`; `domain/access-clock/src/{compute.ts, events.ts, credit.ts, sweep.ts, index.ts}`; tests.

## Interfaces
```ts
// entitlements
export function nextMoneyState(from: MoneyState, e: MoneyEvent): MoneyState | '=' | 'x';
export function createPendingEntitlements(tx: SqlExecutor, d: CoreDeps, i: { buyer_id: Id; unit_id: Id; items: { article_id: Id; option: AccessOption; policy: AccessPolicy }[] }): Promise<Id[]>;
export function applyMoneyEvent(tx: SqlExecutor, d: CoreDeps, i: { entitlement_id: Id; event: MoneyEvent }): Promise<Result<{ changed: boolean; money: MoneyState; access: AccessState }, { code: 'forbidden_transition' | 'unknown_entitlement' }>>;
export function getEntitlementForBuyer(db: SqlExecutor, i: { entitlement_id: Id; buyer_id: Id }): Promise<EntitlementView | null>; // null for another buyer (P13, 404)
export interface EntitlementView { entitlement_id: Id; buyer_id: Id; article_id: Id; unit_id: Id; option: AccessOption; money: MoneyState; access: AccessState; licence: LicenceState | null; window: WindowState }
// access-clock
export function computeWindow(events: AccessEvent[], policy: AccessPolicy, now: Date): WindowState;   // pure
export function markAccessReady(tx: SqlExecutor, d: CoreDeps, i: { entitlement_id: Id; evidence: { capture_id: string; content_sha256: Sha256Hex; link_probe: 'ok' } }): Promise<WindowState>; // requires money captured
export function recordDeliveryEvent(d: CoreDeps, i: { entitlement_id: Id; kind: Exclude<AccessEventKind, 'access_ready' | 'credit_granted' | 'window_ended' | 'revoked'>; link_id: Id | null; source: 'system' | 'buyer'; evidence: AccessEvent['evidence'] }): Promise<WindowState>;
export function grantCredit(tx: SqlExecutor, d: CoreDeps, i: { entitlement_id: Id; credit_ms: number; case_id: Id; by: Actor }): Promise<Result<WindowState, { code: 'credit_must_be_positive' | 'window_not_started' }>>;
export function revokeWindow(tx: SqlExecutor, d: CoreDeps, i: { entitlement_id: Id; reason: 'refund' | 'reversal' }): Promise<WindowState>;
export function sweepWindows(d: CoreDeps, i: { max_items: number }): Promise<{ ended: number }>;
```
Window rules (pure `computeWindow`, events sorted by `at` then insertion): `access_ready` starts (`started_at = at`, `base_ends_at = at + window_ms`); `delivery_failed` while running pauses (`paused_at`); `delivery_restored` or a successful `download_completed`, `reader_rendered` while paused resumes and adds `ceil_to_hour(resumed_at - paused_at)` to `credit_ms`; `credit_granted` adds its `credit_ms`; `ends_at = base_ends_at + credit_ms`; `now >= ends_at` while running is `ended` (a paused window does not end); `revoked` is terminal. `reader_beacon` (client) never changes the window. The materialised `access_windows` row is updated in the same transaction as each event and must equal `computeWindow` of the log. Access state: `available` while running or paused and money captured; `ended` after the window; `revoked` on refund or reversal. Money `captured` sets licence `granted`; refund or reversal sets `terminated`.

## Acceptance tests
- `corepack pnpm vitest run --project unit domain/entitlements domain/access-clock`: `covers all 36 money cells` (expected from the copied table); `window ends exactly 432000000 ms after access_ready`; `6 h outage adds 6 h; 5 h 10 min outage adds 6 h (round up to hour)`; `paused window never ends`; `credit never reduces ends_at`; `beacon changes nothing`; property tests (2,000 random event sequences): `ends_at never decreases`, `available implies money captured`, `materialised equals recomputed`.
- `--project state domain/entitlements domain/access-clock`: `capture_verified then refund_verified then capture_verified ends refunded and revoked` (PAY-08 event order); `two applies of one event change once`; `markAccessReady refused unless money captured`; `re-issued link 4 days later keeps the same ends_at` (A-18 half); `sweep ends windows at ends_at and records window_ended once`; `keep item after end reads "ended" with history kept; online item reads "ended"` (A-19).
- `--project adversarial domain/entitlements`: `buyer B gets null for buyer A's entitlement` (P13); `direct UPDATE making access available without captured violates the CHECK`.

## Security and NFR gates
P13, REL-4, A-12, A-18, A-19, MAINT-4 (mutation target), MAINT-6.

## Do not
Read real time (use `d.clock`); decide payment outcomes; issue links (lane 09); add dependencies; change contracts; let a buyer signal change the window.

Branch `feat/entitlements-access-clock` Commit `feat(entitlements): three-state items and five-day access clock (SBX-A-07)`.
