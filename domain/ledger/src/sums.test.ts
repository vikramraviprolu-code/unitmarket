import { describe, expect, it } from 'vitest';
import type { LedgerEntry } from '@umsbx/contracts';
import { publisherBalances, unitBalance } from './index';

const e = (
  kind: LedgerEntry['kind'],
  minor: number,
  refund_id: string | null = null,
): LedgerEntry => ({
  id: `led_${kind}${minor}${refund_id ?? ''}`,
  unit_id: 'unt_1',
  capture_id: 'CAP1',
  kind,
  amount: { currency: 'USD', minor },
  refund_id,
  ref_entry_id: null,
  created_at: '2026-10-22T10:00:00.000Z',
  environment: 'dryrun',
});

describe('unitBalance', () => {
  it('unitBalance sums', () => {
    expect(unitBalance([])).toEqual({
      sold_minor: 0,
      refunded_minor: 0,
      reversed_minor: 0,
      net_minor: 0,
    });
    expect(unitBalance([e('sale', 500)])).toEqual({
      sold_minor: 500,
      refunded_minor: 0,
      reversed_minor: 0,
      net_minor: 500,
    });
    expect(
      unitBalance([
        e('sale', 500),
        e('refund', 100, 'R1'),
        e('refund', 150, 'R2'),
        e('reversal', 50),
        e('paypal_fee', 30),
      ]),
    ).toEqual({ sold_minor: 500, refunded_minor: 250, reversed_minor: 50, net_minor: 200 });
  });

  it('ignores fee and commission rows and does not depend on order', () => {
    const rows = [
      e('sale', 400),
      e('paypal_fee', 42),
      e('commission_reversal', 10, 'R1'),
      e('refund', 100, 'R1'),
    ];
    expect(unitBalance([...rows].reverse())).toEqual(unitBalance(rows));
    expect(unitBalance(rows).net_minor).toBe(300);
  });
});

// DP-4 (MVP-D, P11 per publisher). Rows carry their publisher; the result is one balance per
// publisher and currency, computed with unitBalance, in publisher then currency order.
const pe = (
  publisher_id: string,
  kind: LedgerEntry['kind'],
  minor: number,
  over: { unit_id?: string; refund_id?: string | null; currency?: string; id?: string } = {},
) => ({
  publisher_id,
  entry: {
    ...e(kind, minor, over.refund_id ?? null),
    unit_id: over.unit_id ?? `unt_${publisher_id}`,
    amount: { currency: over.currency ?? 'USD', minor },
    ...(over.id === undefined ? {} : { id: over.id }),
  } as LedgerEntry,
});
const bal = (sold: number, refunded: number, reversed: number) => ({
  sold_minor: sold,
  refunded_minor: refunded,
  reversed_minor: reversed,
  net_minor: sold - refunded - reversed,
});

