# Lane 14a: catalogue and the publisher article-specific entry (startFromOffer)

Task: the catalogue read and seed functions, corridor lookup, and `startFromOffer`, which returns a scoped quote or a no-match within the buyer's all-in ceiling and the publisher's authorisation.
Package: `domain/catalogue`, `domain/offer-entry` Owner: Sonnet worker W-14a Reviewer: Opus 5.5
Wave: 2 (needs lane 01 F3, lane 12 tables `publishers`, `articles`, `content_blobs`, `offers`, `publisher_authorisations`, `access_policies`, `corridors`, `quotes`, `entitlements`). Size: 6 h. Owner of `startFromOffer`, `NoMatch` decision order, and the seed data.

## Goal
A buyer arriving from a publisher's article gets an immediate, clear offer or a clear no-match: no crowd wait, no automatic substitution, no purchase, no universal price floor, no wallet. Prices are the publisher's; renegotiation happens only where the publisher allows it.

## Inputs
- Architecture 3 (steps 1 to 2), 9.12, 12; nfr.md SOP 7; adopted requirements (entry paths, affordability, no floor).
- Lane 01 F3: `Offer`, `OfferOption`, `Affordability`, `ArticleFacts`, `PublisherFacts`, `Corridor`, `Quote`, `NoMatch`, `NoMatchReason`, `AccessOption`, `CoreDeps`, `Actor`.
- Copy and adapt (`/home/user/AIC_Hackathon_UnitMarket` at `a36ddc03fd0b962000f686291c145b50ee337f90`): `packages/core/catalogue/offers.ts` (offer view query shape), `packages/core/catalogue/seed.ts` (seed structure). Do not copy `price.ts` (its `LINE_FLOOR_CENTS` floor is dropped) or `veto/rules.articles.json` `line_floor_cents`.

## Outputs
`domain/catalogue/src/{read.ts, corridors.ts, seed.ts, seed-data.ts, index.ts}`; `domain/offer-entry/src/{start.ts, reasons.ts, index.ts}`; `fixtures/catalogue/seed.json` (2 fictional publishers, 8 team-written articles, each with a rights note; at least one article priced 0.40 USD; one offer with renegotiation floor 2.00; one withdrawn offer; one GBP offer on a disabled corridor).

## Interfaces
```ts
// catalogue
export function getOffer(db: SqlExecutor, i: { offer_id: Id } | { publisher_slug: string; offer_code: string }): Promise<{ offer: Offer; article: ArticleFacts; publisher: PublisherFacts } | null>;
export function listAuthorisedOffers(db: SqlExecutor, i: { corridor_id: CorridorId; limit: number }): Promise<{ offer: Offer; article: ArticleFacts; publisher: PublisherFacts }[]>;
export function getCorridor(db: SqlExecutor, id: CorridorId): Promise<Corridor | null>;
export function corridorFor(db: SqlExecutor, i: { currency: CurrencyCode; payee_country: string; buyer_country: string | null }): Promise<Corridor | null>;
export function seedCatalogue(db: Database, clock: Clock, ids: Ids, data: unknown /* validated */): Promise<{ publishers: number; articles: number; offers: number }>;
// offer-entry
export function startFromOffer(d: CoreDeps, i: {
  offer: { offer_id: Id } | { publisher_slug: string; offer_code: string };
  actor: Actor | null; ceiling_minor?: number; option?: AccessOption; proposed_minor?: number;
  source: 'direct' | 'wordpress' | 'discovery';
}): Promise<Result<Quote | NoMatch, { code: 'unknown_offer' | 'invalid_input' }>>;
```
Decision order (first that applies): offer missing: `unknown_offer`; status `withdrawn` or `superseded_by` set or outside validity: `no_match withdrawn`; no authorisation row for this offer version or status not `authorised`: `not_authorised`; corridor not found, disabled, or domestic-only rule broken (`domestic_supported = false` and buyer country equals payee country): `corridor_unsupported`; requested option not in `options`: `option_not_offered`; buyer already holds an available or running entitlement for the article: `already_owned`; price = option price, or `proposed_minor` when `affordability.renegotiation_allowed` and `proposed_minor >= floor_minor` (below: `below_publisher_floor`; proposal on an offer without renegotiation: `below_publisher_floor` when lower, ignored when higher); price above `ceiling_minor`: `above_ceiling`; else a quote valid 15 min, stored in `quotes`. Corridor `min_charge_minor`, when set, is a corridor rule, not a UnitMarket floor. A no-match never carries an alternative offer.

## Acceptance tests
- `corepack pnpm vitest run --project state domain/catalogue domain/offer-entry`: `seed loads 2 publishers, 8 articles, rights notes present, no URL to paywalled text` (PAY-01); `quote within ceiling, valid 15 min` (A-05); `ceiling below price gives above_ceiling and no alternative` (A-05); `0.40 USD offer quotes 0.40` (A-06); `renegotiation: 2.50 accepted at 2.50, 1.90 below_publisher_floor, offer without renegotiation refuses lower` (A-07); `withdrawn, unauthorised, disabled corridor, already owned each give their reason`; `India to India corridor refused as corridor_unsupported` (corridor fixture with domestic_supported false).
- `--project adversarial domain/offer-entry`: `price or payee in the input is ignored (strict schema refuses unknown keys)`; `offer_code with path characters is invalid_input`.

## Security and NFR gates
SOP 7, A-05, A-06, A-07, PERF-2 (quote under 300 ms p95 offline, measured in lane 18).

## Do not
Apply any universal floor; substitute offers; read model output; call PayPal; add dependencies; change contracts; seed real publisher brands or real paywalled text.

Branch `feat/catalogue-offer-entry` Commit `feat(offer-entry): catalogue, corridors and startFromOffer (SBX-A-14a)`.
