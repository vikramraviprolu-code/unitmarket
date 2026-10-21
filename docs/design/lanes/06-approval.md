# Lane 06: approval and frozen snapshot

Task: build the frozen snapshot from a quote or proposal, hash it canonically, issue the single-use approval token, and verify it before any order is written.
Package: `domain/approval` Owner: Sonnet worker W-06 Reviewer: Opus 5.5 ($)
Wave: 2 (needs lane 01 F3, lane 12 tables `approvals`, `quotes`, `proposals`, `offers`, `articles`, `publishers`, `access_policies`, `corridors`). Size: 6 h. Owner of `requestApproval`, `verifyApproval`, `markUsed`, `contentHash`.

## Goal
The buyer approves exactly one frozen offer; every fact later used to charge and deliver comes from this record. Changing any amount, payee, version or option after approval makes the token fail. Approval expires after 15 minutes and is separate from the 24-hour abandonment timer.

## Inputs
- Architecture 3 (steps 3 to 5), 9.3; nfr.md P5, P10, P17, A11Y-5; PAY-06 requirement.
- Lane 01 F3: `ApprovalSnapshot`, `SnapshotItem`, `SnapshotPublisher`, `Approval`, `APPROVAL_TTL_MS`, `Quote`, `CoreDeps`, `Actor`, `AccessPolicy`, `Rights`.
- Copy and adapt (`/home/user/AIC_Hackathon_UnitMarket` at `a36ddc03fd0b962000f686291c145b50ee337f90`): `packages/core/approval/canonical.ts` (canonical JSON; minor-unit fields keyed `_minor` written as decimal strings by the corridor's `minor_units`), `token.ts` (HMAC `approval_id|nonce|content_hash|expires_at`, `timingSafeEqual`), `snapshot.ts` (sorted items and publishers before hashing), `approval.ts` (refusal codes), tests `canonical.test.ts`, `approval.adversarial.test.ts`.

## Outputs
`domain/approval/src/{canonical.ts, token.ts, snapshot.ts, approval.ts, errors.ts, index.ts}` and tests.

## Interfaces
```ts
export type Selection = { kind: 'quote'; quote_id: Id } | { kind: 'proposal'; proposal_id: Id; offer_ids: Id[] /* 1..5 */ };
export type ApprovalError = { code: 'unknown_selection' | 'quote_expired' | 'offer_changed' | 'publisher_unverified' | 'mixed_currency' | 'corridor_unsupported' | 'consent_missing' | 'not_owner' | 'too_many_items' };
export interface ApprovalGranted { approval_id: Id; token: string; expires_at: IsoUtc; snapshot: ApprovalSnapshot; content_hash: Sha256Hex }
export function requestApproval(d: CoreDeps, i: { actor: Actor; selection: Selection; consent: { terms: boolean; identity_share: boolean } }): Promise<Result<ApprovalGranted, ApprovalError>>;
export type VerifyError = { code: 'unknown_approval'; http: 404 } | { code: 'bad_token'; http: 403 } | { code: 'expired'; http: 410 } | { code: 'already_used'; http: 409 } | { code: 'not_owner'; http: 404 } | { code: 'snapshot_tampered'; http: 403 };
export function verifyApproval(tx: SqlExecutor, d: CoreDeps, i: { approval_id: Id; token: string; actor: Actor }): Promise<Result<Approval, VerifyError>>;
export function markUsed(tx: SqlExecutor, d: CoreDeps, i: { approval_id: Id }): Promise<Result<void, { code: 'already_used' }>>; // compare-and-set used_at from null
export function contentHash(s: ApprovalSnapshot): Sha256Hex;
export function canonicalJson(v: unknown, minor_units: 0 | 2 | 3): string;
```
Rules: nonce from `ids.nonce()` (128 bits; the simulation used a counter, ASM-ID-1); `rule_version` and `pricing_rule_version` from `DomainConfig`; snapshot payee from `publishers.paypal_merchant_id` and refused when `payee_verified_at` is null (`publisher_unverified`, nfr.md P18 starts here); policy copied whole from `access_policies`; `platform_fee_minor` always 0 (D-3). `verifyApproval` recomputes the hash from the stored snapshot and compares (`snapshot_tampered`), then token, expiry (`now >= expires_at` is 410), use, owner. Consent `terms` is required; `identity_share` is recorded, not required.

## Acceptance tests
- `corepack pnpm vitest run --project unit domain/approval`: `canonical JSON is key-sorted, whitespace-free, minor units as decimal strings, refuses floats and undefined`; `hash is independent of item and publisher order`; `same snapshot same hash`.
- `--project state domain/approval`: `snapshot freezes offer id and version, terms, payee, amount, currency, option, policy, rights, reader, rule and pricing versions` (A-08); `price change after approval: approval still holds the frozen price`; `mixed currency refused` (A-09); `unverified payee refused`; `expiry at 14:59 valid, 15:00 410` (P17).
- `--project adversarial domain/approval`: `tampered token 403`; `snapshot row edited in DB gives snapshot_tampered 403` (P5); `reused approval 409` (P10); `buyer B with buyer A's approval gives 404`; `nonces unique over 10k and not sequential`.

## Security and NFR gates
P5, P10, P17, P18 (verified payee), A-08, A-09, PAY-06.

## Do not
Write orders (that is payments); call PayPal; add dependencies; change contracts; store the token (store nothing that lets a reader of the DB mint a token).

Branch `feat/approval-snapshot` Commit `feat(approval): frozen snapshot, canonical hash, single-use token (SBX-A-06)`.
