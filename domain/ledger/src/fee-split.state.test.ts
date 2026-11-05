// POB-M1 (D-089): the ledger split. At capture the sale row stays the gross buyer total and two more rows record the
// fee and the amount payable to the publisher. A refund reverses the three in proportion; the parts always sum to
// the refund, and the fee reversed over all refunds is exactly the fee (cumulative rounding, half away from zero).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { LedgerEntry, LedgerEntryInput } from '@umsbx/contracts';
import {
  LedgerRuleError,
  appendLedgerEntry,
  bookRefundParts,
  bookSaleParts,
  getUnitParts,
  listLedger,
  splitRefund,
  unitBalance,
  unitSplit,
} from './index';
import { makeWorld } from './world';
import type { World } from './world';

let w: World;
let n = 100;
beforeAll(async () => {
  w = await makeWorld('split');
});
afterAll(async () => {
  await w.close();
});

const tx = <T>(f: (t: Parameters<Parameters<World['db']['transaction']>[0]>[0]) => Promise<T>) =>
  w.db.transaction(f);

/** A captured unit of seller + fee minor units with its parts row and its gross sale row. */
async function sold(seller: number, fee: number, withParts = true) {
  n += 1;
  const amount = seller + fee;
  const o = await w.order(n, { amount_minor: amount });
  if (withParts) {
    await w.insert('order_unit_parts', {
      unit_id: o.unit_id,
      seller_minor: seller,
      fee_minor: fee,
      tax_minor: 0,
    });
  }
  const sale = await tx((t) =>
    appendLedgerEntry(t, w.deps, {
      unit_id: o.unit_id,
      capture_id: o.capture_id,
      kind: 'sale',
      amount: { currency: 'USD', minor: amount },
      refund_id: null,
      ref_entry_id: null,
    }),
  );
  if (!sale.ok) throw new Error('sale not booked');
  return { ...o, n, amount, sale_id: sale.value.id };
}
const bookParts = (u: Awaited<ReturnType<typeof sold>>) =>
  tx((t) =>
    bookSaleParts(t, w.deps, {
      unit_id: u.unit_id,
      capture_id: u.capture_id,
      sale_entry_id: u.sale_id,
    }),
  );
const rows = (u: { unit_id: string }) => listLedger(w.db, { unit_id: u.unit_id });
const sum = (es: LedgerEntry[], kind: string) =>
  es.filter((e) => e.kind === kind).reduce((s, e) => s + e.amount.minor, 0);

/** Books one refund the way the payments module does: the refund row, then its parts. */
async function refund(u: Awaited<ReturnType<typeof sold>>, id: string, minor: number) {
  const before = sum(await rows(u), 'refund');
  const parts = await getUnitParts(w.db, u.unit_id);
  const split = splitRefund(parts!, before, minor);
  await tx(async (t) => {
    const r = await appendLedgerEntry(t, w.deps, {
      unit_id: u.unit_id,
      capture_id: u.capture_id,
      kind: 'refund',
      amount: { currency: 'USD', minor },
      refund_id: id,
      ref_entry_id: u.sale_id,
    });
    if (!r.ok) throw new Error('refund not booked');
    await bookRefundParts(t, w.deps, {
      unit_id: u.unit_id,
      capture_id: u.capture_id,
      refund_id: id,
      ref_entry_id: u.sale_id,
      split,
    });
  });
  return split;
}

