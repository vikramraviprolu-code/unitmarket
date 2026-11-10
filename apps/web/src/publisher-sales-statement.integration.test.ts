// PUB-F1 (docs/specs/pub-f1-sales-statement-agree.md): the S4 totals row and the S5 statement carry the
// same numbers. One world of stored rows (two publishers, sale, partial refund, full refund, reversal,
// held unit, mismatch unit, dry run and sandbox); the S4 side is worked out from order_units and the
// S4 counting rule, the S5 side from the ledger, and the totals row is compared with both. Every
// difference that remains is listed and pinned. How `mismatch` is counted is unchanged (assumption 30).
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { hashPasscode } from '@umsbx/security';
import type { Actor } from '@umsbx/contracts';
import { bootRefundWorld } from './refund-support';
import type { RefundWorld } from './refund-support';
import { salesTotals } from '../composition.server';
import { feeText, isCountedSale } from './lib/statement-copy';

vi.mock('server-only', () => ({}));

const PUBLISHER_PASSCODE = 'publisher passcode for tests only';
const PSALT = 'ffeeddccbbaa99887766554433221100';
const HASH = 'b'.repeat(64);

let w: RefundWorld;
let p1: Actor;
let p2: Actor;
let tick = 0;

async function publisher(persona: string): Promise<Actor> {
  const s = await w.app.engine.signIn({ persona, passcode: PUBLISHER_PASSCODE });
  if (s === null) throw new Error(`no sign in for ${persona}`);
  return s.actor;
}

async function insert(table: string, row: Record<string, unknown>): Promise<void> {
  tick += 1;
  const at = `2026-10-22T10:${String(tick % 60).padStart(2, '0')}:00.000Z`;
  const r: Record<string, unknown> = { created_at: at, updated_at: at, ...row };
  const cols = Object.keys(r);
  await w.app.db.query(
    `INSERT INTO ${table} (${cols.join(', ')}) VALUES (${cols.map((_, i) => `$${String(i + 1)}`).join(', ')})`,
    cols.map((c) => r[c]),
  );
}

interface Seed {
  n: number;
  publisher: Actor;
  status?: string;
  amount: number;
  currency?: 'USD' | 'EUR';
  environment?: 'dryrun' | 'sandbox';
  fee?: number;
  refunded?: number;
  /** ledger rows: [kind, minor] */
  ledger?: [string, number][];
}

async function seed(s: Seed): Promise<void> {
  if (s.publisher.kind !== 'publisher') throw new Error('publisher actor expected');
  const buyer = w.actorA.kind === 'buyer' ? w.actorA.buyer_id : '';
  const currency = s.currency ?? 'USD';
  const environment = s.environment ?? 'dryrun';
  const status = s.status ?? 'captured_verified';
  const captured = !['expected', 'pending', 'declined', 'mismatch'].includes(status);
  const id = (k: string): string => `pf1_${k}_${String(s.n)}`;
  await insert('approvals', {
    id: id('apr'),
    buyer_id: buyer,
    snapshot: '{}',
    content_hash: HASH,
    nonce: `pf1nonce${String(s.n)}`,
    created_at: '2026-10-22T10:00:00.000Z',
    updated_at: '2026-10-22T10:00:00.000Z',
    expires_at: '2026-10-22T10:15:00.000Z',
    used_at: null,
    environment,
  });
  await insert('orders', {
    id: id('ord'),
    approval_id: id('apr'),
    buyer_id: buyer,
    content_hash: HASH.slice(0, 60) + String(s.n).padStart(4, '0'),
    order_ref: `ordref_pf1${String(s.n).padStart(3, '0')}`,
    expected: '{}',
    status: 'paid',
    mismatch: false,
    corridor_id: currency === 'EUR' ? 'eu-eur-pf1' : 'us-usd',
    currency,
    total_minor: s.amount,
    environment,
  });
  await insert('order_units', {
    id: id('unt'),
    order_id: id('ord'),
    provider_order_ref: null,
    publisher_id: s.publisher.publisher_id,
    reference_id: `pf1ref_${String(s.n)}`,
    payee_merchant_id: 'PF1MERCHANT01',
    amount_minor: s.amount,
    platform_fee_minor: 0,
    capture_id: captured ? `PF1CAP${String(s.n)}` : null,
    status,
    status_reason: null,
    paypal_fee_minor: s.fee ?? null,
    refunded_minor: s.refunded ?? 0,
    captured_verified_at: captured ? '2026-10-22T10:00:00.000Z' : null,
    mismatch_reason: null,
  });
  for (const [kind, minor] of s.ledger ?? []) {
    await insert('ledger_entries', {
      id: `pf1_led_${String(s.n)}_${kind}`,
      unit_id: id('unt'),
      capture_id: `PF1CAP${String(s.n)}`,
      kind,
      amount_minor: minor,
      currency,
      refund_id: kind === 'refund' ? `pf1_rf_${String(s.n)}` : null,
      ref_entry_id: null,
      environment,
    });
  }
}

