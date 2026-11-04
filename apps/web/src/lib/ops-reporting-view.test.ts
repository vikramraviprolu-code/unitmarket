// MC2-L7 (D-084 item 5, ledger A1 and A6): the reporting block of the operations screen, as a pure view
// model. The per-currency figures come first, as booked; the reporting view converts each currency subtotal
// on its own, rounds half away from zero, then adds. A fixed fake rate table (ops-reporting-support.ts).
import { describe, expect, it } from 'vitest';
import { BOOKED, fakeFx } from '../ops-reporting-support';
import { opsReportingView } from './ops-reporting-view';
import {
  OPS_REPORTING_HOW_NOTE,
  OPS_REPORTING_MISSING_NOTE,
  OPS_REPORTING_STATEMENTS_NOTE,
} from './ops-reporting-view';

describe('opsReportingView', () => {
  it('lists the booked figures first, in the order USD, EUR, GBP', () => {
    const v = opsReportingView(BOOKED, fakeFx('ecb'));
    expect(v.groups).toHaveLength(1);
    expect(v.groups[0]!.environment).toBe('dryrun');
    expect(v.groups[0]!.booked).toEqual([
      { label: 'USD', sales: '$10.01', refunds: '$0.03', exposure: '$10.00' },
      { label: 'EUR', sales: '€0.05', refunds: '€0.00', exposure: '€0.07' },
      { label: 'GBP', sales: '£0.03', refunds: '£0.01', exposure: '£0.05' },
    ]);
  });

  it('converts each subtotal on its own, rounds half away from zero, then adds (three reporting rows)', () => {
    const g = opsReportingView(BOOKED, fakeFx('ecb')).groups[0]!;
    // USD: 1001 + 3*4 + 5*2 = 1023. EUR: round(500.5) + 3*2 + 5 = 501 + 6 + 5 = 512 (not round(1023*0.5)).
    // GBP: round(250.25) + 3 + round(2.5) = 250 + 3 + 3 = 256.
    expect(g.reporting!.rows).toEqual([
      { label: 'In USD', sales: 'about $10.23', refunds: 'about $0.07', exposure: 'about $10.34' },
      { label: 'In EUR', sales: 'about €5.12', refunds: 'about €0.04', exposure: 'about €5.17' },
      { label: 'In GBP', sales: 'about £2.56', refunds: 'about £0.02', exposure: 'about £2.59' },
    ]);
    expect(g.missing_note).toBeNull();
  });

  it('labels a real rate with its date and a seed rate "sample rate", never naming the bank (ledger A1)', () => {
    const real = opsReportingView(BOOKED, fakeFx('ecb', '2026-11-03')).groups[0]!.reporting!;
    expect(real.rate_note).toBe('Reporting view: about, at the rate of 2026-11-03.');
    const seed = opsReportingView(BOOKED, fakeFx('seed', '2026-11-03')).groups[0]!.reporting!;
    expect(seed.rate_note).toBe('Reporting view: about, at the sample rate of 2026-11-03.');
    for (const note of [real.rate_note, seed.rate_note, real.how_note]) {
      expect(note).not.toMatch(/ecb|central bank|european/i);
    }
    expect(real.how_note).toBe(OPS_REPORTING_HOW_NOTE);
  });

  it('with no usable rate it shows the booked figures and one note, and no reporting view', () => {
    const v = opsReportingView(BOOKED, fakeFx(null));
    const g = v.groups[0]!;
    expect(g.booked).toHaveLength(3);
    expect(g.reporting).toBeNull();
    expect(g.missing_note).toBe(OPS_REPORTING_MISSING_NOTE);
    expect(OPS_REPORTING_MISSING_NOTE.split('\n')).toHaveLength(1);
  });

  it('a conversion that fails for one pair gives the note, not a partial view', () => {
    const fx = fakeFx('ecb');
    const partial = {
      ...fx,
      convert: (i: Parameters<typeof fx.convert>[0]) =>
        i.from === 'GBP' && i.to === 'EUR' ? null : fx.convert(i),
    };
    const g = opsReportingView(BOOKED, partial).groups[0]!;
    expect(g.reporting).toBeNull();
    expect(g.missing_note).toBe(OPS_REPORTING_MISSING_NOTE);
  });

  it('a stored environment never mixes with the other: two groups, each converted alone', () => {
    const rows = [
      ...BOOKED,
      {
        environment: 'sandbox' as const,
        currency: 'USD',
        sales_minor: 100,
        refunds_minor: 0,
        exposure_minor: 0,
      },
    ];
    const v = opsReportingView(rows, fakeFx('ecb'));
    expect(v.groups.map((g) => g.environment)).toEqual(['dryrun', 'sandbox']);
    expect(v.groups[1]!.booked).toEqual([
      { label: 'USD', sales: '$1.00', refunds: '$0.00', exposure: '$0.00' },
    ]);
    expect(v.groups[1]!.reporting!.rows[1]).toEqual({
      label: 'In EUR',
      sales: 'about €0.50',
      refunds: 'about €0.00',
      exposure: 'about €0.00',
    });
    expect(v.groups[0]!.reporting!.rows[0]!.sales).toBe('about $10.23');
  });

  it('an empty database gives no groups, an empty sentence and no note', () => {
    const v = opsReportingView([], fakeFx(null));
    expect(v.groups).toEqual([]);
    expect(v.empty).toBe('No sales, refunds or held payments yet.');
    expect(v.statements_note).toBe(OPS_REPORTING_STATEMENTS_NOTE);
  });

  it('the figures never lose a sign or turn into NaN', () => {
    const v = opsReportingView(
      [
        {
          environment: 'dryrun',
          currency: 'USD',
          sales_minor: 0,
          refunds_minor: 0,
          exposure_minor: 0,
        },
      ],
      fakeFx('ecb'),
    );
    const text = JSON.stringify(v);
    expect(text).not.toMatch(/NaN|undefined/);
    expect(v.groups[0]!.reporting!.rows.map((r) => r.sales)).toEqual([
      'about $0.00',
      'about €0.00',
      'about £0.00',
    ]);
  });
});