describe('splitRefund (pure)', () => {
  const P = { seller_minor: 910, fee_minor: 91 }; // a unit of 1001
  it('a full refund reverses the whole fee and the whole payable', () => {
    expect(splitRefund(P, 0, 1001)).toEqual({ fee_minor: 91, payable_minor: 910 });
  });
  it('rounds the running total half away from zero and the parts sum to the refund', () => {
    // 333 -> 30.27 -> 30; 666 -> 60.55 -> 61 (31 more); 1001 -> 91 (30 more)
    expect(splitRefund(P, 0, 333)).toEqual({ fee_minor: 30, payable_minor: 303 });
    expect(splitRefund(P, 333, 333)).toEqual({ fee_minor: 31, payable_minor: 302 });
    expect(splitRefund(P, 666, 335)).toEqual({ fee_minor: 30, payable_minor: 305 });
  });
  it('a half rounds away from zero: fee 1 of 2, refund 1 reverses the fee first', () => {
    expect(splitRefund({ seller_minor: 1, fee_minor: 1 }, 0, 1)).toEqual({
      fee_minor: 1,
      payable_minor: 0,
    });
    expect(splitRefund({ seller_minor: 1, fee_minor: 1 }, 1, 1)).toEqual({
      fee_minor: 0,
      payable_minor: 1,
    });
  });
  it('a zero fee reverses only payable, and a tiny fee waits for the end', () => {
    expect(splitRefund({ seller_minor: 400, fee_minor: 0 }, 0, 123)).toEqual({
      fee_minor: 0,
      payable_minor: 123,
    });
    expect(splitRefund({ seller_minor: 99, fee_minor: 1 }, 0, 49)).toEqual({
      fee_minor: 0,
      payable_minor: 49,
    });
    expect(splitRefund({ seller_minor: 99, fee_minor: 1 }, 49, 1)).toEqual({
      fee_minor: 1,
      payable_minor: 0,
    });
  });
  it('is exact for large amounts', () => {
    const big = { seller_minor: 1_800_000_000, fee_minor: 200_000_000 };
    const s = splitRefund(big, 0, 2_000_000_000);
    expect(s).toEqual({ fee_minor: 200_000_000, payable_minor: 1_800_000_000 });
  });
  it('refuses amounts that cannot be (negative, zero, above what is left, not whole)', () => {
    expect(() => splitRefund(P, 0, 0)).toThrow(RangeError);
    expect(() => splitRefund(P, 0, -5)).toThrow(RangeError);
    expect(() => splitRefund(P, 0, 1.5)).toThrow(RangeError);
    expect(() => splitRefund(P, 1000, 2)).toThrow(RangeError);
    expect(() => splitRefund(P, -1, 2)).toThrow(RangeError);
  });
  it('over every sequence of refunds the parts sum to each refund and the fee reversed ends at the fee', () => {
    // A small deterministic generator, so the cases do not change between runs.
    let seed = 12345;
    const next = (m: number): number => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed % m;
    };
    for (let round = 0; round < 400; round += 1) {
      const seller = 1 + next(5000);
      const fee = next(Math.max(1, Math.floor(seller * 0.43)) + 1);
      const total = seller + fee;
      let done = 0;
      let feeSum = 0;
      let paySum = 0;
      while (done < total) {
        const left = total - done;
        const r = next(3) === 0 ? left : 1 + next(left);
        const s = splitRefund({ seller_minor: seller, fee_minor: fee }, done, r);
        expect(s.fee_minor + s.payable_minor).toBe(r);
        expect(s.fee_minor).toBeGreaterThanOrEqual(0);
        expect(s.payable_minor).toBeGreaterThanOrEqual(0);
        feeSum += s.fee_minor;
        paySum += s.payable_minor;
        done += r;
      }
      expect(feeSum).toBe(fee);
      expect(paySum).toBe(seller);
    }
  });
});

describe('at capture', () => {
  it('keeps the sale row gross and adds a fee row and a payable row that add up to it', async () => {
    const u = await sold(360, 40);
    const booked = await bookParts(u);
    expect(booked).toEqual({ seller_minor: 360, fee_minor: 40 });
    const es = await rows(u);
    expect(es.map((e) => [e.kind, e.amount.minor])).toEqual(
      expect.arrayContaining([
        ['sale', 400],
        ['fee', 40],
        ['payable', 360],
      ]),
    );
    expect(sum(es, 'sale')).toBe(400);
    expect(sum(es, 'fee') + sum(es, 'payable')).toBe(400);
    // The old figures do not move: the sale is still the buyer total and the net is the sale.
    expect(unitBalance(es)).toEqual({
      sold_minor: 400,
      refunded_minor: 0,
      reversed_minor: 0,
      net_minor: 400,
    });
    expect(unitSplit(es)).toEqual({
      fee_minor: 40,
      payable_minor: 360,
      fee_reversed_minor: 0,
      payable_reversed_minor: 0,
      adjustment_minor: 0,
    });
    // The new rows point at the sale and are tied to the capture.
    for (const e of es.filter((x) => x.kind === 'fee' || x.kind === 'payable')) {
      expect(e).toMatchObject({
        capture_id: u.capture_id,
        refund_id: null,
        ref_entry_id: u.sale_id,
      });
      expect(e.id).toMatch(/^led_/);
    }
  });

  it('a unit with no fee writes the payable row only, equal to the sale', async () => {
    const u = await sold(400, 0);
    expect(await bookParts(u)).toEqual({ seller_minor: 400, fee_minor: 0 });
    const es = await rows(u);
    expect(es.filter((e) => e.kind === 'fee')).toEqual([]);
    expect(sum(es, 'payable')).toBe(400);
  });

  it('booking twice (a replay of the same capture) adds nothing', async () => {
    const u = await sold(360, 40);
    await bookParts(u);
    const first = (await rows(u)).length;
    expect(await bookParts(u)).toEqual({ seller_minor: 360, fee_minor: 40 });
    expect((await rows(u)).length).toBe(first);
  });

  it('a unit without a parts row (a sale made before the fee existed) is left alone', async () => {
    const u = await sold(400, 0, false);
    expect(await bookParts(u)).toBeNull();
    expect((await rows(u)).map((e) => e.kind)).toEqual(['sale']);
    expect(await getUnitParts(w.db, u.unit_id)).toBeNull();
  });

  it('refuses to book parts against a sale of another amount (a caller bug, nothing is written)', async () => {
    n += 1;
    const o = await w.order(n, { amount_minor: 400 });
    await w.insert('order_unit_parts', {
      unit_id: o.unit_id,
      seller_minor: 360,
      fee_minor: 40,
      tax_minor: 0,
    });
    const sale = await tx((t) =>
      appendLedgerEntry(t, w.deps, {
        unit_id: o.unit_id,
        capture_id: o.capture_id,
        kind: 'sale',
        amount: { currency: 'USD', minor: 390 },
        refund_id: null,
        ref_entry_id: null,
      }),
    );
    if (!sale.ok) throw new Error('sale not booked');
    await expect(
      tx((t) =>
        bookSaleParts(t, w.deps, {
          unit_id: o.unit_id,
          capture_id: o.capture_id,
          sale_entry_id: sale.value.id,
        }),
      ),
    ).rejects.toThrow(LedgerRuleError);
    expect((await listLedger(w.db, { unit_id: o.unit_id })).map((e) => e.kind)).toEqual(['sale']);
  });
});

