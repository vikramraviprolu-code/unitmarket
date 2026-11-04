// startFromOffer: the publisher article-specific entry (architecture 3 steps 1 to 2, 9.12).
// Returns a scoped 15-minute Quote or a NoMatch with a reason. Price comes only from the offer's
// publisher-set option prices (or a permitted renegotiation at or above the publisher's floor).
// There is no universal price floor, no substitution, no purchase and no PayPal call here.
import { AccessOptionSchema, ActorSchema, IdSchema, err, ok } from '@umsbx/contracts';
import type {
  AccessOption,
  Actor,
  CoreDeps,
  Id,
  NoMatch,
  OfferOption,
  Quote,
  Result,
} from '@umsbx/contracts';
import { corridorFor, getOffer } from '@umsbx/catalogue';
import { noMatch } from './reasons';

export const QUOTE_TTL_MS = 15 * 60 * 1000;

export type OfferRef = { offer_id: Id } | { publisher_slug: string; offer_code: string };
export interface StartFromOfferInput {
  offer: OfferRef;
  actor: Actor | null;
  ceiling_minor?: number;
  option?: AccessOption;
  proposed_minor?: number;
  source: 'direct' | 'wordpress' | 'discovery';
}
export type EntryError = { code: 'unknown_offer' | 'invalid_input' };

const invalid = err<EntryError>({ code: 'invalid_input' });
const SLUG = /^[a-z0-9][a-z0-9-]{0,63}$/;
const CODE = /^[A-Za-z0-9_-]{1,64}$/;
const SOURCES = ['direct', 'wordpress', 'discovery'] as const;
const KEYS = ['offer', 'actor', 'ceiling_minor', 'option', 'proposed_minor', 'source'];

const isRecord = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v);
// Strict: every own key must be on the list (this includes "__proto__" from JSON.parse).
const onlyKeys = (r: Record<string, unknown>, allowed: string[]): boolean =>
  Object.keys(r).every((k) => allowed.includes(k));
const minor = (v: unknown): v is number =>
  typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;

function parseInput(raw: unknown): StartFromOfferInput | null {
  if (!isRecord(raw) || !onlyKeys(raw, KEYS)) return null;
  const o = raw.offer;
  let offer: OfferRef;
  if (!isRecord(o)) return null;
  if ('offer_id' in o) {
    const id = IdSchema.safeParse(o.offer_id);
    if (!onlyKeys(o, ['offer_id']) || !id.success || id.data.length === 0) return null;
    offer = { offer_id: id.data };
  } else {
    if (!onlyKeys(o, ['publisher_slug', 'offer_code'])) return null;
    const { publisher_slug: s, offer_code: c } = o;
    if (typeof s !== 'string' || typeof c !== 'string' || !SLUG.test(s) || !CODE.test(c))
      return null;
    offer = { publisher_slug: s, offer_code: c };
  }
  if (!SOURCES.includes(raw.source as (typeof SOURCES)[number])) return null;
  let actor: Actor | null = null;
  if (raw.actor != null) {
    const a = ActorSchema.safeParse(raw.actor);
    if (!a.success) return null;
    actor = a.data;
  }
  const out: StartFromOfferInput = {
    offer,
    actor,
    source: raw.source as StartFromOfferInput['source'],
  };
  if (raw.ceiling_minor !== undefined) {
    if (!minor(raw.ceiling_minor)) return null;
    out.ceiling_minor = raw.ceiling_minor;
  }
  if (raw.proposed_minor !== undefined) {
    if (!minor(raw.proposed_minor)) return null;
    out.proposed_minor = raw.proposed_minor;
  }
  if (raw.option !== undefined) {
    const p = AccessOptionSchema.safeParse(raw.option);
    if (!p.success) return null;
    out.option = p.data;
  }
  return out;
}

// Cheapest option; the first listed wins a tie (ASM-14A-2).
const cheapest = (options: OfferOption[]): OfferOption | undefined =>
  options.reduce<OfferOption | undefined>(
    (best, o) => (best === undefined || o.price_minor < best.price_minor ? o : best),
    undefined,
  );

