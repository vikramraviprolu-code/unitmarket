// DP-2a (MVP-D): adversarial cases of the per-PayPal-order engine. Concurrency (PGlite serialises, so
// this proves the gate and the pre-gate, not Postgres lock behaviour), the lock order, ids from the
// URL, and the rule that no create ever carries two units.
import { afterEach, describe, expect, it } from 'vitest';
import type { PaymentsDeps, SqlExecutor } from '@umsbx/contracts';
import { beginCheckout, onBuyerReturn, placeOrder } from './index';
import {
  BUYER_A,
  BUYER_B,
  approved,
  awaiting,
  count,
  makeWorld,
  place,
  providerOrdersOf,
} from './support';
import type { World } from './support';

let w: World;
afterEach(async () => {
  expect(w.paypal.violations).toEqual([]);
  await w.close();
});
const PACK = { offers: ['ofr_1', 'ofr_3'] };
const ret = (ref: string, d: PaymentsDeps = w.deps) =>
  onBuyerReturn(d, { order_ref: ref, actor: BUYER_A });

describe('concurrent returns', () => {
  it('20 concurrent returns: one capture per PayPal order', async () => {
    w = await makeWorld();
    const a = await approved(w, PACK);
    const results = await Promise.all(Array.from({ length: 20 }, () => ret(a.order_ref)));
    expect(results.every((r) => r.ok || r.error.code === 'not_approved')).toBe(true);
    const caps = w.paypal.calls.filter((c) => c.op === 'capture');
    expect(caps.map((c) => c.provider_order_id).sort()).toEqual(
      a.provider_orders.map((p) => p.provider_order_id as string).sort(),
    );
    expect(new Set(caps.map((c) => c.request_id)).size).toBe(2);
    expect(await count(w, 'ledger_entries', "kind = 'sale'")).toBe(2);
    const done = await ret(a.order_ref);
    expect(done.ok && done.value.status).toBe('paid');
    expect(w.paypal.calls.filter((c) => c.op === 'capture')).toHaveLength(2);
  });

  it('20 concurrent returns while PO2 is not approved: no capture at all', async () => {
    w = await makeWorld();
    const a = await awaiting(w, PACK);
    w.paypal.approve(a.provider_orders[0]!.provider_order_id as string);
    await Promise.all(Array.from({ length: 20 }, () => ret(a.order_ref)));
    expect(w.paypal.count('capture')).toBe(0);
  });

  it('two captures of one PayPal order at the gate: the second finds it already sent', async () => {
    w = await makeWorld();
    const a = await approved(w, PACK);
    let release: () => void = () => undefined;
    w.paypal.hold = new Promise<void>((r) => {
      release = r;
    });
    const both = Promise.all([ret(a.order_ref), ret(a.order_ref)]);
    await new Promise((r) => setTimeout(r, 50));
    release();
    await both;
    w.paypal.hold = null;
    expect(w.paypal.calls.filter((c) => c.op === 'capture')).toHaveLength(2);
  });
});

describe('ids from the URL', () => {
  it('URL ids ignored: only the stored PayPal order ids are ever read or captured', async () => {
    w = await makeWorld();
    const a = await approved(w, PACK);
    const stored = new Set(a.provider_orders.map((p) => p.provider_order_id));
    // a reference that smuggles a PayPal order id, or another buyer's reference, names no order
    for (const ref of [
      `${a.order_ref}?token=SBXFAKEORD99999`,
      `${a.order_ref}-p2`,
      'SBXFAKEORD00001',
    ]) {
      const r = await ret(ref);
      expect(r).toEqual({ ok: false, error: { code: 'not_found' } });
    }
    expect(await onBuyerReturn(w.deps, { order_ref: a.order_ref, actor: BUYER_B })).toEqual({
      ok: false,
      error: { code: 'not_found' },
    });
    expect(w.paypal.calls.filter((c) => c.op !== 'create')).toHaveLength(0);
    // the scenario argument is a fixture name, never an id
    await onBuyerReturn(w.deps, { order_ref: a.order_ref, actor: BUYER_A, scenario: 'x' });
    for (const c of w.paypal.calls.filter((c) => c.op !== 'create')) {
      expect(stored.has(c.provider_order_id)).toBe(true);
    }
  });
});

describe('creates', () => {
  it('no create carries two units, for a pack, a single order, and a retry', async () => {
    w = await makeWorld();
    await awaiting(w, PACK);
    await awaiting(w, { buyer_id: 'buy_B', actor: BUYER_B, offers: ['ofr_2'] });
    for (const o of w.paypal.orders.values()) expect(o.req.units).toHaveLength(1);
    expect(w.paypal.count('create')).toBe(3);
  });

  it('two orders never share an invoice id', async () => {
    w = await makeWorld();
    const a = await awaiting(w, PACK);
    const b = await awaiting(w, { buyer_id: 'buy_B', actor: BUYER_B, offers: ['ofr_1', 'ofr_3'] });
    const invoices = [...w.paypal.orders.values()].map((o) => o.req.invoice_id ?? o.req.order_ref);
    expect(new Set(invoices).size).toBe(4);
    expect(invoices).toContain(`${a.order_ref}-p1`);
    expect(invoices).toContain(`${b.order_ref}-p2`);
  });

  it('a concurrent checkout creates each PayPal order once', async () => {
    w = await makeWorld();
    const p = await place(w, PACK);
    await Promise.all([
      beginCheckout(w.deps, { order_id: p.order_id, actor: BUYER_A }),
      beginCheckout(w.deps, { order_id: p.order_id, actor: BUYER_A }),
      beginCheckout(w.deps, { order_id: p.order_id, actor: BUYER_A }),
    ]);
    expect(w.paypal.count('create')).toBe(2);
    const keys = w.paypal.calls.filter((c) => c.op === 'create').map((c) => c.request_id);
    expect(new Set(keys).size).toBe(2);
  });
});

