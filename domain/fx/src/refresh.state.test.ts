import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { getRates, refreshIfStale } from './index';
import type { FetchedRates } from './index';
import { SEED, fxWorld } from './support';
import type { FxWorld } from './support';

// MC2-L4 (D-085). refreshIfStale: fetch only when the newest fetched_at is over 6 hours old, once under a
// lock, never throw, keep the old rate on any failure, reject a move over 10% and a date older than stored.
// The fetch is always a fake: no network.
const worlds: FxWorld[] = [];
afterAll(async () => {
  for (const w of worlds) await w.db.close();
});
let w: FxWorld;
beforeEach(async () => {
  w = await fxWorld('2026-11-04T09:00:00Z'); // 17 h after the seed fetch: stale
  worlds.push(w);
});

const ok = (date: string, usd: string, gbp: string): FetchedRates => ({ ok: true, date, usd, gbp });
const NEW = ok('2026-11-04', '1.1612', '0.8731');
const rowCount = async (): Promise<number> =>
  Number(
    (await w.db.query<{ c: string | number }>('SELECT count(*) AS c FROM fx_rates')).rows[0]!.c,
  );
const run = (fetchRates: () => Promise<FetchedRates>) =>
  refreshIfStale({ db: w.db, clock: w.clock, fetchRates });

describe('freshness', () => {
  it('a rate fetched less than 6 hours ago does not call fetch', async () => {
    w.clock.set('2026-11-03T21:59:59Z');
    const fetchRates = vi.fn(async () => NEW);
    const r = await run(fetchRates);
    expect(r.status).toBe('fresh');
    expect(fetchRates).not.toHaveBeenCalled();
    expect(await rowCount()).toBe(2);
  });
  it('exactly 6 hours is still fresh; one millisecond more is stale', async () => {
    const fetchRates = vi.fn(async () => NEW);
    w.clock.set('2026-11-03T22:00:00Z');
    expect((await run(fetchRates)).status).toBe('fresh');
    expect(fetchRates).not.toHaveBeenCalled();
    w.clock.set('2026-11-03T22:00:00.001Z');
    expect((await run(fetchRates)).status).toBe('refreshed');
    expect(fetchRates).toHaveBeenCalledTimes(1);
  });
  it('a stale rate is fetched once and stored as ecb rows with the fetch time from the clock', async () => {
    const fetchRates = vi.fn(async () => NEW);
    const r = await run(fetchRates);
    expect(r).toEqual({ status: 'refreshed', date: '2026-11-04' });
    expect(fetchRates).toHaveBeenCalledTimes(1);
    expect(await rowCount()).toBe(4);
    expect(await getRates(w.db, w.clock)).toMatchObject({
      date: '2026-11-04',
      eur_usd: '1.1612',
      eur_gbp: '0.8731',
      source: 'ecb',
      fetched_at: '2026-11-04T09:00:00.000Z',
      age_ms: 0,
    });
    // The seed rows are still there.
    const seed = await w.db.query(`SELECT 1 FROM fx_rates WHERE source = 'seed'`);
    expect(seed.rows).toHaveLength(2);
  });
  it('right after a refresh the next call is fresh and does not fetch', async () => {
    const fetchRates = vi.fn(async () => NEW);
    await run(fetchRates);
    w.clock.advance(3600_000);
    expect((await run(fetchRates)).status).toBe('fresh');
    expect(fetchRates).toHaveBeenCalledTimes(1);
  });
});

describe('concurrency', () => {
  it('five callers on a stale rate make one fetch: one refreshed, four fresh', async () => {
    let calls = 0;
    const fetchRates = async (): Promise<FetchedRates> => {
      calls++;
      await new Promise((r) => setTimeout(r, 25));
      return NEW;
    };
    const out = await Promise.all([1, 2, 3, 4, 5].map(() => run(fetchRates)));
    expect(calls).toBe(1);
    expect(out.map((o) => o.status).sort()).toEqual([
      'fresh',
      'fresh',
      'fresh',
      'fresh',
      'refreshed',
    ]);
    expect(await rowCount()).toBe(4);
  });
  it('five callers on a stale rate with a failing fetch make one fetch and none throws', async () => {
    const fetchRates = vi.fn(async (): Promise<FetchedRates> => {
      await new Promise((r) => setTimeout(r, 25));
      return { ok: false, kind: 'timeout' };
    });
    const out = await Promise.all([1, 2, 3, 4, 5].map(() => run(fetchRates)));
    expect(fetchRates).toHaveBeenCalledTimes(1);
    expect(out.filter((o) => o.status === 'failed')).toEqual([
      { status: 'failed', kind: 'timeout' },
    ]);
    expect(
      out
        .filter((o) => o.status === 'kept')
        .every((o) => o.status === 'kept' && o.reason === 'recent_attempt'),
    ).toBe(true);
    expect(await rowCount()).toBe(2);
  });
});

