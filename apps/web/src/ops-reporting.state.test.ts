// MC2-L7 (D-084 item 5, ledger A1, A6): the operations screen totals over the real engine (offline, PGlite,
// seeded). Paid dry-run orders in USD, GBP and EUR; the booked figures are per currency; the reporting
// view converts through engine.fx.convert at the stored rate and says "about" with the rate date. Seed rates
// say "sample rate". No rate, or one over 7 days old, gives the booked figures and one note. Nothing is
// written, and the sellers' statements and CSV files stay as they were.
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Actor } from '@umsbx/contracts';
import { createApp, installApp } from '../composition.server';
import type { App } from '../composition.server';
import { opsReportingView } from './lib/ops-reporting-view';
import type { BookedTotal } from './lib/ops-reporting-view';
import { testEnv } from './support';

vi.mock('server-only', () => ({}));

const OP: Actor = { kind: 'operator', operator_id: 'opr_vikram', mfa: true };
type Cur = 'USD' | 'EUR' | 'GBP';

let TODAY = '';
let answer = { ok: true as const, date: '', usd: '1.2000', gbp: '0.8800' };
let app: App;
let empty: App;
const paid: Record<Cur, number> = { USD: 0, EUR: 0, GBP: 0 };

async function buyOffer(
  actor: Actor,
  offer: { publisher_slug: string; offer_code: string },
): Promise<void> {
  const q = await app.engine.quote({ offer, actor, source: 'direct', option: 'online_read' });
  if (!q.ok || q.value.kind !== 'quote') throw new Error(`no quote for ${offer.offer_code}`);
  const g = await app.engine.requestApproval({
    actor,
    selection: { kind: 'quote', quote_id: q.value.quote_id },
    consent: { terms: true, identity_share: false },
  });
  if (!g.ok) throw new Error(`no approval: ${g.error.code}`);
  const placed = await app.engine.payments.placeOrder({
    approval_id: g.value.approval_id,
    token: g.value.token,
    actor,
  });
  if (!placed.ok) throw new Error(`place: ${JSON.stringify(placed.error)}`);
  const co = await app.engine.payments.beginCheckout({ order_id: placed.value.order_id, actor });
  if (!co.ok) throw new Error(`checkout: ${co.error.code}`);
  await app.engine.dryRunApprove({ order_ref: placed.value.order_ref, actor, scenario: 'happy' });
  await app.engine.payments.onBuyerReturn({
    order_ref: placed.value.order_ref,
    actor,
    scenario: 'happy',
  });
  const o = (
    await app.db.query<{ currency: Cur; total_minor: string | number; status: string }>(
      'SELECT currency, total_minor, status FROM orders WHERE id = $1',
      [placed.value.order_id],
    )
  ).rows[0]!;
  expect(o.status).toBe('paid');
  paid[o.currency] += Number(o.total_minor);
}

beforeAll(async () => {
  app = createApp(await testEnv(), {
    switch_cache_ms: 0,
    test_seed: { de_corridor: true },
    test_fx_fetch: async () => answer,
  });
  installApp(app);
  await app.ready();
  TODAY = (
    await app.db.query<{ d: string }>("SELECT to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS d")
  ).rows[0]!.d;
  answer = { ...answer, date: TODAY };
  await app.db.query("UPDATE corridors SET enabled = true WHERE id IN ('gb-gbp', 'de-eur')");
  await app.db.query(
    `INSERT INTO buyers (id, display_name, auth_subject, country, created_at, updated_at)
     VALUES ('buy_uk_7', 'UK buyer', 'test:uk-7', 'GB', now(), now())`,
  );
  const us: Actor = {
    kind: 'buyer',
    buyer_id: (
      await app.db.query<{ id: string }>(
        "SELECT id FROM buyers WHERE auth_subject = 'persona:buyer-a'",
      )
    ).rows[0]!.id,
  };
  await buyOffer(us, { publisher_slug: 'harbour-ledger', offer_code: 'tide-tables' });
  await buyOffer(
    { kind: 'buyer', buyer_id: 'buy_uk_7' },
    { publisher_slug: 'northfield-quarterly', offer_code: 'allotment-diary' },
  );
  await buyOffer(us, { publisher_slug: 'rheinwerft-kurier', offer_code: 'schleusenzeiten' });
  empty = createApp(await testEnv(), { switch_cache_ms: 0 });
  await empty.ready();
});
afterAll(async () => {
  await app.close();
  await empty.close();
});