// ---- lock order -------------------------------------------------------------------------------
const RANK: Record<string, number> = {
  orders: 1,
  provider_orders: 1.5,
  operations: 2,
  order_units: 3,
  refund_requests: 4,
  recovery_cases: 4.5,
  entitlements: 5,
  access_windows: 5,
  access_events: 5,
  access_links: 5,
  ledger_entries: 6,
  receipts: 6,
};
function lockTarget(sql: string): string | null {
  const s = sql.replace(/\s+/g, ' ').trim();
  const write = /^(?:UPDATE|INSERT INTO|DELETE FROM) (\w+)/i.exec(s);
  if (write !== null) return write[1]!.toLowerCase();
  if (!/ FOR UPDATE\b/i.test(s)) return null;
  const of = / FOR UPDATE OF (\w+)/i.exec(s);
  if (of !== null) {
    const hit = new RegExp(`(?:FROM|JOIN) (\\w+)(?: AS)? ${of[1]}\\b`, 'i').exec(s);
    return (hit?.[1] ?? of[1]!).toLowerCase();
  }
  return /FROM (\w+)/i.exec(s)?.[1]?.toLowerCase() ?? null;
}
function spy(d: PaymentsDeps, log: { table: string; sql: string }[][]): PaymentsDeps {
  return {
    ...d,
    db: {
      ...d.db,
      transaction: (fn) => {
        const rec: { table: string; sql: string }[] = [];
        log.push(rec);
        return d.db.transaction((tx) =>
          fn({
            query: (sql: string, params?: unknown[]) => {
              const t = lockTarget(sql);
              if (t !== null)
                rec.push({ table: t, sql: sql.replace(/\s+/g, ' ').trim().slice(0, 120) });
              return tx.query(sql, params);
            },
            exec: (sql: string) => tx.exec(sql),
          } as SqlExecutor),
        );
      },
    },
  };
}
function violations(log: { table: string; sql: string }[][]): string[] {
  const bad: string[] = [];
  for (const tx of log) {
    const held = new Map<number, string>();
    for (const l of tx) {
      const r = RANK[l.table];
      if (r === undefined || held.has(r)) continue;
      const above = [...held.entries()].filter(([k]) => k > r);
      if (above.length > 0) bad.push(`${l.table}(${r}) after rank ${above[0]![0]} by [${l.sql}]`);
      held.set(r, l.sql);
    }
  }
  return [...new Set(bad)];
}

describe('lock order', () => {
  it('lock order spy, provider_orders after orders: place, checkout, return, capture, read-back', async () => {
    w = await makeWorld();
    const log: { table: string; sql: string }[][] = [];
    const d = spy(w.deps, log);
    const approval = await w.approval(PACK);
    // A new order's rows are rows nobody else can hold: placing is not a lock event, so it runs unspied.
    const placed = await placeOrder(w.deps, {
      approval_id: approval.approval_id,
      token: approval.token,
      actor: BUYER_A,
    });
    if (!placed.ok) throw new Error('place failed');
    await beginCheckout(d, { order_id: placed.value.order_id, actor: BUYER_A });
    // first return: PO1 approved only; then both; then the captures and read-backs
    const pos = await providerOrdersOf(w, placed.value.order_id);
    w.paypal.approve(pos[0]!.provider_order_id as string);
    await ret(placed.value.order_ref, d);
    w.paypal.approve(pos[1]!.provider_order_id as string);
    w.paypal.nextBy.set(pos[1]!.provider_order_id as string, { status: 'DECLINED', fee: null });
    await ret(placed.value.order_ref, d);

    expect(log.length).toBeGreaterThan(8);
    expect(violations(log)).toEqual([]);
    // somewhere a transaction took orders, then provider_orders, then operations, in that order
    const sawAll = log.some((tx) => {
      const tables = tx.map((l) => l.table);
      const o = tables.indexOf('orders');
      const p = tables.indexOf('provider_orders');
      const op = tables.indexOf('operations');
      return o >= 0 && p > o && op > p;
    });
    expect(sawAll).toBe(true);
    // and none locked provider_orders before orders
    for (const tx of log) {
      const tables = tx.map((l) => l.table);
      const o = tables.indexOf('orders');
      const p = tables.indexOf('provider_orders');
      if (p >= 0 && o >= 0) expect(p, tx.map((l) => l.sql).join(' | ')).toBeGreaterThan(o);
    }
  });

  it('the provider orders of an order are locked by position, FOR UPDATE, between the order and its operations', async () => {
    w = await makeWorld();
    const log: { table: string; sql: string }[][] = [];
    const d = spy(w.deps, log);
    const a = await approved(w, PACK);
    await ret(a.order_ref, d);
    const lockStatements = log
      .flat()
      .filter((l) => l.table === 'provider_orders' && /FOR UPDATE/i.test(l.sql));
    expect(lockStatements.length).toBeGreaterThan(0);
    for (const l of lockStatements) expect(l.sql).toMatch(/ORDER BY position/i);
  });
});
