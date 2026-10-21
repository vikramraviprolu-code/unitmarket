# Lane 09: content delivery, signed links and delivery evidence

Task: the content store over Postgres bytea, signed short-lived links bound to the buyer, the streaming content route logic, the readiness probe used before capture, and delivery evidence.
Package: `domain/delivery` Owner: Sonnet worker W-09 Reviewer: Opus 5.5 ($ for the readiness probe and evidence)
Wave: 2 (needs lane 01 F1 and F3, lane 07 `recordDeliveryEvent`, `getEntitlementForBuyer` (code against the signature), lane 12 tables `content_blobs`, `links`, `access_events`). Size: 6 h. Owner of `ContentStore` implementations, the link token format and `checkReadiness`.

## Goal
Only the buyer who owns an available item gets its bytes, through our route, with no URL that can leak. Before any charge UnitMarket proves it can deliver (object present, hash equals the snapshot, signer works). Delivery evidence is honest: "sent" means the server finished sending.

## Inputs
- Architecture 3 (steps 11, 15), 9.6; nfr.md P13, P14, SOP 16 (no uploads in MVP-A); requirement: record actual delivery evidence; never charge for retry.
- Lane 01: `ContentStore`, `ContentHead`, `Secret`, `CoreDeps`, `AccessEvent`.
- Copy and adapt (`/home/user/AIC_Hackathon_UnitMarket` at `a36ddc03fd0b962000f686291c145b50ee337f90`): `packages/core/entitlements/links.ts` (refusal codes, re-issue never restarts the window) and `links.state.test.ts`.

## Outputs
`domain/delivery/src/{store-pg.ts, link-token.ts, links.ts, serve.ts, readiness.ts, index.ts}`; tests.

## Interfaces
```ts
export function createPgContentStore(db: Database): ContentStore;   // reads content_blobs; sha256 checked on head
export type LinkError = { code: 'not_found' /* other buyer or unknown: 404 */ } | { code: 'not_available'; access: AccessState; money: MoneyState /* own item: 403 */ } | { code: 'window_ended' } | { code: 'store_unavailable' };
export function issueLink(d: CoreDeps & { content: ContentStore }, i: { entitlement_id: Id; actor: Actor }): Promise<Result<{ link_id: Id; url: string /* /c/<token> */; expires_at: IsoUtc }, LinkError>>;
export function makeLinkToken(secret: Secret, i: { link_id: Id; exp_unix: number }): string;   // base64url(link_id.exp.hmac)
export function readLinkToken(secret: Secret, token: string, now: Date): Result<{ link_id: Id }, 'bad_token' | 'expired'>;
export interface ServePlan { status: 200; headers: Record<string, string>; body: AsyncIterable<Uint8Array>; onFinish(sent: { bytes: number; sha256: Sha256Hex }): Promise<void>; onAbort(sent_bytes: number): Promise<void> }
export function planServe(d: CoreDeps & { content: ContentStore }, i: { token: string; actor: Actor; mode: 'download' | 'read' }): Promise<Result<ServePlan, LinkError | { code: 'bad_token' | 'expired' }>>;
export function checkReadiness(d: CoreDeps & { content: ContentStore }, i: { article_id: Id; expected_sha256: Sha256Hex }): Promise<Result<{ link_probe: 'ok'; content_sha256: Sha256Hex }, { code: 'missing' | 'hash_mismatch' | 'signer_failed' | 'store_unavailable' }>>;
```
Rules: link TTL `config.link_ttl_ms` (10 min); token bound to `link_id`, the row binds entitlement and buyer; a token presented under another session is `not_found`. Headers: `Content-Disposition: attachment; filename="<sanitised title>.<ext>"` for download, `inline` for read; `Cache-Control: private, no-store`; `Referrer-Policy: no-referrer`; `X-Content-Type-Options: nosniff`; `Content-Type` from the stored mime. `onFinish` records `download_completed` (or `reader_rendered`) with bytes and sha256 and refuses to record when the sha256 differs (records `delivery_failed` instead); `onAbort` records `download_aborted`; a store error records `delivery_failed` (which pauses the window). Issuing a link writes `link_issued`; it never creates an order or a ledger entry.

## Acceptance tests
- `corepack pnpm vitest run --project unit domain/delivery`: `token round trip; changed byte bad_token; expired`; `filename sanitised against path and header injection`.
- `--project state domain/delivery`: `available item gets a link and bytes with matching sha256 and download_completed evidence`; `aborted stream records download_aborted`; `store failure records delivery_failed and pauses the window` (A-18); `link re-issue keeps ends_at and writes no order or ledger row`; `readiness: missing object, hash mismatch, signer failure each refused` (A-17).
- `--project adversarial domain/delivery`: `buyer B with buyer A's token gets not_found` (P13, A-20); `revoked own item gets not_available`; `every response carries no-store and no-referrer` (P14).

## Security and NFR gates
P13, P14, SOP 16 (no upload path exists), A-17, A-18, A-20.

## Do not
Produce public or long-lived URLs; trust a client-supplied mime or filename; accept uploads; add dependencies; change contracts.

Branch `feat/delivery-links` Commit `feat(delivery): content store, signed links, readiness probe, evidence (SBX-A-09)`.
