// State tests for the append-only ledger against a real (PGlite) database.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { LedgerEntryInput, Result } from '@umsbx/contracts';
import { appendLedgerEntry, listLedger, unitBalance } from './index';
import { makeWorld } from './world';
import type { World } from './world';

let w: World;
let n = 0;
beforeAll(async () => {
  w = await makeWorld('led');
});
afterAll(async () => {
  await w.close();
});

const append = (e: LedgerEntryInput) => w.db.transaction((tx) => appendLedgerEntry(tx, w.deps, e));
function value<T, E>(r: Result<T, E>): T {
  if (!r.ok) throw new Error(`expected ok, got ${JSON.stringify(r.error)}`);
  return r.value;
}
async function booked(over: { currency?: string; amount_minor?: number } = {}) {
  n += 1;
  const o = await w.order(n, over);
  const sale = value(
    await append(
      w.input(n, { amount: { currency: over.currency ?? 'USD', minor: over.amount_minor ?? 500 } }),
    ),
  );
  return { n, ...o, sale };
}
const refund = (k: number, id: string, minor: number) =>
  w.input(k, { kind: 'refund', refund_id: id, amount: { currency: 'USD', minor } });

describe('append', () => {
  it('sale books once per capture', async () => {
    const { n: k, sale, unit_id } = await booked();
    expect(sale).toMatchObject({ unit_id, kind: 'sale', environment: 'dryrun', refund_id: null });
    expect(sale.id).toMatch(/^led_/);
    const again = await append(w.input(k, { amount: { currency: 'USD', minor: 500 } }));
    expect(again).toEqual({ ok: false, error: { code: 'duplicate', existing_entry_id: sale.id } });
    // A sale with a different amount for the same capture is still a duplicate; nothing is overwritten.
    const other = await append(w.input(k, { amount: { currency: 'USD', minor: 100 } }));
    expect(other).toEqual({ ok: false, error: { code: 'duplicate', existing_entry_id: sale.id } });
    const rows = await listLedger(w.db, { capture_id: `CAP${k}` });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.amount.minor).toBe(500);
  });

  it('two partial refunds with different refund ids both book', async () => {
    const { n: k, capture_id } = await booked();
    const r1 = value(await append(refund(k, 'RF1', 100)));
    const r2 = value(await append(refund(k, 'RF2', 150)));
    expect(r1.id).not.toBe(r2.id);
    const rows = await listLedger(w.db, { capture_id });
    expect(unitBalance(rows)).toEqual({
      sold_minor: 500,
      refunded_minor: 250,
      reversed_minor: 0,
      net_minor: 250,
    });
  });

  it('same refund id twice is duplicate', async () => {
    const { n: k } = await booked();
    const first = value(await append(refund(k, 'RF1', 100)));
    const second = await append(refund(k, 'RF1', 100));
    expect(second).toEqual({
      ok: false,
      error: { code: 'duplicate', existing_entry_id: first.id },
    });
    // A replay is not double counted, and a replay with a larger amount does not rewrite history.
    const third = await append(refund(k, 'RF1', 400));
    expect(third).toEqual({ ok: false, error: { code: 'duplicate', existing_entry_id: first.id } });
    expect(unitBalance(await listLedger(w.db, { unit_id: `unt_${k}` })).refunded_minor).toBe(100);
  });

  it('refund above remaining is refused', async () => {
    const { n: k } = await booked();
    value(await append(refund(k, 'RF1', 300)));
    await expect(append(refund(k, 'RF2', 201))).rejects.toThrow(/exceed/i);
    value(await append(refund(k, 'RF2', 200)));
    await expect(append(refund(k, 'RF3', 1))).rejects.toThrow(/exceed/i);
    expect(unitBalance(await listLedger(w.db, { unit_id: `unt_${k}` })).net_minor).toBe(0);
  });

  it('reversal above remaining after refunds is refused', async () => {
    const { n: k } = await booked();
    value(await append(refund(k, 'RF1', 300)));
    await expect(
      append(w.input(k, { kind: 'reversal', amount: { currency: 'USD', minor: 201 } })),
    ).rejects.toThrow(/exceed/i);
    value(await append(w.input(k, { kind: 'reversal', amount: { currency: 'USD', minor: 200 } })));
  });

  it('refund with no sale for the capture is refused', async () => {
    n += 1;
    await w.order(n);
    await expect(append(refund(n, 'RF1', 1))).rejects.toThrow(/exceed|sale/i);
  });
});

