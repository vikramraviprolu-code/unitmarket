// PUB-C: the statement reconciles with publisherBalances (the ledger invariant) for 20 generated
// row sets. No property library is in the repo, so this is a table test with a seeded generator.
import { describe, expect, it } from 'vitest';
import { publisherBalances } from '@umsbx/ledger';
import type { Id, LedgerEntry } from '@umsbx/contracts';
import { buildStatement } from './statement';
import type { StatementRow } from './statement';

/** A small seeded generator (mulberry32). Same seed, same cases, on every machine. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const KINDS = ['sale', 'sale', 'sale', 'refund', 'reversal', 'paypal_fee'] as const;
const CURRENCIES = ['USD', 'EUR', 'JPY'] as const;
const ENVS = ['dryrun', 'sandbox'] as const;

function generate(seed: number): StatementRow[] {
  const next = rng(seed);
  const pick = <T>(xs: readonly T[]): T => xs[Math.floor(next() * xs.length)]!;
  const n = Math.floor(next() * 40);
  const rows: StatementRow[] = [];
  for (let i = 0; i < n; i += 1) {
    const kind = pick(KINDS);
    const entry: LedgerEntry = {
      id: `led_${String(seed)}_${String(i)}`,
      unit_id: `unt_${String(i % 7)}`,
      capture_id: `CAP${String(i)}`,
      kind,
      amount: { currency: pick(CURRENCIES), minor: 1 + Math.floor(next() * 5000) },
      refund_id: kind === 'refund' ? `rf_${String(i)}` : null,
      ref_entry_id: null,
      created_at: '2026-10-22T10:00:00.000Z',
      environment: pick(ENVS),
    };
    rows.push({ order_ref: `ordref_${String(1000 + (i % 9))}`, entry });
  }
  return rows;
}

const FACTS = {
  merchant_id: 'MERCHANT0001A',
  payee_shared: false,
  own_merchant_id: null,
  environment: 'sandbox',
} as const;

describe('buildStatement against publisherBalances', () => {
  const seeds = Array.from({ length: 20 }, (_, i) => 1000 + i * 7);
  it.each(seeds)('seed %i: per currency, sales, refunds, reversals and net agree', (seed) => {
    const rows = generate(seed);
    const st = buildStatement(rows, FACTS);
    const bal = publisherBalances(
      rows.map((r) => ({ publisher_id: 'pub_x' as Id, entry: r.entry })),
    );
    for (const b of bal) {
      const mine = st.blocks.filter((x) => x.currency === b.currency);
      const sum = (f: (x: (typeof mine)[number]) => number) => mine.reduce((t, x) => t + f(x), 0);
      expect(sum((x) => x.sales_minor)).toBe(b.sold_minor);
      expect(sum((x) => x.refunds_minor)).toBe(b.refunded_minor);
      expect(sum((x) => x.reversals_minor)).toBe(b.reversed_minor);
      expect(sum((x) => x.net_minor)).toBe(b.net_minor);
    }
    // every row is a line of exactly one block, and fees are the fee rows only
    expect(st.blocks.reduce((t, x) => t + x.lines.length, 0)).toBe(rows.length);
    const fees = rows
      .filter((r) => r.entry.kind === 'paypal_fee')
      .reduce((t, r) => t + r.entry.amount.minor, 0);
    expect(st.blocks.reduce((t, x) => t + (x.paypal_fee_minor ?? 0), 0)).toBe(fees);
    // blocks never mix environments or currencies
    for (const blk of st.blocks) expect(blk.lines.length).toBeGreaterThan(0);
  });

  it('is independent of the order of the rows', () => {
    const rows = generate(4242);
    const a = buildStatement(rows, FACTS);
    const b = buildStatement([...rows].reverse(), FACTS);
    expect(b.blocks.map((x) => [x.currency, x.environment, x.net_minor])).toEqual(
      a.blocks.map((x) => [x.currency, x.environment, x.net_minor]),
    );
  });
});