describe('failure keeps the old rate', () => {
  it('a failed fetch answers failed with the fixed kind, stores nothing and does not throw', async () => {
    const before = await getRates(w.db, w.clock);
    const r = await run(async () => ({ ok: false, kind: 'network' }));
    expect(r).toEqual({ status: 'failed', kind: 'network' });
    expect(await getRates(w.db, w.clock)).toEqual(before);
    expect(await rowCount()).toBe(2);
  });
  it('a fetch that throws or rejects is a failure, never an exception', async () => {
    const a = await run(async () => {
      throw new Error('PEER-TEXT');
    });
    expect(a).toEqual({ status: 'failed', kind: 'unexpected' });
    expect(JSON.stringify(a)).not.toContain('PEER-TEXT');
  });
  it('a fetch that answers a bad shape is a failure and stores nothing', async () => {
    for (const bad of [
      ok('2026-11-04', '0', '0.87'),
      ok('2026-11-04', '1.16', '-1'),
      ok('2026-11-04', 'NaN', '0.87'),
      ok('2026-02-30', '1.16', '0.87'),
      ok('yesterday', '1.16', '0.87'),
      { ok: true, date: '2026-11-04', usd: 1.16, gbp: 0.87 } as never,
      null as never,
    ]) {
      w.clock.advance(20 * 60_000);
      expect((await run(async () => bad)).status, JSON.stringify(bad)).toBe('failed');
    }
    expect(await rowCount()).toBe(2);
  });
  it('after a failure the next call within 15 minutes does not fetch again; after that it does', async () => {
    const fetchRates = vi.fn(async (): Promise<FetchedRates> => ({ ok: false, kind: 'timeout' }));
    expect((await run(fetchRates)).status).toBe('failed');
    w.clock.advance(60_000);
    expect(await run(fetchRates)).toMatchObject({ status: 'kept', reason: 'recent_attempt' });
    expect(fetchRates).toHaveBeenCalledTimes(1);
    w.clock.advance(15 * 60_000);
    expect((await run(fetchRates)).status).toBe('failed');
    expect(fetchRates).toHaveBeenCalledTimes(2);
  });
});

/**
 * A world whose newest stored rates are an 'ecb' row (not the seed): the 10% guard compares against real
 * rates only. The base row carries the seed's numbers, so the old percentages still apply.
 */
async function ecbWorld(startIso: string, baseDate: string): Promise<FxWorld> {
  const w2 = await fxWorld(startIso);
  worlds.push(w2);
  const fetched = `${baseDate}T01:00:00Z`;
  for (const [quote, rate] of [
    ['USD', String(SEED.usd)],
    ['GBP', String(SEED.gbp)],
  ] as const)
    await w2.db.query(
      `INSERT INTO fx_rates (date, base, quote, rate, source, fetched_at) VALUES ($1, 'EUR', $2, $3, 'ecb', $4)`,
      [baseDate, quote, rate, fetched],
    );
  return w2;
}
const refreshOn = (w2: FxWorld, fetched: FetchedRates) =>
  refreshIfStale({ db: w2.db, clock: w2.clock, fetchRates: async () => fetched });
const count = async (w2: FxWorld): Promise<number> =>
  Number(
    (await w2.db.query<{ c: string | number }>('SELECT count(*) AS c FROM fx_rates')).rows[0]!.c,
  );