const snapshot = async (a: App) => (await a.engine.opsSnapshot(OP))!;
const booked = (rows: readonly BookedTotal[], c: Cur) => rows.find((r) => r.currency === c)!;

/** Exact reference for the seed table (1 EUR = 1.15 USD = 0.87 GBP): minor * to / from, halves away from zero. */
function ref(minor: number, from: Cur, to: Cur): number {
  const per = { EUR: 100n, USD: 115n, GBP: 87n };
  const num = BigInt(minor) * per[to];
  const den = per[from];
  return Number((num * 2n + den) / (den * 2n));
}
const money = (minor: number, sym: string): string => `${sym}${(minor / 100).toFixed(2)}`;

describe('the operations snapshot carries the booked totals', () => {
  it('has one row per currency with the sales of the paid orders, and no refunds yet', async () => {
    const t = (await snapshot(app)).totals;
    for (const c of ['USD', 'EUR', 'GBP'] as const) {
      expect(paid[c]).toBeGreaterThan(0);
      expect(booked(t, c)).toMatchObject({
        environment: 'dryrun',
        sales_minor: paid[c],
        refunds_minor: 0,
        exposure_minor: paid[c],
      });
    }
  });
});

describe('the reporting view over engine.fx', () => {
  it('on the seed rates: three rows, each subtotal converted then added, "sample rate of"', async () => {
    const t = (await snapshot(app)).totals;
    const rates = await app.engine.fx.getRates();
    expect(rates!.source).toBe('seed');
    const at = new Date('2026-11-05T12:00:00Z');
    const v = opsReportingView(t, { convert: app.engine.fx.convert, rates, at });
    const g = v.groups[0]!;
    expect(g.reporting!.rate_note).toBe('Reporting view: about, at the sample rate of 2026-11-03.');
    const want = (to: Cur, sym: string) =>
      money(
        (['USD', 'EUR', 'GBP'] as const).reduce((s, c) => s + ref(paid[c], c, to), 0),
        sym,
      );
    expect(g.reporting!.rows.map((r) => r.sales)).toEqual([
      `about ${want('USD', '$')}`,
      `about ${want('EUR', '€')}`,
      `about ${want('GBP', '£')}`,
    ]);
    // Exposure equals sales here (nothing refunded, nothing held), so the third column agrees.
    expect(g.reporting!.rows.map((r) => r.exposure)).toEqual(g.reporting!.rows.map((r) => r.sales));
    expect(JSON.stringify(v)).not.toMatch(/ecb|central bank|european/i);
  });

  it('no rate stored: booked figures and the note, no reporting view', async () => {
    const t = (await snapshot(app)).totals;
    const v = opsReportingView(t, { convert: app.engine.fx.convert, rates: null });
    expect(v.groups[0]!.booked).toHaveLength(3);
    expect(v.groups[0]!.reporting).toBeNull();
    expect(v.groups[0]!.missing_note).toMatch(/^No exchange rate from the last 7 days is stored/);
  });

  it('a stored rate over 7 days old gives the same note', async () => {
    const t = (await snapshot(app)).totals;
    const rates = await app.engine.fx.getRates();
    const stale = opsReportingView(t, {
      convert: app.engine.fx.convert,
      rates,
      at: new Date('2026-11-11T00:00:00Z'),
    });
    expect(stale.groups[0]!.reporting).toBeNull();
    expect(stale.groups[0]!.missing_note).toMatch(
      /^No exchange rate from the last 7 days is stored/,
    );
    // Seven days exactly is still usable.
    const edge = opsReportingView(t, {
      convert: app.engine.fx.convert,
      rates,
      at: new Date('2026-11-10T00:00:00Z'),
    });
    expect(edge.groups[0]!.reporting).not.toBeNull();
  });

  it('a fetched real rate says "rate of <date>" and uses its factors', async () => {
    expect((await app.engine.fx.refreshIfStale()).status).toBe('refreshed');
    const rates = await app.engine.fx.getRates();
    expect(rates).toMatchObject({ date: TODAY, source: 'ecb', eur_usd: '1.2', eur_gbp: '0.88' });
    const t = (await snapshot(app)).totals;
    const v = opsReportingView(t, {
      convert: app.engine.fx.convert,
      rates,
      at: new Date(`${TODAY}T12:00:00Z`),
    });
    expect(v.groups[0]!.reporting!.rate_note).toBe(
      `Reporting view: about, at the rate of ${TODAY}.`,
    );
    // EUR row: USD paid / 1.2, GBP paid / 0.88 * 1, EUR as is; each rounded alone.
    const half = (n: bigint, d: bigint) => Number((n * 2n + d) / (d * 2n));
    const eur = half(BigInt(paid.USD) * 100n, 120n) + half(BigInt(paid.GBP) * 100n, 88n) + paid.EUR;
    expect(v.groups[0]!.reporting!.rows[1]!.sales).toBe(`about ${money(eur, '€')}`);
  });
});

