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
  Money,
  NoMatch,
  Quote,
  Result,
} from '@umsbx/contracts';
import { listAuthorisedOffers } from '@umsbx/catalogue';
import type { OfferView } from '@umsbx/catalogue';
import { startFromOffer } from '@umsbx/offer-entry';
// CHANGE-REQUEST-S1: see brief.ts.

import { COMPOSE_SYSTEM, sanitiseModelOutput } from '@umsbx/model';
import { computeFit, rankFit } from '@umsbx/fit';

export const MAX_ITEMS = 5;
const MAX_CANDIDATES = 50;

/**
 * MC2-L5: converts minor units between currencies at the stored rate, or answers null when there is no usable
 * rate. Injected, so discovery never reads the rate table. The caller rounds half away from zero.
 */
export type ConvertFn = (i: { minor: number; from: string; to: string }) => number | null;

/**
 * A ceiling compared on the converted price (D-084 item 4): the buyer's ceiling and the offer price converted
 * into the ceiling's currency. The quote itself stays in the offer's currency; this is only what was compared.
 */
export interface CeilingCheck {
  ceiling: Money;
  price: Money;
}

export type DiscoveryResult =
  | {
      kind: 'proposal';
      proposal_id: Id;
      items: {
        quote: Quote;
        fit: FitCard;
        title: string;
        publisher: string;
        ceiling_check?: CeilingCheck;
      }[];
    }
  | {
      kind: 'no_match';
      reasons: NoMatch['reason'][];
      /**
       * MC2-L5: set (true) only when an offer in another currency than the ceiling could not be compared
       * because no usable rate was available. The buyer is told; nothing is proposed on a guess.
       */
      rate_missing?: true;
    };
// One code for a missing brief and for someone else's brief, so the answer reveals nothing (L1).
// 'unknown_brief' and 'not_owner' stay in the type for older callers and are no longer returned.
export type DiscoverError = { code: 'not_found' | 'unknown_brief' | 'not_owner' };

const isRecord = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v);
const noMatch = (
  reasons: NoMatch['reason'][] = [],
  rateMissing = false,
): Result<DiscoveryResult, DiscoverError> =>
  ok({ kind: 'no_match', reasons, ...(rateMissing ? { rate_missing: true as const } : {}) });

// A convert function that throws is the same as one with no usable rate: never an exception into the buyer's
// search.
const safeConvert = (convert: ConvertFn | undefined): ConvertFn | undefined =>
  convert === undefined
    ? undefined
    : (c) => {
        try {
          const m = convert(c);
          return typeof m === 'number' && Number.isSafeInteger(m) ? m : null;
        } catch {
          return null;
        }
      };
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

// Candidates: authorised current offers in every enabled corridor. The buyer's country is data, not a gate
// (D-084 3). With a ceiling, a corridor whose currency differs from the ceiling's counts only when the stored
// rate can convert it (D-084 4); with no usable rate only the ceiling's own currency counts, as before. The
// newest list is capped for the model.
async function candidatesFor(
  d: AgentDeps,
  brief: Brief,
  convert: ConvertFn | undefined,
): Promise<{ views: OfferView[]; no_rate: boolean }> {
  const buyer = await d.db.query<{ country: string }>('SELECT country FROM buyers WHERE id = $1', [
    brief.buyer_id,
  ]);
  if (!buyer.rows[0]) return { views: [], no_rate: false };
  const corridors = await d.db.query<{ id: string; currency: string }>(
    'SELECT id, currency FROM corridors WHERE enabled ORDER BY id',
  );
  const byId = new Map<string, OfferView>();
  let noRate = false;
  for (const c of corridors.rows) {
    if (
      brief.ceiling !== null &&
      brief.ceiling.currency !== c.currency &&
      !canConvert(convert, c.currency, brief.ceiling.currency)
    ) {
      // Left out for want of a rate: the buyer is told when this leaves them with nothing, but only if the
      // corridor actually has an offer.
      if ((await listAuthorisedOffers(d.db, { corridor_id: c.id, limit: 1 })).length > 0)
        noRate = true;
      continue;
    }
    const views = await listAuthorisedOffers(d.db, { corridor_id: c.id, limit: MAX_CANDIDATES });
    for (const v of views) byId.set(v.offer.id, v);
  }
  const views = [...byId.values()]
    .sort((a, b) => (a.offer.id < b.offer.id ? -1 : a.offer.id > b.offer.id ? 1 : 0))
    .slice(0, MAX_CANDIDATES);
  return { views, no_rate: noRate };
}

