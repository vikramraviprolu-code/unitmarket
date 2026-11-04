// MC2-L7 test support: a fixed fake rate table and one set of booked figures, shared by the view test and
// the golden copy test. The rates are powers of two so the products are exact in floating point and the
// halves (x.5) are real halves. Nothing here reads a clock or a database.
import type { BookedTotal } from './lib/ops-reporting-view';

type Cur = 'USD' | 'EUR' | 'GBP';

export const FAKE_RATES: Record<Cur, Record<Cur, number>> = {
  USD: { USD: 1, EUR: 0.5, GBP: 0.25 },
  EUR: { USD: 2, EUR: 1, GBP: 0.5 },
  GBP: { USD: 4, EUR: 2, GBP: 1 },
};

/** Round to the nearest whole number, halves away from zero. */
export const roundHalfAway = (x: number): number => Math.sign(x) * Math.round(Math.abs(x));

export interface FakeResult {
  minor: number;
  rate_date: string | null;
  source: 'ecb' | 'seed' | null;
}

/** An engine-shaped convert over the fake table. `rates` is the source label, or null for no usable rate. */
export function fakeFx(source: 'ecb' | 'seed' | null, date = '2026-11-03') {
  return {
    rates: source,
    convert(i: {
      minor: number;
      from: Cur;
      to: Cur;
      rates: 'ecb' | 'seed' | null;
    }): FakeResult | null {
      if (i.from === i.to) return { minor: i.minor, rate_date: null, source: null };
      if (i.rates === null) return null;
      return {
        minor: roundHalfAway(i.minor * FAKE_RATES[i.from][i.to]),
        rate_date: date,
        source: i.rates,
      };
    },
  };
}

/** Three currencies, one stored environment. Order is the domain's (alphabetical), not the screen's. */
export const BOOKED: BookedTotal[] = [
  { environment: 'dryrun', currency: 'EUR', sales_minor: 5, refunds_minor: 0, exposure_minor: 7 },
  { environment: 'dryrun', currency: 'GBP', sales_minor: 3, refunds_minor: 1, exposure_minor: 5 },
  {
    environment: 'dryrun',
    currency: 'USD',
    sales_minor: 1001,
    refunds_minor: 3,
    exposure_minor: 1000,
  },
];