describe('read only: nothing is written, statements and CSV files stay as they were', () => {
  const PUBS = ['harbour-ledger', 'northfield-quarterly', 'rheinwerft-kurier'];
  const digest = async (a: App): Promise<string> => {
    const out: unknown[] = [];
    for (const t of [
      'ledger_entries',
      'orders',
      'order_units',
      'receipts',
      'fx_rates',
      'refund_requests',
    ]) {
      out.push((await a.db.query(`SELECT * FROM ${t} ORDER BY 1`)).rows);
    }
    return JSON.stringify(out);
  };
  const sellerFiles = async (): Promise<string> => {
    const out: unknown[] = [];
    for (const slug of PUBS) {
      const id = (
        await app.db.query<{ id: string }>('SELECT id FROM publishers WHERE slug = $1', [slug])
      ).rows[0]!.id;
      const actor: Actor = { kind: 'publisher', publisher_id: id };
      out.push(await app.engine.publisherStatement(actor));
      out.push(await app.engine.publisherExport({ actor, kind: 'statement' }));
      out.push(await app.engine.publisherExport({ actor, kind: 'sales' }));
    }
    return JSON.stringify(out);
  };

  it('building the snapshot and the reporting view changes no table', async () => {
    const before = await digest(app);
    const t = (await snapshot(app)).totals;
    const rates = await app.engine.fx.getRates();
    opsReportingView(t, { convert: app.engine.fx.convert, rates });
    expect(await digest(app)).toBe(before);
  });

  it('every seller statement and CSV file is the same after, and stays in the seller currency', async () => {
    const before = await sellerFiles();
    const t = (await snapshot(app)).totals;
    opsReportingView(t, { convert: app.engine.fx.convert, rates: await app.engine.fx.getRates() });
    expect(await sellerFiles()).toBe(before);
    const files = JSON.parse(before) as unknown[];
    const csvs = files.filter((f) => typeof f === 'object' && f !== null && 'csv' in f) as {
      csv: string;
    }[];
    const text = csvs.map((c) => c.csv).join('\n');
    expect(text).toContain(',GBP,');
    expect(text).toContain(',EUR,');
    expect(text).toContain(',USD,');
    expect(text).not.toMatch(/about|reporting|sample rate|converted/i);
  });
});

describe('an empty database', () => {
  it('has no totals and the operations snapshot still builds', async () => {
    const s = await snapshot(empty);
    expect(s.totals).toEqual([]);
    expect(s.orders).toEqual([]);
    const v = opsReportingView(s.totals, {
      convert: empty.engine.fx.convert,
      rates: await empty.engine.fx.getRates(),
    });
    expect(v.groups).toEqual([]);
    expect(v.empty).toBe('No sales, refunds or held payments yet.');
  });
});

describe('the page', () => {
  // INT-UI0: the totals moved from /ops to /ops/money, and the read (the helper and the engine convert) moved
  // to that tab's composition module. Both files are checked.
  const src = readFileSync(new URL('./composition/ops-money.ts', import.meta.url), 'utf8');
  const page = readFileSync(new URL('./app/ops/money/page.tsx', import.meta.url), 'utf8');
  it('uses the one shared helper and the engine convert, and no rate of its own', () => {
    expect(src).toContain('opsReportingView(');
    expect(src).toContain('engine.fx');
    expect(src).not.toMatch(/fx_rates|eur_usd|eur_gbp|@umsbx\/fx/);
    expect(page).not.toMatch(/fx_rates|eur_usd|eur_gbp|@umsbx\/fx/);
  });
  it('the page shows the totals through ReportingTotals', () => {
    expect(page).toContain('<ReportingTotals view={reporting} />');
  });
});
