// discover: propose up to five authorised offers for a stored brief. The model only picks ids from
// the candidates it was given (rule G3 of AIC_Hackathon_UnitMarket packages/core/agent/compose.ts at
// a36ddc03fd0b962000f686291c145b50ee337f90); every price, payee and quote comes from the catalogue
// through startFromOffer. Nothing is bought, approved or substituted here. Owned by SBX.
import { BriefSchema, err, ok } from '@umsbx/contracts';
import type {
  Actor,
  AgentDeps,
  Brief,
  FitCard,
  Id,
  NoMatch,
  Quote,
  Result,
} from '@umsbx/contracts';
import { listAuthorisedOffers } from '@umsbx/catalogue';
import type { OfferView } from '@umsbx/catalogue';
import { startFromOffer } from '@umsbx/offer-entry';
// CHANGE-REQUEST-S1: see brief.ts.
// eslint-disable-next-line no-restricted-imports
import { COMPOSE_SYSTEM, sanitiseModelOutput } from '@umsbx/model';
import { computeFit, rankFit } from '@umsbx/fit';

export const MAX_ITEMS = 5;
const MAX_CANDIDATES = 50;

export type DiscoveryResult =
  | {
      kind: 'proposal';
      proposal_id: Id;
      items: { quote: Quote; fit: FitCard; title: string; publisher: string }[];
    }
  | { kind: 'no_match'; reasons: NoMatch['reason'][] };
export type DiscoverError = { code: 'unknown_brief' | 'not_owner' };

const isRecord = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v);
const noMatch = (reasons: NoMatch['reason'][] = []): Result<DiscoveryResult, DiscoverError> =>
  ok({ kind: 'no_match', reasons });
const iso = (v: unknown): string => new Date(v as string | number | Date).toISOString();

async function loadBrief(d: AgentDeps, id: Id): Promise<Brief | null> {
  const { rows } = await d.db.query<{
    id: string;
    buyer_id: string;
    structured: unknown;
    created_at: unknown;
  }>('SELECT id, buyer_id, structured, created_at FROM briefs WHERE id = $1', [id]);
  const r = rows[0];
  if (!r) return null;
  const s = (typeof r.structured === 'string' ? JSON.parse(r.structured) : r.structured) as object;
  return BriefSchema.parse({
    ...s,
    brief_id: r.id,
    buyer_id: r.buyer_id,
    created_at: iso(r.created_at),
  });
}

// Candidates: authorised current offers in every enabled corridor open to this buyer's country (and
// matching the ceiling's currency when there is one). The newest list is capped for the model.
async function candidatesFor(d: AgentDeps, brief: Brief): Promise<OfferView[]> {
  const buyer = await d.db.query<{ country: string }>('SELECT country FROM buyers WHERE id = $1', [
    brief.buyer_id,
  ]);
  if (!buyer.rows[0]) return [];
  const corridors = await d.db.query<{ id: string; currency: string }>(
    'SELECT id, currency FROM corridors WHERE enabled AND $1 = ANY (buyer_countries) ORDER BY id',
    [buyer.rows[0].country],
  );
  const byId = new Map<string, OfferView>();
  for (const c of corridors.rows) {
    if (brief.ceiling !== null && brief.ceiling.currency !== c.currency) continue;
    const views = await listAuthorisedOffers(d.db, { corridor_id: c.id, limit: MAX_CANDIDATES });
    for (const v of views) byId.set(v.offer.id, v);
  }
  return [...byId.values()]
    .sort((a, b) => (a.offer.id < b.offer.id ? -1 : a.offer.id > b.offer.id ? 1 : 0))
    .slice(0, MAX_CANDIDATES);
}

