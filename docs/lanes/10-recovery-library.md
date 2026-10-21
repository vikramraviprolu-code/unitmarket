# Lane 10: recovery cases and the buyer library read model

Task: recovery cases that open from system evidence or buyer reports and resolve by restoring access, crediting lost time, closing as not charged, or an operator refund offer; and the library read model that shows every purchase with its window, evidence and receipts.
Package: `domain/recovery`, `domain/library` Owner: Sonnet worker W-10 Reviewer: Opus 5.5
Wave: 3 (needs lanes 01, 07, 08, 09, 12; lane 05a/05b signatures). Size: 6 h. Owner of `openCase`, `resolve` semantics and `LibraryItem`.

## Goal
A buyer never has to coordinate publishers: one plain status per problem, restoration first, lost time given back, never charged for a retry. History stays after a window ends.

## Inputs
- Architecture 4.5, 9.7; nfr.md INC-1, INC-2, P13; requirements: coherent recovery, restore lost time, never charge for retry, history stays, persistent library with correct-buyer isolation.
- Lane 01 F3: `CaseKind`, `CaseState`, `CaseView`, `WindowState`, `Receipt`, `CoreDeps`, `Actor`; lane 07 `grantCredit`, `getEntitlementForBuyer`; lane 09 `issueLink`; lane 08 `getReceiptForBuyer`.

## Outputs
`domain/recovery/src/{cases.ts, rules.ts, messages.ts, index.ts}`; `domain/library/src/{library.ts, index.ts}`; tests.

## Interfaces
```ts
export type CaseError = { code: 'not_found' | 'not_owner' | 'wrong_state' | 'not_operator' | 'duplicate_open' };
export function openCase(d: CoreDeps, i: { kind: CaseKind; order_id?: Id; entitlement_id?: Id; opened_by: 'system' | 'buyer' | 'operator'; actor: Actor; note?: string }): Promise<Result<CaseView, CaseError>>; // one open case per (kind, order or entitlement)
export function diagnose(d: CoreDeps, i: { case_id: Id }): Promise<{ evidence: AccessEvent[]; window: WindowState | null; order_status: OrderStatus | null }>;
export function resolve(d: CoreDeps, i: { case_id: Id; action: 'restore' | 'credit' | 'close_not_charged' | 'offer_refund' | 'close_no_fault'; credit_ms?: number; by: Actor; reason: string }): Promise<Result<CaseView, CaseError>>;
export function applyAutomaticRules(d: CoreDeps, i: { max_items: number }): Promise<{ opened: number; restored: number }>; // run by the job loop; delivery_failed then delivery_restored closes as restored (the clock already applied the measured credit)
export function listCasesForBuyer(db: SqlExecutor, i: { buyer_id: Id }): Promise<CaseView[]>;
export interface LibraryItem { entitlement_id: Id; article_id: Id; title: string; publisher: string; option: AccessOption; access: AccessState; window: WindowState; status_text: string; receipt_versions: number[]; can_open: boolean; open_case: CaseView | null; environment: EnvironmentLabel }
export function getLibrary(db: SqlExecutor, i: { buyer_id: Id }): Promise<LibraryItem[]>;
```
Rules: payments and delivery never call this package; cases come from `alerts` rows and access events. `applyAutomaticRules` opens one case per new alert of kind `frozen_order`, `payment_unresolved`, `partial_composite`, `reversal`, and per `delivery_failed` event, then closes restored delivery cases. `restore` issues a fresh link (free) and records `delivery_restored` when the probe passes; `credit` needs an operator and a positive `credit_ms` and calls `grantCredit`; `close_not_charged` only when the order has no verified capture; `offer_refund` creates a refund request through lane 05b's `requestRefund` (operator); buyer reports with no system evidence wait for an operator; every action appends `recovery_actions` and `audit_log`; buyer messages are plain and short (for example "We could not deliver your copy for 6 hours. We added 6 hours to your access."). Library status texts: "Confirming payment", "Payment pending at PayPal", "Ready, 4 days 23 hours left", "Paused: we are fixing delivery", "Retrieval closed, your copy is yours", "Reading ended", "Refunded", "Not charged".

## Acceptance tests (`corepack pnpm vitest run --project <p> domain/recovery domain/library`)
- state: `delivery failure opens a system case; restore closes it and the window carries the credit` (A-18); `credit by operator extends ends_at; by buyer refused`; `close_not_charged refused when a capture is verified`; `one open case per kind and item`; `library lists ended and refunded items with receipts` (A-19); `status text follows window and money state`.
- adversarial: `buyer B cannot see, open or act on buyer A's cases or library` (A-20, P13); `restore never creates an order, approval or ledger row`.

## Security and NFR gates
P13, INC-1, INC-2 (case side), A-18, A-19, A-20.

## Do not
Charge, capture or create orders; change window rules (lane 07 owns them); add dependencies; change contracts.

Branch `feat/recovery-library` Commit `feat(recovery): recovery cases and buyer library (SBX-A-10)`.