describe('programmer errors are thrown, not booked', () => {
  it('currency must equal the order currency', async () => {
    n += 1;
    await w.order(n);
    await expect(append(w.input(n, { amount: { currency: 'EUR', minor: 500 } }))).rejects.toThrow(
      /currency/i,
    );
    n += 1;
    await w.order(n, { currency: 'EUR' });
    await expect(append(w.input(n, { amount: { currency: 'USD', minor: 500 } }))).rejects.toThrow(
      /currency/i,
    );
  });

  it('refund and commission_reversal need a refund id, other kinds must not carry one', async () => {
    const { n: k } = await booked();
    await expect(
      append(
        w.input(k, { kind: 'refund', refund_id: null, amount: { currency: 'USD', minor: 1 } }),
      ),
    ).rejects.toThrow(/refund_id/);
    await expect(
      append(
        w.input(k, { kind: 'reversal', refund_id: 'RF9', amount: { currency: 'USD', minor: 1 } }),
      ),
    ).rejects.toThrow(/refund_id/);
    await expect(
      append(
        w.input(k, { kind: 'paypal_fee', refund_id: 'RF9', amount: { currency: 'USD', minor: 1 } }),
      ),
    ).rejects.toThrow(/refund_id/);
    expect(await listLedger(w.db, { unit_id: `unt_${k}` })).toHaveLength(1);
  });

  it('platform_fee is never written in MVP-A (D-3)', async () => {
    const { n: k } = await booked();
    await expect(
      append(w.input(k, { kind: 'platform_fee', amount: { currency: 'USD', minor: 5 } })),
    ).rejects.toThrow(/platform_fee/);
  });

  it('the capture id must belong to the unit, the unit must exist', async () => {
    const { n: k } = await booked();
    await expect(
      append(w.input(k, { kind: 'paypal_fee', capture_id: 'OTHERCAP' })),
    ).rejects.toThrow(/capture/i);
    await expect(
      append(w.input(k, { kind: 'paypal_fee', unit_id: 'unt_missing' })),
    ).rejects.toThrow(/unit/i);
  });

  it('amounts are integers: float, negative and malformed input throw', async () => {
    const { n: k } = await booked();
    await expect(
      append(w.input(k, { kind: 'paypal_fee', amount: { currency: 'USD', minor: 1.5 } })),
    ).rejects.toThrow();
    await expect(
      append(w.input(k, { kind: 'paypal_fee', amount: { currency: 'USD', minor: -1 } })),
    ).rejects.toThrow();
    await expect(append(refund(k, 'RF1', 0))).rejects.toThrow();
    await expect(
      append({ ...w.input(k, { kind: 'paypal_fee' }), extra: 1 } as LedgerEntryInput),
    ).rejects.toThrow();
  });

  it('ref_entry_id must name an entry of the same capture', async () => {
    const a = await booked();
    const b = await booked();
    await expect(
      append(w.input(a.n, { kind: 'paypal_fee', ref_entry_id: b.sale.id })),
    ).rejects.toThrow(/ref_entry_id/);
    const ok = value(
      await append(
        w.input(a.n, {
          kind: 'paypal_fee',
          ref_entry_id: a.sale.id,
          amount: { currency: 'USD', minor: 30 },
        }),
      ),
    );
    expect(ok.ref_entry_id).toBe(a.sale.id);
  });
});

describe('append-only (P12, A-21)', () => {
  it('UPDATE and DELETE refused', async () => {
    const { sale } = await booked();
    await expect(
      w.db.query('UPDATE ledger_entries SET amount_minor = 1 WHERE id = $1', [sale.id]),
    ).rejects.toThrow(/append-only/);
    await expect(w.db.query('DELETE FROM ledger_entries WHERE id = $1', [sale.id])).rejects.toThrow(
      /append-only/,
    );
    const rows = await listLedger(w.db, { capture_id: sale.capture_id });
    expect(rows[0]!.amount.minor).toBe(500);
  });

  it('the module exports no update or delete function', async () => {
    const mod = await import('./index');
    const names = Object.keys(mod).filter((k) => /update|delete|remove|set|edit/i.test(k));
    expect(names).toEqual([]);
  });
});

describe('listLedger', () => {
  it('filters by order, unit and capture; stable order; empty for unknown', async () => {
    const { n: k, order_id, unit_id, capture_id } = await booked();
    value(await append(refund(k, 'RF1', 100)));
    value(await append(w.input(k, { kind: 'paypal_fee', amount: { currency: 'USD', minor: 29 } })));
    const byOrder = await listLedger(w.db, { order_id });
    expect(byOrder.map((r) => r.kind)).toEqual(['sale', 'paypal_fee', 'refund']);
    expect(await listLedger(w.db, { unit_id })).toEqual(byOrder);
    expect(await listLedger(w.db, { capture_id })).toEqual(byOrder);
    expect(await listLedger(w.db, { order_id: 'ord_none' })).toEqual([]);
  });
});