beforeAll(async () => {
  w = await bootRefundWorld({
    UMS_PUBLISHER_PASSCODE_HASH: await hashPasscode(PUBLISHER_PASSCODE, PSALT),
  });
  p1 = await publisher('publisher-harbour-ledger');
  p2 = await publisher('publisher-quayside-gazette');
  // Since 0034 (WW-COR) de-eur is on for every country but India; this fixture's eu-eur row serves payee US, and the
  // guard refuses two enabled EUR rows that overlap, so the fixture first switches de-eur off (the pre-0034 world).
  await w.app.db.query("UPDATE corridors SET enabled = false WHERE id = 'de-eur'");
  await insert('corridors', {
    id: 'eu-eur-pf1',
    currency: 'EUR',
    minor_units: 2,
    buyer_countries: ['US'],
    payee_countries: ['US'],
    domestic_supported: true,
    min_charge_minor: null,
    enabled: true,
  });
  // Publisher one, USD, dry run.
  await seed({ n: 1, publisher: p1, amount: 500, ledger: [['sale', 500]] });
  await seed({
    n: 2,
    publisher: p1,
    amount: 400,
    status: 'partially_refunded',
    refunded: 100,
    ledger: [
      ['sale', 400],
      ['refund', 100],
    ],
  });
  await seed({
    n: 3,
    publisher: p1,
    amount: 300,
    status: 'refunded',
    refunded: 300,
    ledger: [
      ['sale', 300],
      ['refund', 300],
    ],
  });
  await seed({
    n: 4,
    publisher: p1,
    amount: 200,
    status: 'reversed',
    ledger: [
      ['sale', 200],
      ['reversal', 200],
    ],
  });
  await seed({
    n: 5,
    publisher: p1,
    amount: 250,
    status: 'reversal_suspected',
    ledger: [['sale', 250]],
  });
  await seed({ n: 6, publisher: p1, amount: 150, status: 'mismatch' });
  await seed({ n: 7, publisher: p1, amount: 90, status: 'expected' });
  await seed({ n: 8, publisher: p1, amount: 80, status: 'pending' });
  await seed({ n: 9, publisher: p1, amount: 70, status: 'declined' });
  // Publisher one, USD, sandbox: its own block, with a fee and a partial refund.
  await seed({
    n: 10,
    publisher: p1,
    amount: 600,
    environment: 'sandbox',
    fee: 35,
    status: 'partially_refunded',
    refunded: 50,
    ledger: [
      ['sale', 600],
      ['paypal_fee', 35],
      ['refund', 50],
    ],
  });
  // Publisher one, EUR, dry run.
  await seed({ n: 11, publisher: p1, amount: 700, currency: 'EUR', ledger: [['sale', 700]] });
  // Publisher two: one sale, and one mismatch unit in EUR (a currency with no ledger rows at all).
  await seed({ n: 12, publisher: p2, amount: 999, ledger: [['sale', 999]] });
  await seed({ n: 13, publisher: p2, amount: 55, currency: 'EUR', status: 'mismatch' });
});
afterAll(async () => {
  await w.app.close();
});

interface Group {
  currency: string;
  environment: string;
  units: number;
  gross: number;
  refunds: number;
  reversals: number;
}

/** The S4 side: the rows the sales page counts (isCountedSale), grouped, from order_units. */
async function s4Groups(actor: Actor): Promise<{ listed: number; groups: Group[] }> {
  const rows = (await w.app.engine.publisherSales(actor))!;
  const counted = rows.filter((r) => isCountedSale(r.status));
  const refunded = new Map(
    (
      await w.app.db.query<{ ref6: string; refunded_minor: string | number }>(
        `SELECT right(o.order_ref, 6) AS ref6, u.refunded_minor
           FROM order_units u JOIN orders o ON o.id = u.order_id WHERE u.publisher_id = $1`,
        [actor.kind === 'publisher' ? actor.publisher_id : ''],
      )
    ).rows.map((r) => [r.ref6, Number(r.refunded_minor)]),
  );
  const map = new Map<string, Group>();
  for (const r of counted.filter((x) => x.status !== 'mismatch')) {
    const key = `${r.currency}/${r.environment}`;
    const g = map.get(key) ?? {
      currency: r.currency,
      environment: r.environment,
      units: 0,
      gross: 0,
      refunds: 0,
      reversals: 0,
    };
    g.units += 1;
    g.gross += r.amount_minor;
    g.refunds += refunded.get(r.order_ref6) ?? 0;
    g.reversals += r.status === 'reversed' ? r.amount_minor : 0;
    map.set(key, g);
  }
  return { listed: counted.length, groups: [...map.values()] };
}