describe('refunds', () => {
  it('a full refund reverses the fee and the payable, in one go, and the parts sum to the refund', async () => {
    const u = await sold(360, 40);
    await bookParts(u);
    const s = await refund(u, 'RF1', 400);
    expect(s).toEqual({ fee_minor: 40, payable_minor: 360 });
    const es = await rows(u);
    expect(sum(es, 'refund')).toBe(400);
    expect(sum(es, 'fee_reversal')).toBe(40);
    expect(sum(es, 'payable_reversal')).toBe(360);
    expect(unitSplit(es)).toMatchObject({ fee_reversed_minor: 40, payable_reversed_minor: 360 });
    // the sale is still booked
    expect(sum(es, 'sale')).toBe(400);
    for (const e of es.filter((x) => x.kind === 'fee_reversal' || x.kind === 'payable_reversal')) {
      expect(e.refund_id).toBe('RF1');
    }
  });

  it('partial refunds: each one splits by the running total and all of them end exactly at the fee', async () => {
    const u = await sold(910, 91);
    await bookParts(u);
    const a = await refund(u, 'RF1', 333);
    const b = await refund(u, 'RF2', 333);
    const c = await refund(u, 'RF3', 335);
    expect([a, b, c]).toEqual([
      { fee_minor: 30, payable_minor: 303 },
      { fee_minor: 31, payable_minor: 302 },
      { fee_minor: 30, payable_minor: 305 },
    ]);
    const es = await rows(u);
    expect(sum(es, 'fee_reversal')).toBe(91);
    expect(sum(es, 'payable_reversal')).toBe(910);
    expect(sum(es, 'refund')).toBe(1001);
    // per refund id, the two reversals add up to the refund row
    for (const id of ['RF1', 'RF2', 'RF3']) {
      const mine = es.filter((e) => e.refund_id === id);
      const r = mine.find((e) => e.kind === 'refund')!.amount.minor;
      const parts = mine
        .filter((e) => e.kind === 'fee_reversal' || e.kind === 'payable_reversal')
        .reduce((s, e) => s + e.amount.minor, 0);
      expect(parts).toBe(r);
    }
  });

  it('a refund with no fee part writes no fee reversal row, only the payable reversal', async () => {
    const u = await sold(99, 1);
    await bookParts(u);
    await refund(u, 'RF1', 49);
    const es = await rows(u);
    expect(es.filter((e) => e.kind === 'fee_reversal')).toEqual([]);
    expect(sum(es, 'payable_reversal')).toBe(49);
  });

  it('booking the parts of one refund id twice adds nothing', async () => {
    const u = await sold(360, 40);
    await bookParts(u);
    const split = await refund(u, 'RF1', 100);
    const count = (await rows(u)).length;
    await tx((t) =>
      bookRefundParts(t, w.deps, {
        unit_id: u.unit_id,
        capture_id: u.capture_id,
        refund_id: 'RF1',
        ref_entry_id: u.sale_id,
        split,
      }),
    );
    expect((await rows(u)).length).toBe(count);
  });

  it('the same refund id with other parts is a conflicting replay, never a silent second booking', async () => {
    const u = await sold(360, 40);
    await bookParts(u);
    await refund(u, 'RF1', 100);
    await expect(
      tx((t) =>
        bookRefundParts(t, w.deps, {
          unit_id: u.unit_id,
          capture_id: u.capture_id,
          refund_id: 'RF1',
          ref_entry_id: u.sale_id,
          split: { fee_minor: 1, payable_minor: 99 },
        }),
      ),
    ).rejects.toThrow(LedgerRuleError);
  });

  it('a unit with no fee or payable rows books no parts for a refund', async () => {
    const u = await sold(400, 0, false);
    const out = await tx((t) =>
      bookRefundParts(t, w.deps, {
        unit_id: u.unit_id,
        capture_id: u.capture_id,
        refund_id: 'RF1',
        ref_entry_id: u.sale_id,
        split: { fee_minor: 0, payable_minor: 100 },
      }),
    );
    expect(out).toEqual({ fee_entry_id: null, payable_entry_id: null });
    expect((await rows(u)).map((e) => e.kind)).toEqual(['sale']);
  });
});