export async function discover(
  d: AgentDeps,
  i: { actor: Actor; brief_id: Id },
): Promise<Result<DiscoveryResult, DiscoverError>> {
  const brief = await loadBrief(d, i.brief_id);
  if (!brief) return err({ code: 'unknown_brief' });
  if (i.actor.kind !== 'buyer' || i.actor.buyer_id !== brief.buyer_id) {
    return err({ code: 'not_owner' });
  }

  const views = await candidatesFor(d, brief);
  if (views.length === 0) return noMatch();
  const byOffer = new Map(views.map((v) => [v.offer.id, v]));
  const candidateIds = new Set(byOffer.keys());

  // The listing text goes to the model as data, clipped to the contract limits. No price, no payee,
  // no buyer field is part of the input (AI-1, PRIV-2).
  let response;
  try {
    response = await d.model.complete({
      purpose: 'pack_compose',
      system: COMPOSE_SYSTEM,
      input: {
        need: brief.need.slice(0, 2000),
        terms: brief.terms.filter((t) => t.length > 0 && t.length <= 40).slice(0, 12),
        ceiling_minor: brief.ceiling?.minor ?? null,
        candidates: views.map((v) => ({
          offer_id: v.offer.id,
          title: v.article.title.slice(0, 300),
          abstract: v.article.abstract.slice(0, 5000),
          topics: v.article.topics.slice(0, 20).map((t) => t.slice(0, 60)),
        })),
      },
    });
  } catch {
    return noMatch();
  }
  if (response.kind === 'error') return noMatch();

  // AI-5: an id that is not a candidate is dropped, duplicates are dropped, at most five remain,
  // and sanitiseModelOutput strips price-like fields and re-checks the ids.
  const raw = response.output;
  let cleaned: unknown = raw;
  if (isRecord(raw) && Array.isArray(raw.picks)) {
    const seen = new Set<string>();
    const picks = raw.picks.filter((p) => {
      if (!isRecord(p) || typeof p.offer_id !== 'string') return false;
      if (!candidateIds.has(p.offer_id) || seen.has(p.offer_id)) return false;
      seen.add(p.offer_id);
      return true;
    });
    cleaned = { ...raw, picks: picks.slice(0, MAX_ITEMS) };
  }
  const safe = sanitiseModelOutput(cleaned, candidateIds);
  if (!safe.ok) return noMatch();

  // Every pick goes through the same entry as a direct link, so a quote or a no-match reason is
  // exactly what the direct path would give. The model's tool calls are never executed.
  const quoted: { quote: Quote; view: OfferView }[] = [];
  const reasons: NoMatch['reason'][] = [];
  for (const pick of safe.value.picks) {
    const view = byOffer.get(pick.offer_id)!;
    const r = await startFromOffer(d, {
      offer: { offer_id: pick.offer_id },
      actor: i.actor,
      source: 'discovery',
      ...(brief.ceiling !== null ? { ceiling_minor: brief.ceiling.minor } : {}),
      ...(brief.option !== null ? { option: brief.option } : {}),
    });
    if (!r.ok) continue;
    if (r.value.kind === 'quote') quoted.push({ quote: r.value, view });
    else if (!reasons.includes(r.value.reason)) reasons.push(r.value.reason);
  }
  if (quoted.length === 0) return noMatch(reasons);

  const now = d.clock.now();
  const ranked = rankFit(
    quoted.map(({ quote, view }) => ({
      quote,
      view,
      price_minor: quote.price.minor,
      fit: computeFit(
        brief,
        { offer: view.offer, article: view.article, price_minor: quote.price.minor },
        now,
      ),
    })),
  );
  const items = ranked.map((r) => ({
    quote: r.quote,
    fit: r.fit,
    title: r.view.article.title,
    publisher: r.view.publisher.display_name,
  }));

  const proposal_id = d.ids.next('prp');
  const stamp = now.toISOString();
  await d.db.query(
    `INSERT INTO proposals (id, brief_id, buyer_id, items, fit, created_at, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$6)`,
    [
      proposal_id,
      brief.brief_id,
      brief.buyer_id,
      JSON.stringify(items.map((x) => x.quote)),
      JSON.stringify(items.map((x) => x.fit)),
      stamp,
    ],
  );
  return ok({ kind: 'proposal', proposal_id, items });
}
