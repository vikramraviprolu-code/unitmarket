// MC2-L5 (D-084 item 4, D-085, autonomy ledger A1 and A5): the buyer's display currency and the one shared
// price formatter, pure. The exact words are pinned again by buyer-price-copy.golden.test.ts.
import { describe, expect, it } from 'vitest';
import {
  approvePrices,
  ceilingLine,
  currencyForCountry,
  effectiveDisplayCurrency,
  formatRateDate,
  fromLead,
  isDisplayCurrency,
  priceView,
} from './buyer-price';

const ECB = { rate_date: '2026-11-03', source: 'ecb' as const };

describe('currencyForCountry', () => {
  it('maps US, GB and DE, whatever the case, and nothing else', () => {
    expect(currencyForCountry('US')).toBe('USD');
    expect(currencyForCountry('GB')).toBe('GBP');
    expect(currencyForCountry('DE')).toBe('EUR');
    expect(currencyForCountry('de')).toBe('EUR');
    for (const other of ['FR', 'JP', 'UK', '', 'USA', ' DE x']) {
      expect(currencyForCountry(other), other).toBeNull();
    }
  });
});

describe('effectiveDisplayCurrency', () => {
  it('derives from the country until a currency is chosen; a choice wins', () => {
    expect(effectiveDisplayCurrency('DE', null)).toBe('EUR');
    expect(effectiveDisplayCurrency('DE', 'GBP')).toBe('GBP');
    expect(effectiveDisplayCurrency('FR', null)).toBeNull();
    expect(effectiveDisplayCurrency('FR', 'EUR')).toBe('EUR');
  });

  it('ignores a stored value that is not USD, EUR or GBP', () => {
    expect(effectiveDisplayCurrency('DE', 'JPY')).toBe('EUR');
    expect(effectiveDisplayCurrency('FR', 'XAU')).toBeNull();
  });

  it('isDisplayCurrency accepts exactly the three', () => {
    expect(['USD', 'EUR', 'GBP'].every(isDisplayCurrency)).toBe(true);
    for (const v of ['JPY', 'usd', '', null, undefined, 3])
      expect(isDisplayCurrency(v)).toBe(false);
  });
});

describe('formatRateDate', () => {
  it('writes day, short month and year', () => {
    expect(formatRateDate('2026-11-03')).toBe('3 Nov 2026');
    expect(formatRateDate('2026-01-31')).toBe('31 Jan 2026');
    expect(formatRateDate('2026-12-09')).toBe('9 Dec 2026');
  });
});

describe('priceView', () => {
  it('with no conversion it is the seller amount alone and there is no binding line', () => {
    expect(priceView({ currency: 'USD', minor: 150 }, null)).toEqual({
      seller: '$1.50',
      lead: '$1.50',
      binding: null,
    });
  });

  it('with a conversion it leads with "about" and puts the binding seller amount beside it', () => {
    expect(
      priceView({ currency: 'EUR', minor: 150 }, { minor: 128, currency: 'GBP', ...ECB }),
    ).toEqual({
      seller: '€1.50',
      lead: 'about £1.28',
      binding: 'Binding: €1.50 (rate of 3 Nov 2026)',
    });
  });

  it('a seed rate is called a sample rate, and the ECB is never named', () => {
    const v = priceView(
      { currency: 'USD', minor: 160 },
      { minor: 147, currency: 'EUR', rate_date: '2026-11-03', source: 'seed' },
    );
    expect(v.binding).toBe('Binding: $1.60 (sample rate of 3 Nov 2026)');
    expect(JSON.stringify(v)).not.toMatch(/ECB|central bank/i);
  });

  it('fromLead puts "from" before the lead', () => {
    const v = priceView({ currency: 'EUR', minor: 100 }, { minor: 80, currency: 'GBP', ...ECB });
    expect(fromLead(v)).toBe('from about £0.80');
    expect(fromLead(priceView({ currency: 'USD', minor: 40 }, null))).toBe('from $0.40');
  });
});

describe('ceilingLine', () => {
  it('shows the ceiling and the converted price in the ceiling currency, as an estimate', () => {
    expect(ceilingLine({ currency: 'EUR', minor: 150 }, { currency: 'EUR', minor: 147 })).toBe(
      'Against your ceiling of €1.50: about €1.47.',
    );
  });
});

describe('approvePrices', () => {
  const view = {
    currency: 'USD',
    total_minor: 300,
    items: [
      { article_id: 'art_1', amount_minor: 100 },
      { article_id: 'art_2', amount_minor: 200 },
    ],
    blocks: [
      {
        publisher: 'Harbour Ledger',
        subtotal_minor: 100,
        items: [{ article_id: 'art_1', amount_minor: 100 }],
      },
      {
        publisher: 'Quayside Gazette',
        subtotal_minor: 200,
        items: [{ article_id: 'art_2', amount_minor: 200 }],
      },
    ],
  };
  it('prices every item, every publisher subtotal and the total with the one formatter', () => {
    const seen: number[] = [];
    const p = approvePrices(view, (m) => {
      seen.push(m.minor);
      return priceView(m, { minor: m.minor + 1, currency: 'EUR', ...ECB });
    });
    expect(Object.keys(p.items).sort()).toEqual(['art_1', 'art_2']);
    expect(p.items['art_2']!.lead).toBe('about €2.01');
    expect(p.items['art_2']!.binding).toBe('Binding: $2.00 (rate of 3 Nov 2026)');
    expect(p.blocks['Harbour Ledger']!.lead).toBe('about €1.01');
    expect(p.total.lead).toBe('about €3.01');
    expect(p.total.binding).toBe('Binding: $3.00 (rate of 3 Nov 2026)');
    expect(seen.every((m) => [100, 200, 300].includes(m))).toBe(true);
  });
});