describe('the ledger rules of the new kinds', () => {
  const input = (
    u: { unit_id: string; capture_id: string },
    kind: LedgerEntryInput['kind'],
    minor: number,
    refund_id: string | null,
  ): LedgerEntryInput => ({
    unit_id: u.unit_id,
    capture_id: u.capture_id,
    kind,
    amount: { currency: 'USD', minor },
    refund_id,
    ref_entry_id: null,
  });
  const put = (e: LedgerEntryInput) => tx((t) => appendLedgerEntry(t, w.deps, e));

  it('fee and payable carry no refund id; the three reversal kinds must carry one', async () => {
    const u = await sold(360, 40);
    await expect(put(input(u, 'fee', 40, 'RF1'))).rejects.toThrow(/refund_id must be null/);
    await expect(put(input(u, 'payable', 360, 'RF1'))).rejects.toThrow(/refund_id must be null/);
    for (const kind of ['fee_reversal', 'payable_reversal', 'payout_adjustment'] as const) {
      await expect(put(input(u, kind, 10, null))).rejects.toThrow(/refund_id is required/);
    }
  });
  it('a new kind of zero is not a money fact', async () => {
    const u = await sold(360, 40);
    for (const [kind, rid] of [
      ['fee', null],
      ['payable', null],
      ['fee_reversal', 'RF1'],
      ['payable_reversal', 'RF1'],
      ['payout_adjustment', 'RF1'],
    ] as const) {
      await expect(put(input(u, kind, 0, rid))).rejects.toThrow(/not a money fact/);
    }
  });
  it('a reversal above what it reverses is refused before any row is written', async () => {
    const u = await sold(360, 40);
    await bookParts(u);
    await expect(put(input(u, 'fee_reversal', 41, 'RF1'))).rejects.toThrow(/exceed/);
    await expect(put(input(u, 'payable_reversal', 361, 'RF1'))).rejects.toThrow(/exceed/);
    expect((await put(input(u, 'fee_reversal', 40, 'RF1'))).ok).toBe(true);
    await expect(put(input(u, 'fee_reversal', 1, 'RF2'))).rejects.toThrow(/exceed/);
  });
  it('a replay of the same key returns the first row, a replay with another amount is refused', async () => {
    const u = await sold(360, 40);
    const first = await put(input(u, 'fee', 40, null));
    expect(first.ok).toBe(true);
    const again = await put(input(u, 'fee', 40, null));
    expect(again).toMatchObject({ ok: false, error: { code: 'duplicate' } });
    await expect(put(input(u, 'fee', 41, null))).rejects.toThrow(/conflicting_replay/);
  });
  it('a payout adjustment is a ledger row of its own refund id and does not change the old sums', async () => {
    const u = await sold(360, 40);
    await bookParts(u);
    await refund(u, 'RF1', 100);
    const before = unitBalance(await rows(u));
    expect((await put(input(u, 'payout_adjustment', 90, 'RF1'))).ok).toBe(true);
    const es = await rows(u);
    expect(unitBalance(es)).toEqual(before);
    expect(unitSplit(es).adjustment_minor).toBe(90);
  });
});
