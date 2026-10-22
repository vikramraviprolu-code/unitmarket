// Adversarial inputs for the ledger: hostile strings are data, never SQL; concurrent refunds
// cannot overbook a capture.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { appendLedgerEntry, listLedger, unitBalance } from './index';
import { makeWorld } from './world';
import type { World } from './world';

let w: World;
beforeAll(async () => {
  w = await makeWorld('led-adv');
});
afterAll(async () => {
  await w.close();
});
const append = (e: Parameters<typeof appendLedgerEntry>[2]) =>
  w.db.transaction((tx) => appendLedgerEntry(tx, w.deps, e));

describe('ledger adversarial', () => {
  it('a hostile refund id is stored literally and cannot alter other rows', async () => {
    await w.order(1);
    await append(w.input(1, {}));
    const evil = `RF'); DELETE FROM ledger_entries; --`;
    const r = await append(w.input(1, { kind: 'refund', refund_id: evil, amount: { currency: 'USD', minor: 10 } }));
    expect(r.ok).toBe(true);
    const rows = await listLedger(w.db, { capture_id: 'CAP1' });
    expect(rows.map((x) => x.refund_id)).toEqual([null, evil]);
  });

  it('a hostile capture id or unit id is refused before any insert', async () => {
    await w.order(2);
    await append(w.input(2, {}));
    await expect(append(w.input(2, { kind: 'paypal_fee', capture_id: `CAP2' OR '1'='1` }))).rejects.toThrow();
    await expect(append(w.input(2, { kind: 'paypal_fee', unit_id: `unt_2' OR '1'='1` }))).rejects.toThrow();
    await expect(append(w.input(2, { kind: 'paypal_fee', unit_id: 'unt_2\u0000' }))).rejects.toThrow();
    expect(await listLedger(w.db, { capture_id: 'CAP2' })).toHaveLength(1);
  });

  it('two concurrent refunds that together exceed the sale cannot both book', async () => {
    await w.order(3);
    await append(w.input(3, {}));
    const mk = (id: string) =>
      append(w.input(3, { kind: 'refund', refund_id: id, amount: { currency: 'USD', minor: 300 } })).then(
        (r) => (r.ok ? 'booked' : 'duplicate'),
        () => 'refused',
      );
    const results = await Promise.all([mk('RFA'), mk('RFB')]);
    expect(results.filter((r) => r === 'booked')).toHaveLength(1);
    expect(unitBalance(await listLedger(w.db, { capture_id: 'CAP3' })).refunded_minor).toBe(300);
  });

  it('a refund on another order\'s capture cannot spend this sale', async () => {
    await w.order(4);
    await w.order(5);
    await append(w.input(4, {}));
    await expect(
      append(w.input(5, { kind: 'refund', refund_id: 'RFX', amount: { currency: 'USD', minor: 1 } })),
    ).rejects.toThrow();
    // Unit 5 asking with capture 4 is refused too.
    await expect(
      append(w.input(5, { kind: 'refund', capture_id: 'CAP4', refund_id: 'RFY', amount: { currency: 'USD', minor: 1 } })),
    ).rejects.toThrow(/capture/i);
  });
});
