// MC2-L5 golden (D-084 item 4, D-085, autonomy ledger A1): every word of the converted price lines and of the
// display currency setting. The reviewed file is golden/buyer-price-copy.golden.txt. D-051: no italics, no dashes.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import * as copy from './lib/buyer-price';

const golden = readFileSync(
  new URL('./golden/buyer-price-copy.golden.txt', import.meta.url),
  'utf8',
)
  .split('\n')
  .filter((l) => l !== '' && !l.startsWith('#'));

function lines(): string[] {
  const ecb = copy.priceView(
    { currency: 'EUR', minor: 150 },
    { minor: 128, currency: 'GBP', rate_date: '2026-11-03', source: 'ecb' },
  );
  const seed = copy.priceView(
    { currency: 'EUR', minor: 150 },
    { minor: 128, currency: 'GBP', rate_date: '2026-11-03', source: 'seed' },
  );
  return [
    `converted lead: ${ecb.lead}`,
    `converted binding, dated rate: ${ecb.binding}`,
    `converted binding, sample rate: ${seed.binding}`,
    `converted lead in a list: ${copy.fromLead(ecb)}`,
    `not converted, same currency: ${copy.priceView({ currency: 'USD', minor: 150 }, null).lead}`,
    `not converted, no usable rate: ${copy.priceView({ currency: 'EUR', minor: 150 }, null).lead}`,
    `ceiling line: ${copy.ceilingLine({ currency: 'EUR', minor: 150 }, { currency: 'EUR', minor: 147 })}`,
    `ceiling line, sample rate: ${copy.ceilingLine({ currency: 'EUR', minor: 150 }, { currency: 'EUR', minor: 147 }, 'seed')}`,
    `no rate, ceiling: ${copy.NO_RATE_NOTE}`,
    `account, heading: ${copy.DISPLAY_CURRENCY_TITLE}`,
    `account, lede: ${copy.DISPLAY_CURRENCY_LEDE}`,
    `account, label: ${copy.DISPLAY_CURRENCY_LABEL}`,
    `account, option, DE: ${copy.autoOptionLabel('DE')}`,
    `account, option, US: ${copy.autoOptionLabel('US')}`,
    `account, option, GB: ${copy.autoOptionLabel('GB')}`,
    `account, option, other country: ${copy.autoOptionLabel('FR')}`,
    `account, option USD: ${copy.DISPLAY_CURRENCY_OPTION.USD}`,
    `account, option EUR: ${copy.DISPLAY_CURRENCY_OPTION.EUR}`,
    `account, option GBP: ${copy.DISPLAY_CURRENCY_OPTION.GBP}`,
    `account, save: ${copy.DISPLAY_CURRENCY_SAVE}`,
    `account, saving: ${copy.DISPLAY_CURRENCY_SAVING}`,
    `account, saved: ${copy.DISPLAY_CURRENCY_SAVED}`,
    `account, failed: ${copy.DISPLAY_CURRENCY_FAILED}`,
  ];
}

describe('buyer price copy (golden)', () => {
  it('matches golden/buyer-price-copy.golden.txt', () => {
    expect(lines()).toEqual(golden);
  });

  it('has no dash characters, no italics markup, and never names the ECB', () => {
    const text = lines().join('\n');
    expect(text).not.toMatch(/[‐-―−]/);
    expect(text).not.toMatch(/<i>|<em>|\*[a-z]|_[a-z]+_/i);
    expect(text).not.toMatch(/ECB|European Central Bank/);
  });
});