describe('publisherBalances', () => {
  it('two publishers grouped; fee rows ignored; refund and reversal reduce net', () => {
    const rows = [
      pe('pub_2', 'sale', 250),
      pe('pub_1', 'sale', 400),
      pe('pub_1', 'paypal_fee', 30),
      pe('pub_2', 'paypal_fee', 20),
      pe('pub_1', 'refund', 100, { refund_id: 'R1' }),
      pe('pub_1', 'commission_reversal', 5, { refund_id: 'R1' }),
      pe('pub_2', 'reversal', 50),
    ];
    expect(publisherBalances(rows)).toEqual([
      { publisher_id: 'pub_1', currency: 'USD', ...bal(400, 100, 0) },
      { publisher_id: 'pub_2', currency: 'USD', ...bal(250, 0, 50) },
    ]);
    expect(publisherBalances(rows)[0]!.net_minor).toBe(300);
    expect(publisherBalances(rows)[1]!.net_minor).toBe(200);
  });

  it('is empty for no rows, and does not depend on row order', () => {
    expect(publisherBalances([])).toEqual([]);
    const rows = [
      pe('pub_1', 'sale', 400),
      pe('pub_2', 'sale', 250),
      pe('pub_1', 'refund', 100, { refund_id: 'R1' }),
      pe('pub_2', 'paypal_fee', 9),
    ];
    expect(publisherBalances([...rows].reverse())).toEqual(publisherBalances(rows));
  });

  it('a publisher with only fee rows has net 0 (a fee never moves what the buyer paid)', () => {
    expect(publisherBalances([pe('pub_1', 'paypal_fee', 30)])).toEqual([
      { publisher_id: 'pub_1', currency: 'USD', ...bal(0, 0, 0) },
    ]);
  });

  it('one publisher, two currencies: two balances, never added together', () => {
    const rows = [
      pe('pub_1', 'sale', 400),
      pe('pub_1', 'sale', 300, { currency: 'EUR', unit_id: 'unt_eur' }),
      pe('pub_1', 'refund', 100, { currency: 'EUR', refund_id: 'R1', unit_id: 'unt_eur' }),
    ];
    expect(publisherBalances(rows)).toEqual([
      { publisher_id: 'pub_1', currency: 'EUR', ...bal(300, 100, 0) },
      { publisher_id: 'pub_1', currency: 'USD', ...bal(400, 0, 0) },
    ]);
  });

  it('a publisher with two units adds the two units; it equals the sum of unitBalance per unit', () => {
    const rows = [
      pe('pub_1', 'sale', 400, { unit_id: 'unt_a' }),
      pe('pub_1', 'sale', 150, { unit_id: 'unt_b' }),
      pe('pub_1', 'refund', 60, { unit_id: 'unt_b', refund_id: 'R9' }),
    ];
    const [one] = publisherBalances(rows);
    const a = unitBalance(rows.filter((r) => r.entry.unit_id === 'unt_a').map((r) => r.entry));
    const b = unitBalance(rows.filter((r) => r.entry.unit_id === 'unt_b').map((r) => r.entry));
    expect(one).toMatchObject({
      sold_minor: a.sold_minor + b.sold_minor,
      refunded_minor: a.refunded_minor + b.refunded_minor,
      net_minor: a.net_minor + b.net_minor,
    });
  });

  it('the input is not changed', () => {
    const rows = [pe('pub_2', 'sale', 250), pe('pub_1', 'sale', 400)];
    const before = JSON.stringify(rows);
    publisherBalances(rows);
    expect(JSON.stringify(rows)).toBe(before);
  });

  // Property: with a seeded generator (no Math.random), for many random books the sum of the
  // publisher nets equals the sum of the unit nets, and each publisher's net equals the sum of
  // the nets of its own units.
  it('property: sum of publisher nets equals sum of unit nets', () => {
    let state = 20_261_026;
    const next = (n: number): number => {
      state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
      return state % n;
    };
    const kinds: LedgerEntry['kind'][] = [
      'sale',
      'sale',
      'paypal_fee',
      'refund',
      'reversal',
      'commission_reversal',
    ];
    for (let round = 0; round < 200; round += 1) {
      const rows = Array.from({ length: next(12) }, (_, i) => {
        const publisher = `pub_${String(1 + next(3))}`;
        const unit = `unt_${publisher}_${String(next(3))}`;
        const kind = kinds[next(kinds.length)]!;
        return pe(publisher, kind, 1 + next(500), {
          unit_id: unit,
          id: `led_${String(round)}_${String(i)}`,
          refund_id: kind === 'refund' || kind === 'commission_reversal' ? `R${String(i)}` : null,
        });
      });
      const byPublisher = publisherBalances(rows);
      const unitIds = [...new Set(rows.map((r) => r.entry.unit_id))];
      const unitNets = unitIds.map((u) => ({
        publisher: rows.find((r) => r.entry.unit_id === u)!.publisher_id,
        net: unitBalance(rows.filter((r) => r.entry.unit_id === u).map((r) => r.entry)).net_minor,
      }));
      expect(byPublisher.reduce((n, b) => n + b.net_minor, 0)).toBe(
        unitNets.reduce((n, u) => n + u.net, 0),
      );
      for (const b of byPublisher) {
        expect(b.net_minor).toBe(
          unitNets.filter((u) => u.publisher === b.publisher_id).reduce((n, u) => n + u.net, 0),
        );
      }
    }
  });
});
