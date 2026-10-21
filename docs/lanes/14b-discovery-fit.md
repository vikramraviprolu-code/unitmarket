# Lane 14b: agent-led discovery and buyer-fit cards

Task: need-and-budget discovery over authorised offers with the scripted model, plus the pure `computeFit` that produces honest visual fit data.
Package: `domain/discovery`, `domain/fit` Owner: Sonnet worker W-14b Reviewer: Opus 5.5 (fit honesty)
Wave: 2 (needs lane 01 F3, lane 13 `createScriptedModel`, `sanitiseModelOutput`, lane 14a `listAuthorisedOffers`, `startFromOffer` (signatures frozen in their specs), lane 12 tables `briefs`, `proposals`). Size: 6 h. Owner of `computeFit` and the `FitCard` rules.

## Goal
A buyer states a need and a ceiling; UnitMarket proposes up to five authorised offers, each with a fit card whose every level is traceable to facts, ranked by fit, and the buyer chooses. Nothing is bought, substituted or approved automatically. No fabricated scores.

## Inputs
- Architecture 3 (agent-led path), 9.10, 9.11; nfr.md AI-1 to AI-5, PRIV-2; requirements: buyer-fit ranking and buyer choice; visual match rating, intuitive, not text heavy, no fabricated scores.
- Lane 01 F3: `Brief`, `FitCard`, `FitDimension`, `Offer`, `ArticleFacts`, `AgentDeps`, `Quote`, `NoMatch`.
- Copy and adapt (`/home/user/AIC_Hackathon_UnitMarket` at `a36ddc03fd0b962000f686291c145b50ee337f90`): `packages/core/agent/compose.ts` rule G3 (every money field from the catalogue, model picks only ids) and `packages/core/catalogue/search.ts` (term matching idea).

## Outputs
`domain/discovery/src/{brief.ts, discover.ts, index.ts}`; `domain/fit/src/{compute.ts, levels.ts, index.ts}`; tests.

## Interfaces
```ts
// discovery
export function parseNeed(d: AgentDeps, i: { actor: Actor; text: string }): Promise<Result<Brief, { code: 'too_long' | 'unparseable' | 'model_error' | 'not_buyer' }>>;
export type DiscoveryResult = { kind: 'proposal'; proposal_id: Id; items: { quote: Quote; fit: FitCard; title: string; publisher: string }[] } | { kind: 'no_match'; reasons: NoMatch['reason'][] };
export function discover(d: AgentDeps, i: { actor: Actor; brief_id: Id }): Promise<Result<DiscoveryResult, { code: 'unknown_brief' | 'not_owner' }>>;
// fit (pure)
export function computeFit(brief: Brief, facts: { offer: Offer; article: ArticleFacts; price_minor: number }, now: Date): FitCard;
```
Fit rules (levels 0 to 3, or null when the input is missing): topic = share of brief terms found in title, abstract or topics (0: none, 1: up to a third, 2: up to two thirds, 3: more), evidence `"<k> of <n> terms"`; budget = price against ceiling (null without ceiling; 3: at most half, 2: at most three quarters, 1: at most the ceiling; over the ceiling never appears because `startFromOffer` refuses it), evidence `"$4.00 of your $6.00"` formatted by corridor minor units; access = 3 when the requested option is offered, null when the brief names none; language = 3 equal, 0 different, null unknown; recency = by age of `published_at` (3: under 30 days, 2: under 1 year, 1: older). Band from dimensions only: `strong` when no level below 2 and at least three non-null; `good` when the mean of non-null levels is at least 1.5; `partial` otherwise; null when fewer than two dimensions are non-null. Ranking: band, then sum of levels, then price, then offer id. Each candidate goes through `startFromOffer` (source `discovery`), so no-match reasons are the same as the direct path; the proposal lists only quotes.

## Acceptance tests
- `corepack pnpm vitest run --project unit domain/fit`: `each dimension level from its rule with an evidence string`; `missing ceiling gives budget null, never a guess`; `band derived only from levels`; `same inputs same card` (property, 500 runs); `no field anywhere holds a percentage or probability` (B-10 starts here).
- `--project state domain/discovery`: `brief "climate adaptation for cities, under $6, read online, English" yields at most 5 quotes, all authorised, all within the ceiling`; `nothing fits gives no_match with reasons and no order or approval rows`; `model picking an id outside candidates is dropped` (AI-5).
- `--project adversarial domain/discovery`: `30 injected listings: no price, payee or approval effect` (AI-1); `brief over 2,000 chars refused` (AI-4); `prompt input holds no buyer id, name or email` (PRIV-2).

## Security and NFR gates
AI-1, AI-2, AI-4, AI-5, PRIV-2, S4 isolation, PERF-2.

## Do not
Create approvals or orders; import payments, approval, entitlements, paypal, safety or transport; invent scores; add dependencies; change contracts.

Branch `feat/discovery-fit` Commit `feat(discovery): need-and-budget discovery and honest fit cards (SBX-A-14b)`.