const canConvert = (convert: ConvertFn | undefined, from: string, to: string): boolean =>
  convert !== undefined && convert({ minor: 100, from, to }) !== null;

export async function discover(
  d: AgentDeps,
  i: { actor: Actor; brief_id: Id; convert?: ConvertFn },
): Promise<Result<DiscoveryResult, DiscoverError>> {
  const brief = await loadBrief(d, i.brief_id);
  if (!brief) return err({ code: 'not_found' });
  if (i.actor.kind !== 'buyer' || i.actor.buyer_id !== brief.buyer_id) {
    return err({ code: 'not_found' });
  }

  const convert = safeConvert(i.convert);
  const { views, no_rate } = await candidatesFor(d, brief, convert);
  let rateMissing = no_rate;
  if (views.length === 0) return noMatch([], rateMissing);
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
  // MC2-L5: a ceiling in the offer's own currency is checked by the entry, as before. A ceiling in another
  // currency is checked here on the offer price converted into the ceiling currency (half away from zero,
  // inclusive); the quote stays in the offer's currency and nothing stored is converted.
  const quoted: { quote: Quote; view: OfferView; check: CeilingCheck | null }[] = [];
  const reasons: NoMatch['reason'][] = [];
  for (const pick of safe.value.picks) {
    const view = byOffer.get(pick.offer_id)!;
    const cross = brief.ceiling !== null && view.offer.currency !== brief.ceiling.currency;
    const r = await startFromOffer(d, {
      offer: { offer_id: pick.offer_id },
      actor: i.actor,
      source: 'discovery',
      ...(brief.ceiling !== null && !cross ? { ceiling_minor: brief.ceiling.minor } : {}),
      ...(brief.option !== null ? { option: brief.option } : {}),
    });
    if (!r.ok) continue;
    if (r.value.kind !== 'quote') {
      if (!reasons.includes(r.value.reason)) reasons.push(r.value.reason);
      continue;
    }
    let check: CeilingCheck | null = null;
    if (cross && brief.ceiling !== null) {
      const minor = convert?.({
        minor: r.value.price.minor,
        from: view.offer.currency,
        to: brief.ceiling.currency,
      });
      if (minor === undefined || minor === null) {
        // No usable rate for this price: it is not proposed, and the buyer is told why if nothing is left.
        rateMissing = true;
        continue;
      }
      if (minor > brief.ceiling.minor) {
        if (!reasons.includes('above_ceiling')) reasons.push('above_ceiling');
        continue;
      }
      check = {
        ceiling: { currency: brief.ceiling.currency, minor: brief.ceiling.minor },
        price: { currency: brief.ceiling.currency, minor },
      };
    }
    quoted.push({ quote: r.value, view, check });
  }
  if (quoted.length === 0) return noMatch(reasons, rateMissing);

  const now = d.clock.now();
  const ranked = rankFit(
    quoted.map(({ quote, view, check }) => {
      // A converted item is judged in the ceiling's currency, so the budget row compares like with like;
      // its evidence says "about" because the price was converted.
      const offer = check === null ? view.offer : { ...view.offer, currency: check.price.currency };
      const price_minor = check === null ? quote.price.minor : check.price.minor;
      const fit = computeFit(brief, { offer, article: view.article, price_minor }, now);
      return {
        quote,
        view,
        check,
        price_minor,
        fit:
          check === null
            ? fit
            : {
                ...fit,
                dimensions: fit.dimensions.map((x) =>
                  x.key === 'budget' && x.level !== null
                    ? { ...x, evidence: `about ${x.evidence}` }
                    : x,
                ),
              },
      };
    }),
  );
  const items = ranked.map((r) => ({
    quote: r.quote,
    fit: r.fit,
    title: r.view.article.title,
    publisher: r.view.publisher.display_name,
    ...(r.check !== null ? { ceiling_check: r.check } : {}),
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
