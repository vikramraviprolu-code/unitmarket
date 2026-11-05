// INT-SEL / SEL.7, SEL.8: per-offer and per-option figures from units, as pure functions. A unit's money is
// the statement money: gross (the sale row), refunds, reversals; net is gross minus refunds minus reversals and
// the PayPal fee is never part of it (F3). A unit that holds several offers counts once toward each of them,
// and each money part is split evenly across its distinct offers in minor units, with the remainder to the
// lowest offer id, so the per-offer nets add up to the statement net (R2-1). Offers have one row per
// version, so the callers hand over distinct offer ids and each (unit, offer id) pair counts once (R2-2).
// Pure: no server module, no clock, no randomness.
import type { EnvironmentLabel } from '@umsbx/contracts';

export interface UnitOffer {
  offer_id: string;
  option: string;
}

/** One captured unit of one seller with its ledger money and the offers it holds. */
export interface UnitMoney {
  unit_id: string;
  currency: string;
  environment: EnvironmentLabel;
  channel: 'human' | 'agent';
  gross_minor: number;
  refunds_minor: number;
  reversals_minor: number;
  offers: readonly UnitOffer[];
}

export interface OfferFigures {
  offer_id: string;
  currency: string;
  environment: EnvironmentLabel;
  /** Units that hold this offer. A unit with several offers counts toward each. */
  units: number;
  gross_minor: number;
  refunds_minor: number;
  reversals_minor: number;
  /** Gross minus refunds minus reversals, over this offer's share of each unit. */
  net_minor: number;
}

export interface OptionFigures extends OfferFigures {
  option: string;
}

const sorted = (keys: readonly string[]): string[] => [...new Set(keys)].sort();

/** Split `total` evenly over the keys (sorted, each once); the remainder goes to the lowest key. */
export function splitMinor(total: number, keys: readonly string[]): Map<string, number> {
  const ks = sorted(keys);
  const out = new Map<string, number>();
  if (ks.length === 0) return out;
  const base = Math.floor(total / ks.length);
  const rest = total - base * ks.length;
  ks.forEach((k, i) => out.set(k, i === 0 ? base + rest : base));
  return out;
}

const SEP = '\u0000';

interface Acc {
  key: string;
  offer_id: string;
  option: string;
  currency: string;
  environment: EnvironmentLabel;
  units: number;
  gross: number;
  refunds: number;
  reversals: number;
}

function accumulate(rows: readonly UnitMoney[], keyOf: (o: UnitOffer) => string): Acc[] {
  const acc = new Map<string, Acc>();
  for (const r of rows) {
    const byKey = new Map<string, UnitOffer>();
    for (const o of r.offers) byKey.set(keyOf(o), o);
    const keys = [...byKey.keys()];
    if (keys.length === 0) continue;
    const gross = splitMinor(r.gross_minor, keys);
    const refunds = splitMinor(r.refunds_minor, keys);
    const reversals = splitMinor(r.reversals_minor, keys);
    for (const k of keys) {
      const o = byKey.get(k)!;
      const id = `${k}${SEP}${r.currency}${SEP}${r.environment}`;
      const a = acc.get(id) ?? {
        key: k,
        offer_id: o.offer_id,
        option: o.option,
        currency: r.currency,
        environment: r.environment,
        units: 0,
        gross: 0,
        refunds: 0,
        reversals: 0,
      };
      a.units += 1;
      a.gross += gross.get(k) ?? 0;
      a.refunds += refunds.get(k) ?? 0;
      a.reversals += reversals.get(k) ?? 0;
      acc.set(id, a);
    }
  }
  return [...acc.values()];
}

const figures = (a: Acc): OfferFigures => ({
  offer_id: a.offer_id,
  currency: a.currency,
  environment: a.environment,
  units: a.units,
  gross_minor: a.gross,
  refunds_minor: a.refunds,
  reversals_minor: a.reversals,
  net_minor: a.gross - a.refunds - a.reversals,
});

/** Figures per offer, by net descending, ties by offer id ascending. */
export function perOffer(rows: readonly UnitMoney[]): OfferFigures[] {
  return accumulate(rows, (o) => o.offer_id)
    .map(figures)
    .sort(
      (a, b) =>
        b.net_minor - a.net_minor ||
        (a.offer_id < b.offer_id ? -1 : a.offer_id > b.offer_id ? 1 : 0) ||
        (a.currency < b.currency ? -1 : a.currency > b.currency ? 1 : 0),
    );
}

export function topOffersFrom(rows: readonly UnitMoney[], n: number): OfferFigures[] {
  return perOffer(rows).slice(0, Math.max(0, n));
}

/** Figures per offer and option, by offer id then option. */
export function perOption(rows: readonly UnitMoney[]): OptionFigures[] {
  return accumulate(rows, (o) => `${o.offer_id}${SEP}${o.option}`)
    .map((a): OptionFigures => ({ ...figures(a), option: a.option }))
    .sort(
      (a, b) =>
        (a.offer_id < b.offer_id ? -1 : a.offer_id > b.offer_id ? 1 : 0) ||
        (a.option < b.option ? -1 : a.option > b.option ? 1 : 0),
    );
}

/** This unit's share of one offer, in each money part (zero when the unit does not hold the offer). */
export function offerShare(
  row: UnitMoney,
  offer_id: string,
): { gross_minor: number; refunds_minor: number; reversals_minor: number; net_minor: number } {
  const ids = [...new Set(row.offers.map((o) => o.offer_id))];
  if (!ids.includes(offer_id))
    return { gross_minor: 0, refunds_minor: 0, reversals_minor: 0, net_minor: 0 };
  const g = splitMinor(row.gross_minor, ids).get(offer_id) ?? 0;
  const f = splitMinor(row.refunds_minor, ids).get(offer_id) ?? 0;
  const r = splitMinor(row.reversals_minor, ids).get(offer_id) ?? 0;
  return { gross_minor: g, refunds_minor: f, reversals_minor: r, net_minor: g - f - r };
}

// ---------- words ----------

export const PERFORMANCE_HEADING = 'How each offer is doing';
export const PERFORMANCE_LEDE =
  'Sales, refunds and net for each offer and way of buying, from the last 30 days.';
export const PERFORMANCE_COLUMNS = {
  offer: 'Offer',
  option: 'Access',
  units: 'Sales',
  gross: 'Gross',
  refunds: 'Refunds',
  net: 'Net',
} as const;
export const PERFORMANCE_EMPTY = 'No sales in the last 30 days.';
export const SEVERAL_ARTICLES_NOTE = 'A sale with several articles counts toward each.';
