# Lane 08: ledger and receipts

Task: the append-only ledger keyed for multiple partial refunds, and immutable versioned receipts that carry the snapshot, capture ids, access windows and delivery evidence.
Package: `domain/ledger`, `domain/receipts` Owner: Sonnet worker W-08 Reviewer: Opus 5.5 ($)
Wave: 2 (needs lane 01 F3, lane 12 tables `ledger_entries`, `receipts`, `orders`, `order_units`, `entitlements`, `access_windows`, `access_events`, `approvals`). Size: 6 h. Owner of `appendLedgerEntry`, `issueReceiptIfChanged`, the receipt body and its hash.

## Goal
Money facts are written once and never edited; corrections are new entries. A receipt exists only after a verified capture, is never edited (a change makes a new version), and the sha256 shown to the buyer equals the stored body's hash.

## Inputs
- Architecture 9.5; nfr.md P11, P12, P16; requirement PAY-09 (receipt hash shown equals stored).
- Lane 01 F3: `LedgerKind`, `LedgerEntryInput`, `LedgerEntry`, `Receipt`, `ReceiptLine`, `ApprovalSnapshot`, `CoreDeps`.
- Lane 06 `canonicalJson`, `contentHash` (import from `@umsbx/approval`).
- Copy and adapt (`/home/user/AIC_Hackathon_UnitMarket` at `a36ddc03fd0b962000f686291c145b50ee337f90`): `packages/core/ledger/ledger.ts` (insert with `ON CONFLICT DO NOTHING`, duplicate returns the existing id, no update function), `ledger.state.test.ts`, `ledger.adversarial.test.ts`; `packages/core/receipts/receipts.ts` (`issueReceiptIfChanged` versioning by body hash), `html.ts` (escape everything), `receipts.state.test.ts`. Change: key `(capture_id, kind, refund_id)` so several partial refunds book (fixes ASM-LED-1).

## Outputs
`domain/ledger/src/{ledger.ts, sums.ts, index.ts}`; `domain/receipts/src/{body.ts, receipts.ts, html.ts, index.ts}`; tests.

## Interfaces
```ts
export function appendLedgerEntry(tx: SqlExecutor, d: Pick<CoreDeps, 'clock' | 'ids' | 'environment'>, e: LedgerEntryInput): Promise<Result<LedgerEntry, { code: 'duplicate'; existing_entry_id: Id }>>;
export function listLedger(db: SqlExecutor, f: { order_id?: Id; unit_id?: Id; capture_id?: string }): Promise<LedgerEntry[]>;
export function unitBalance(entries: LedgerEntry[]): { sold_minor: number; refunded_minor: number; reversed_minor: number; net_minor: number }; // pure
export function issueReceiptIfChanged(tx: SqlExecutor, d: Pick<CoreDeps, 'clock' | 'ids' | 'environment'>, i: { order_id: Id }): Promise<Result<{ receipt_id: Id; version: number; sha256: Sha256Hex; changed: boolean }, { code: 'unknown_order' | 'no_verified_capture' }>>;
export function getReceiptForBuyer(db: SqlExecutor, i: { order_id: Id; buyer_id: Id; version?: number }): Promise<Receipt | null>;   // null for another buyer
export function renderReceiptHtml(r: Receipt, label: 'Dry run' | 'Sandbox'): string;  // every value escaped
```
Rules: amounts are integers; `amount.currency` must equal the order currency; `refund` and `reversal` never exceed `sale` minus earlier refunds for the capture (refuse with a thrown programmer error and an alert from the caller); `platform_fee` is never written in MVP-A (D-3); receipt body = canonical JSON of `{ order_id, snapshot, content_hash, lines, refunds, debug_ids (sanitised to last 6), environment }`; a new version only when the body hash changes; the label comes from `environment` (P16).

## Acceptance tests
- `corepack pnpm vitest run --project unit domain/ledger domain/receipts`: `unitBalance sums`; `html escapes a title containing <script>`; `receipt hash equals sha256 of canonical body`.
- `--project state domain/ledger domain/receipts`: `sale books once per capture`; `two partial refunds with different refund ids both book`; `same refund id twice is duplicate`; `refund above remaining is refused`; `UPDATE and DELETE refused` (P12, A-21); `no receipt before a verified capture`; `refund makes receipt version 2, version 1 unchanged`; `sha256 shown equals stored` (PAY-09); `label Dry run for dryrun and Sandbox for sandbox` (P16, A-22).
- `--project adversarial domain/receipts`: `buyer B gets null for buyer A's receipt`.

## Security and NFR gates
P11 (sums available for reconciliation), P12, P16, A-21, A-22, MAINT-4 (ledger is a mutation target).

## Do not
Add an update or delete path; compute PayPal fees (record observed only); add dependencies; change contracts; touch payments code.

Branch `feat/ledger-receipts` Commit `feat(ledger): append-only ledger and versioned receipts (SBX-A-08)`.
