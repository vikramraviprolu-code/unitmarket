// POB-M1 (D-089): the fee setting store and the offer price parts. Append-only fee_settings (the latest row
// rules), an operator with the second factor sets it, and the parts of an offer version are written once.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { currentFee, listFeeHistory, loadFeePolicy, recordOfferParts, setFee } from './index';
import { TIDE, count, offersWorld } from './write-support';
import type { OffersWorld } from './write-support';

let w: OffersWorld;
beforeAll(async () => {
  w = await offersWorld();
});
afterAll(async () => {
  await w.db.close();
});

const deps = () => ({ db: w.db, clock: w.clock, ids: w.deps().ids, audit: w.deps().audit });
const audits = (action: string) =>
  w.db.query<{
    actor_id: string | null;
    target: string | null;
    reason: string | null;
    detail: Record<string, unknown>;
  }>(
    'SELECT actor_id, target, reason, detail FROM audit_log WHERE action = $1 ORDER BY created_at, id',
    [action],
  );

describe('the fee setting', () => {
  it('starts at the seeded 10 percent', async () => {
    const f = await currentFee(w.db);
    expect(f).toMatchObject({ fee_bps: 1000, set_by: 'seed' });
    const policy = await loadFeePolicy(w.db);
    expect(policy.fee_bps).toBe(1000);
    expect(policy.feeFor(364, 'USD').buyer_minor).toBe(400);
  });

  it('an operator with the second factor sets it: a new row, the latest rules, one audit row', async () => {
    const before = await count(w.db, 'SELECT count(*) AS c FROM fee_settings');
    w.clock.advance(1000);
    const r = await setFee(deps(), { actor: w.operator, fee_bps: 750, reason: 'pilot rate' });
    expect(r.ok).toBe(true);
    expect(await count(w.db, 'SELECT count(*) AS c FROM fee_settings')).toBe(before + 1);
    expect(await currentFee(w.db)).toMatchObject({
      fee_bps: 750,
      set_by: 'opr_vikram',
      reason: 'pilot rate',
    });
    const a = (await audits('fee.set')).rows;
    expect(a).toHaveLength(1);
    expect(a[0]).toMatchObject({ actor_id: 'opr_vikram', reason: 'pilot rate' });
    expect(a[0]!.detail).toMatchObject({ fee_bps: 750, previous_fee_bps: 1000 });
  });

  it('the history is newest first and rows are never changed or removed', async () => {
    w.clock.advance(1000);
    await setFee(deps(), { actor: w.operator, fee_bps: 0, reason: 'free month' });
    const h = await listFeeHistory(w.db, 10);
    expect(h.map((x) => x.fee_bps)).toEqual([0, 750, 1000]);
    await expect(w.db.query('UPDATE fee_settings SET fee_bps = 5')).rejects.toThrow();
    await expect(w.db.query('DELETE FROM fee_settings')).rejects.toThrow();
    expect((await currentFee(w.db)).fee_bps).toBe(0);
  });

  it('two settings at the same instant still have a latest', async () => {
    const d = deps();
    const a = await setFee(d, { actor: w.operator, fee_bps: 100, reason: 'first of two' });
    const b = await setFee(d, { actor: w.operator, fee_bps: 200, reason: 'second of two' });
    expect(a.ok && b.ok).toBe(true);
    expect((await currentFee(w.db)).fee_bps).toBe(200);
  });

  it('accepts 0 and 3000 and refuses 3001, -1, a fraction, a string, NaN', async () => {
    w.clock.advance(1000);
    expect((await setFee(deps(), { actor: w.operator, fee_bps: 3000, reason: 'ceiling' })).ok).toBe(
      true,
    );
    expect((await currentFee(w.db)).fee_bps).toBe(3000);
    const rows = await count(w.db, 'SELECT count(*) AS c FROM fee_settings');
    for (const bad of [3001, -1, 12.5, '1000', Number.NaN, null, undefined, 1e9]) {
      const r = await setFee(deps(), { actor: w.operator, fee_bps: bad, reason: 'bad value' });
      expect(r).toEqual({ ok: false, error: { code: 'fee_invalid' } });
    }
    expect(await count(w.db, 'SELECT count(*) AS c FROM fee_settings')).toBe(rows);
    expect((await currentFee(w.db)).fee_bps).toBe(3000);
  });

  it('needs an operator, the second factor and a reason of 3 to 200 characters; nothing is written otherwise', async () => {
    const rows = await count(w.db, 'SELECT count(*) AS c FROM fee_settings');
    const logs = await count(w.db, "SELECT count(*) AS c FROM audit_log WHERE action = 'fee.set'");
    const no = { ok: false, error: { code: 'not_operator' } };
    for (const actor of [w.buyer, w.harbour, w.system]) {
      expect(await setFee(deps(), { actor, fee_bps: 500, reason: 'try it' })).toEqual(no);
    }
    expect(
      await setFee(deps(), {
        actor: { kind: 'operator', operator_id: 'opr_x', mfa: false },
        fee_bps: 500,
        reason: 'no factor',
      }),
    ).toEqual({ ok: false, error: { code: 'mfa_required' } });
    for (const reason of ['', 'ab', '   ', 'x'.repeat(201), 7 as unknown as string]) {
      expect(await setFee(deps(), { actor: w.operator, fee_bps: 500, reason })).toEqual({
        ok: false,
        error: { code: 'reason_invalid' },
      });
    }
    expect(await count(w.db, 'SELECT count(*) AS c FROM fee_settings')).toBe(rows);
    expect(await count(w.db, "SELECT count(*) AS c FROM audit_log WHERE action = 'fee.set'")).toBe(
      logs,
    );
  });

  it('a policy keeps the rate it was loaded at when the setting changes later', async () => {
    w.clock.advance(1000);
    await setFee(deps(), { actor: w.operator, fee_bps: 1000, reason: 'back to ten' });
    const old = await loadFeePolicy(w.db);
    w.clock.advance(1000);
    await setFee(deps(), { actor: w.operator, fee_bps: 500, reason: 'then five' });
    expect(old.fee_bps).toBe(1000);
    expect(old.feeFor(100, 'USD').fee_minor).toBe(10);
    expect((await loadFeePolicy(w.db)).feeFor(100, 'USD').fee_minor).toBe(5);
  });
});

