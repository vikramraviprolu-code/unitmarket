// INT-TR1 / TR1.6: the daily seal. The first pass at or after 00:05 UTC seals the previous UTC day once; a
// second pass the same day does nothing; a seal chains to the one before; a row committed after the seal
// lands in the next one and verify stays ok.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { verifyTrace } from '@umsbx/db';
import { sealPreviousDay } from './index';
import { CTX, as, freshDb, seedWorld, ins, HASH } from './test-support';
import type { Db } from './test-support';

let db: Db;
const clockAt = (iso: string) => ({ now: () => new Date(iso) });
const seals = async () =>
  (
    await db.query<{
      day: string;
      root_hash: string;
      prev_root_hash: string;
      heads: { chain_key: string; seq: number }[];
    }>(
      `SELECT to_char(day, 'YYYY-MM-DD') AS day, root_hash, prev_root_hash, heads FROM trace_seals ORDER BY id`,
    )
  ).rows;

beforeAll(async () => {
  db = await freshDb();
  await seedWorld(db);
}, 60_000);
afterAll(async () => {
  await db.close();
});

describe('sealPreviousDay', () => {
  it('does nothing before 00:05 UTC', async () => {
    expect(await sealPreviousDay(db, clockAt('2026-11-05T00:04:59Z'))).toEqual({
      sealed: false,
      day: null,
    });
    expect(await seals()).toEqual([]);
  });
  it('seals the previous UTC day on the first pass at or after 00:05, and only once', async () => {
    expect(await sealPreviousDay(db, clockAt('2026-11-05T00:05:00Z'))).toEqual({
      sealed: true,
      day: '2026-11-04',
    });
    expect(await sealPreviousDay(db, clockAt('2026-11-05T00:05:30Z'))).toEqual({
      sealed: false,
      day: null,
    });
    expect(await sealPreviousDay(db, clockAt('2026-11-05T13:00:00Z'))).toEqual({
      sealed: false,
      day: null,
    });
    const s = await seals();
    expect(s.length).toBe(1);
    expect(s[0]!.day).toBe('2026-11-04');
    expect(s[0]!.prev_root_hash).toBe('0'.repeat(64));
    expect(s[0]!.heads.some((h) => h.chain_key === 'ord:ord_1')).toBe(true);
    expect((await verifyTrace(db)).findings).toEqual([]);
  });
  it('a late row lands in the next seal, which chains to the first, and verify stays ok', async () => {
    const late = as(db, CTX.job('pass'), '2026-11-04T09:30:00Z');
    await ins(
      late,
      'ledger_entries',
      {
        id: 'led_late',
        unit_id: 'unt_a',
        capture_id: 'CAPA',
        kind: 'paypal_fee',
        amount_minor: 5,
        currency: 'USD',
        refund_id: null,
        ref_entry_id: null,
        environment: 'dryrun',
      },
      '2026-11-04T09:30:00Z',
    );
    expect((await verifyTrace(db)).findings).toEqual([]);
    expect(await sealPreviousDay(db, clockAt('2026-11-06T00:06:00Z'))).toEqual({
      sealed: true,
      day: '2026-11-05',
    });
    const s = await seals();
    expect(s.length).toBe(2);
    expect(s[1]!.prev_root_hash).toBe(s[0]!.root_hash);
    const head = (h: { chain_key: string; seq: number }[]) =>
      h.find((x) => x.chain_key === 'ord:ord_1')!.seq;
    expect(head(s[1]!.heads)).toBeGreaterThan(head(s[0]!.heads));
    expect((await verifyTrace(db)).findings).toEqual([]);
    void HASH;
  });
  it('uses the clock only: the same instant gives the same day on any host', async () => {
    expect(await sealPreviousDay(db, clockAt('2026-11-06T23:59:59Z'))).toEqual({
      sealed: false,
      day: null,
    });
    expect(await sealPreviousDay(db, clockAt('2026-11-07T00:05:00Z'))).toEqual({
      sealed: true,
      day: '2026-11-06',
    });
  });
});