describe('the guards', () => {
  const stored = () => ({ usd: SEED.usd, gbp: SEED.gbp });
  const scaled = (x: number, f: number): string => (x * f).toFixed(4);
  const START = '2026-11-04T09:00:00Z'; // 8 h after the ecb base row below: stale

  it('a rate that moves 11% from the stored ecb one is rejected and the stored one is kept', async () => {
    for (const f of [1.11, 0.89]) {
      const w2 = await ecbWorld(START, '2026-11-04');
      const r = await refreshOn(w2, ok('2026-11-05', scaled(stored().usd, f), '0.87'));
      expect(r, String(f)).toMatchObject({ status: 'kept', reason: 'rejected_move' });
      expect((await getRates(w2.db, w2.clock))!.date).toBe('2026-11-04');
      expect(await count(w2)).toBe(4);
    }
  });
  it('the GBP move is checked too, and one bad quote rejects the pair', async () => {
    const w2 = await ecbWorld(START, '2026-11-04');
    const r = await refreshOn(w2, ok('2026-11-05', '1.16', scaled(stored().gbp, 1.11)));
    expect(r).toMatchObject({ status: 'kept', reason: 'rejected_move' });
    expect(await count(w2)).toBe(4);
  });
  it('9% is accepted, and exactly 10% is accepted (only more than 10% is rejected)', async () => {
    const w1 = await ecbWorld(START, '2026-11-04');
    const r9 = await refreshOn(
      w1,
      ok('2026-11-05', scaled(stored().usd, 1.09), scaled(stored().gbp, 0.91)),
    );
    expect(r9.status).toBe('refreshed');
    const w2 = await ecbWorld(START, '2026-11-04');
    expect((await refreshOn(w2, ok('2026-11-05', '1.265', '0.957'))).status).toBe('refreshed');
  });
  it('the move is measured against the newest stored ecb date', async () => {
    // The first fetch has the seed as its base and is not guarded; then +8.7% is accepted although it is
    // +19% on the seed, and +11% on that is rejected.
    expect((await run(async () => ok('2026-11-04', '1.2600', '0.9000'))).status).toBe('refreshed');
    w.clock.advance(24 * 3600_000);
    expect((await run(async () => ok('2026-11-05', '1.3700', '0.9000'))).status).toBe('refreshed');
    w.clock.advance(24 * 3600_000);
    const r = await run(async () => ok('2026-11-06', '1.5200', '0.9000')); // +11% on 1.37
    expect(r).toMatchObject({ status: 'kept', reason: 'rejected_move' });
  });
  it('a stored seed row does not guard: +30% on the seed is accepted and stored as ecb', async () => {
    const r = await run(async () => ok('2026-11-04', scaled(SEED.usd, 1.3), scaled(SEED.gbp, 1.3)));
    expect(r).toEqual({ status: 'refreshed', date: '2026-11-04' });
    expect(await getRates(w.db, w.clock)).toMatchObject({ source: 'ecb', eur_usd: '1.495' });
  });
  it('an ecb base within 7 days still rejects +11%, even 7 days apart', async () => {
    const w2 = await ecbWorld('2026-11-14T09:00:00Z', '2026-11-04');
    const r = await refreshOn(w2, ok('2026-11-11', scaled(SEED.usd, 1.11), '0.87'));
    expect(r).toMatchObject({ status: 'kept', reason: 'rejected_move' });
    expect(await count(w2)).toBe(4);
  });
  it('an ecb base more than 7 days old accepts +30% (8 days apart); 7 days apart does not', async () => {
    const w7 = await ecbWorld('2026-11-14T09:00:00Z', '2026-11-04');
    expect(
      await refreshOn(w7, ok('2026-11-11', scaled(SEED.usd, 1.3), scaled(SEED.gbp, 1.3))),
    ).toMatchObject({ status: 'kept', reason: 'rejected_move' });
    const w8 = await ecbWorld('2026-11-14T09:00:00Z', '2026-11-04');
    expect(
      await refreshOn(w8, ok('2026-11-12', scaled(SEED.usd, 1.3), scaled(SEED.gbp, 1.3))),
    ).toEqual({ status: 'refreshed', date: '2026-11-12' });
    expect(await count(w8)).toBe(6);
  });
  it('a fetched date after clock day + 1 is invalid and nothing is stored', async () => {
    for (const date of ['2099-01-01', '2026-11-06']) {
      // clock day is 2026-11-04, so 2026-11-06 is clock + 2 days
      const w2 = await fxWorld(START);
      worlds.push(w2);
      expect(await refreshOn(w2, ok(date, '1.16', '0.87')), date).toEqual({
        status: 'failed',
        kind: 'invalid',
      });
      expect(await count(w2)).toBe(2);
    }
    const w3 = await fxWorld(START);
    worlds.push(w3);
    // tomorrow (UTC) is allowed: the ECB date can be ahead of a clock in an earlier time zone
    expect((await refreshOn(w3, ok('2026-11-05', '1.16', '0.87'))).status).toBe('refreshed');
  });
  it('a date older than the newest stored date is rejected and nothing is stored', async () => {
    const r = await run(async () => ok('2026-11-02', '1.15', '0.87'));
    expect(r).toMatchObject({ status: 'kept', reason: 'older_date' });
    expect(await rowCount()).toBe(2);
  });
  it('the same date as the newest stored one adds no row and says same_date', async () => {
    const r = await run(async () => ok(SEED.date, '1.16', '0.88'));
    expect(r).toMatchObject({ status: 'kept', reason: 'same_date' });
    expect(await rowCount()).toBe(2);
    expect((await getRates(w.db, w.clock))!.eur_usd).toBe('1.15');
  });
});