describe('offer price parts', () => {
  const priceOf = async (): Promise<number> => {
    const r = await w.db.query<{ options: { option: string; price_minor: number }[] }>(
      "SELECT options FROM offers WHERE id = $1 AND version = '1'",
      [TIDE],
    );
    return r.rows[0]!.options.find((o) => o.option === 'keep_retrieve')!.price_minor;
  };

  it('records the split of an offer option once; seller plus fee must equal the listed price', async () => {
    const price = await priceOf();
    // The listed price is the buyer price: seller plus fee add up to it.
    const fee = Math.round(price / 11);
    const own = { seller_minor: price - fee, fee_minor: fee, fee_bps: 1000, tax_minor: 0 as const };
    await w.db.transaction((tx) =>
      recordOfferParts(
        tx,
        { clock: w.clock },
        {
          offer_id: TIDE,
          offer_version: '1',
          option: 'keep_retrieve',
          parts: { ...own, buyer_minor: price },
        },
      ),
    );
    const row = (
      await w.db.query(
        "SELECT seller_minor, fee_minor, tax_minor, fee_bps FROM offer_price_parts WHERE offer_id = $1 AND offer_version = '1' AND option = 'keep_retrieve'",
        [TIDE],
      )
    ).rows[0];
    expect(row).toEqual({
      seller_minor: own.seller_minor,
      fee_minor: fee,
      tax_minor: 0,
      fee_bps: 1000,
    });
    // Written once: a second write for the same version and option, and any change, are refused.
    await expect(
      w.db.transaction((tx) =>
        recordOfferParts(
          tx,
          { clock: w.clock },
          {
            offer_id: TIDE,
            offer_version: '1',
            option: 'keep_retrieve',
            parts: { ...own, buyer_minor: price },
          },
        ),
      ),
    ).rejects.toThrow();
    await expect(w.db.query('UPDATE offer_price_parts SET fee_minor = 0')).rejects.toThrow();
    await expect(w.db.query('DELETE FROM offer_price_parts')).rejects.toThrow();
  });

  it('refuses parts that do not add up to the listed price of that option, and an unknown option', async () => {
    const price = await priceOf();
    await expect(
      w.db.transaction((tx) =>
        recordOfferParts(
          tx,
          { clock: w.clock },
          {
            offer_id: TIDE,
            offer_version: '1',
            option: 'online_read',
            parts: { seller_minor: 1, fee_minor: 1, buyer_minor: 2, fee_bps: 1000, tax_minor: 0 },
          },
        ),
      ),
    ).rejects.toThrow();
    await expect(
      w.db.transaction((tx) =>
        recordOfferParts(
          tx,
          { clock: w.clock },
          {
            offer_id: 'ofr_none',
            offer_version: '1',
            option: 'keep_retrieve',
            parts: {
              seller_minor: price,
              fee_minor: 0,
              buyer_minor: price,
              fee_bps: 0,
              tax_minor: 0,
            },
          },
        ),
      ),
    ).rejects.toThrow();
  });
});