export async function startFromOffer(
  d: CoreDeps,
  input: StartFromOfferInput,
): Promise<Result<Quote | NoMatch, EntryError>> {
  const i = parseInput(input);
  if (!i) return invalid;

  // Only a buyer actor has a country and a library; any other actor is treated as anonymous.
  let buyerId: Id | null = null;
  let buyerCountry: string | null = null;
  if (i.actor?.kind === 'buyer') {
    const { rows } = await d.db.query<{ country: string }>(
      'SELECT country FROM buyers WHERE id = $1',
      [i.actor.buyer_id],
    );
    if (!rows[0]) return invalid;
    buyerId = i.actor.buyer_id;
    buyerCountry = rows[0].country;
  }

  // 1. offer missing
  const found = await getOffer(d.db, i.offer);
  if (!found) return err({ code: 'unknown_offer' });
  const { offer, article, publisher } = found;
  const nowMs = d.clock.now().getTime();

  // 2. withdrawn, superseded or outside validity
  if (
    offer.status === 'withdrawn' ||
    offer.superseded_by !== null ||
    nowMs < Date.parse(offer.valid_from) ||
    (offer.valid_until !== null && nowMs >= Date.parse(offer.valid_until))
  ) {
    return ok(noMatch('withdrawn'));
  }

  // 3. the publisher authorised this offer version
  const auth = await d.db.query(
    'SELECT 1 AS x FROM publisher_authorisations WHERE offer_id = $1 AND offer_version = $2 LIMIT 1',
    [offer.id, offer.version],
  );
  if (auth.rows.length === 0 || offer.status !== 'authorised') return ok(noMatch('not_authorised'));

  // 3b. a publisher that is not active (suspended, or not yet approved) sells nothing (PUB-D)
  const pub = await d.db.query<{ status: string }>('SELECT status FROM publishers WHERE id = $1', [
    offer.publisher_id,
  ]);
  if (pub.rows[0]?.status !== 'active') return ok(noMatch('not_authorised'));

  // 4. corridor: exists, enabled, and the domestic-only rule holds. The corridor follows the offer's
  // currency and the publisher's country; the buyer's country is data, not a gate (D-084 3).
  const corridor = await corridorFor(d.db, {
    currency: offer.currency,
    payee_country: publisher.country,
    buyer_country: null,
  });
  if (
    !corridor ||
    !corridor.enabled ||
    (!corridor.domestic_supported && buyerCountry !== null && buyerCountry === publisher.country)
  ) {
    return ok(noMatch('corridor_unsupported'));
  }

  // 5. requested option
  const chosen =
    i.option === undefined
      ? cheapest(offer.options)
      : offer.options.find((o) => o.option === i.option);
  if (!chosen) return ok(noMatch('option_not_offered'));

  // 6. already holds the article: money pending, unknown or captured and access not ended or
  // revoked, so also a locked entitlement with a capture in flight or access paused (FIX-05A H3).
  // domain/payments placeOrder and the partial unique index entitlements_one_active_per_buyer_article
  // use the same set. GATEFIX2: when every such hold is an open unpaid order (the buyer left the pay
  // page: the order waits, no PayPal order is approved, nothing is paid), the answer is unpaid_order,
  // not already_owned, so the buyer is told to continue or cancel the order, not that the article is
  // in the library. The test is the one the library uses (buyerStatusText, isUnpaidOpenOrder).
  if (buyerId !== null) {
    const owned = await d.db.query<{ unpaid: boolean }>(
      `SELECT (o.status IN ('awaiting_buyer', 'created')
               AND COALESCE(p.state, '') <> 'approved'
               AND e.money_state IN ('unknown', 'pending')
               AND u.status <> 'pending') AS unpaid
         FROM entitlements e
         LEFT JOIN order_units u ON u.id = e.unit_id
         LEFT JOIN orders o ON o.id = u.order_id
         LEFT JOIN provider_orders p ON p.id = u.provider_order_ref
        WHERE e.buyer_id = $1 AND e.article_id = $2
          AND e.money_state IN ('pending', 'captured', 'unknown')
          AND e.access_state IN ('locked', 'available')`,
      [buyerId, article.id],
    );
    if (owned.rows.length > 0) {
      return ok(
        noMatch(owned.rows.every((r) => r.unpaid === true) ? 'unpaid_order' : 'already_owned'),
      );
    }
  }

  // 7. price: the publisher's option price, or a permitted proposal. The proposal never raises it.
  let price = chosen.price_minor;
  if (i.proposed_minor !== undefined) {
    const { renegotiation_allowed, floor_minor } = offer.affordability;
    if (renegotiation_allowed && floor_minor !== null) {
      if (i.proposed_minor < floor_minor) return ok(noMatch('below_publisher_floor'));
      price = Math.min(price, i.proposed_minor);
    } else if (i.proposed_minor < price) {
      return ok(noMatch('below_publisher_floor'));
    }
  }
  // The corridor's own minimum charge is a corridor rule, not a UnitMarket floor (ASM-14A-5).
  if (corridor.min_charge_minor !== null && price < corridor.min_charge_minor) {
    return ok(noMatch('corridor_unsupported'));
  }
  if (i.ceiling_minor !== undefined && price > i.ceiling_minor) return ok(noMatch('above_ceiling'));

  // 8. quote, valid 15 minutes, stored
  const now = d.clock.now();
  const quote: Quote = {
    kind: 'quote',
    quote_id: d.ids.next('quo'),
    offer_id: offer.id,
    offer_version: offer.version,
    option: chosen.option,
    price: { currency: offer.currency, minor: price },
    corridor_id: corridor.id,
    expires_at: new Date(nowMs + QUOTE_TTL_MS).toISOString(),
    source: i.source,
  };
  await d.db.query(
    `INSERT INTO quotes (id, buyer_id, offer_id, offer_version, option, price_minor, currency, corridor_id, source, expires_at, created_at, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$11)`,
    [
      quote.quote_id,
      buyerId,
      quote.offer_id,
      quote.offer_version,
      quote.option,
      price,
      offer.currency,
      quote.corridor_id,
      quote.source,
      quote.expires_at,
      now.toISOString(),
    ],
  );
  return ok(quote);
}