describe('S4 totals row and S5 statement', () => {
  it('carry the same figures per currency and environment, and the same as the units add up to', async () => {
    for (const actor of [p1, p2]) {
      const st = (await w.app.engine.publisherStatement(actor))!;
      const totals = salesTotals(st.blocks);
      const s4 = await s4Groups(actor);
      expect(totals).toHaveLength(st.blocks.length);
      expect(totals).toHaveLength(s4.groups.length);
      for (const b of st.blocks) {
        const t = totals.find((x) => x.currency === b.currency && x.environment === b.environment)!;
        const g = s4.groups.find(
          (x) => x.currency === b.currency && x.environment === b.environment,
        )!;
        // S4 totals row equals the S5 block, figure by figure.
        expect(t).toMatchObject({
          gross_minor: b.sales_minor,
          refunds_minor: b.refunds_minor,
          reversals_minor: b.reversals_minor,
          net_minor: b.net_minor,
          paypal_fee_minor: b.paypal_fee_minor,
        });
        // ... and both equal what the S4 units add up to.
        expect(t.units_paid).toBe(g.units);
        expect(t.gross_minor).toBe(g.gross);
        expect(t.refunds_minor).toBe(g.refunds);
        expect(t.reversals_minor).toBe(g.reversals);
        expect(t.net_minor).toBe(g.gross - g.refunds - g.reversals);
        // The fee text is the one S5 shows.
        expect(feeText(t.paypal_fee_minor, t.currency, t.environment)).toBe(
          feeText(b.paypal_fee_minor, b.currency, b.environment),
        );
      }
    }
  });

  it('pins the known figures of the world', async () => {
    const t1 = salesTotals((await w.app.engine.publisherStatement(p1))!.blocks);
    expect(t1.map((t) => [t.currency, t.environment, t.units_paid])).toEqual([
      ['EUR', 'dryrun', 1],
      ['USD', 'dryrun', 5],
      ['USD', 'sandbox', 1],
    ]);
    expect(t1[1]).toMatchObject({
      gross_minor: 500 + 400 + 300 + 200 + 250,
      refunds_minor: 400,
      reversals_minor: 200,
      net_minor: 1650 - 400 - 200,
      paypal_fee_minor: null,
    });
    // Sandbox: the fee sits beside the net and is not taken off it.
    expect(t1[2]).toMatchObject({
      gross_minor: 600,
      refunds_minor: 50,
      net_minor: 550,
      paypal_fee_minor: 35,
    });
    const t2 = salesTotals((await w.app.engine.publisherStatement(p2))!.blocks);
    expect(t2).toHaveLength(1);
    expect(t2[0]).toMatchObject({ units_paid: 1, gross_minor: 999, net_minor: 999 });
  });

  it('lists each documented difference, and nothing else differs', async () => {
    const st1 = (await w.app.engine.publisherStatement(p1))!;
    const s4a = await s4Groups(p1);
    const paid1 = salesTotals(st1.blocks).reduce((n, t) => n + t.units_paid, 0);
    // (a) a mismatch unit is listed and counted on S4, is in no totals row, and S5 names it in mismatch_units.
    expect(st1.mismatch_units).toBe(1);
    expect(s4a.listed - paid1).toBe(st1.mismatch_units);
    // (b) a publisher with only a mismatch unit in a currency has a listed row and no totals row for it.
    const st2 = (await w.app.engine.publisherStatement(p2))!;
    expect(st2.mismatch_units).toBe(1);
    expect((await s4Groups(p2)).listed).toBe(2);
    expect(salesTotals(st2.blocks).map((t) => t.currency)).toEqual(['USD']);
    // (c) dry run and sandbox never add into each other.
    const usd = salesTotals(st1.blocks).filter((t) => t.currency === 'USD');
    expect(usd.map((t) => t.environment)).toEqual(['dryrun', 'sandbox']);
    // (d) the not counted units (awaiting, pending, declined) are in neither.
    const all = (await w.app.engine.publisherSales(p1))!;
    expect(all.filter((r) => !isCountedSale(r.status))).toHaveLength(3);
  });

  it('never mixes in another publisher, and carries no buyer identity', async () => {
    const mine = JSON.stringify(salesTotals((await w.app.engine.publisherStatement(p1))!.blocks));
    expect(mine).not.toContain('999');
    const buyerId = w.actorA.kind === 'buyer' ? w.actorA.buyer_id : '';
    expect(mine).not.toContain(buyerId);
  });

  it('S4 reads the totals from the statement read model and adds no fee subtraction', () => {
    const src = readFileSync(
      new URL('./app/publisher/sales/page.tsx', import.meta.url),
      'utf8',
    ).replace(/\/\/.*$/gm, '');
    expect(src).toContain('engine.publisherStatement(actor)');
    expect(src).toContain('engine.publisherSales(actor)');
    expect(src).toContain('salesTotals(');
    expect(src).toContain('feeText(');
    expect(src).not.toMatch(/net_minor\s*-\s*\w*\.?paypal_fee/);
    expect(src).not.toMatch(/style=|<script|<img|https?:\/\//);
    expect(src).not.toMatch(/Sandbox|Dry run/);
  });
});
