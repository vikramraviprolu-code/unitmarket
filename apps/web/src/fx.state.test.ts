// MC2-L4 (D-085): engine.fx over the real engine (offline, PGlite, seeded). The seed rates are there; the
// default fetch in offline mode is a fake that answers `offline` and keeps them; a test fetch can store a
// new date; convert is the pure function. Nothing here opens a socket.
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createApp } from '../composition.server';
import type { App } from '../composition.server';
import { testEnv } from './support';

vi.mock('server-only', () => ({}));

let calls = 0;
// The real clock drives the app and a fetched date after tomorrow is refused, so the test date is today (UTC),
// read from the database (no Date.now or new Date() here).
let TODAY = '';
let answer = { ok: true as const, date: '', usd: '1.2000', gbp: '0.8800' };
let withFake: App;
let offline: App;
let broken: App;
beforeAll(async () => {
  withFake = createApp(await testEnv(), {
    switch_cache_ms: 0,
    test_fx_fetch: async () => {
      calls++;
      return answer;
    },
  });
  await withFake.ready();
  TODAY = (
    await withFake.db.query<{ d: string }>(
      "SELECT to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS d",
    )
  ).rows[0]!.d;
  answer = { ...answer, date: TODAY };
  offline = createApp(await testEnv(), { switch_cache_ms: 0 });
  await offline.ready();
  broken = createApp(await testEnv(), { switch_cache_ms: 0 });
  await broken.ready();
});
afterAll(async () => {
  await withFake.close();
  await offline.close();
  await broken.close();
});

describe('engine.fx', () => {
  it('has the seed rates on a fresh database, marked seed, with a date', async () => {
    const r = await offline.engine.fx.getRates();
    expect(r).toMatchObject({
      date: '2026-11-03',
      eur_usd: '1.15',
      eur_gbp: '0.87',
      source: 'seed',
    });
  });

  it('in offline mode the fetch is a fake that fails with `offline` and keeps the stored rates', async () => {
    const r = await offline.engine.fx.refreshIfStale();
    expect(r).toEqual({ status: 'failed', kind: 'offline' });
    expect((await offline.engine.fx.getRates())!.date).toBe('2026-11-03');
  });

  it('a test fetch is called once, its date is stored, and the next call is fresh', async () => {
    expect(await withFake.engine.fx.refreshIfStale()).toEqual({
      status: 'refreshed',
      date: TODAY,
    });
    expect(calls).toBe(1);
    expect(await withFake.engine.fx.getRates()).toMatchObject({
      date: TODAY,
      eur_usd: '1.2',
      eur_gbp: '0.88',
      source: 'ecb',
    });
    expect((await withFake.engine.fx.refreshIfStale()).status).toBe('fresh');
    expect(calls).toBe(1);
  });

  it('convert is the pure function: about, with the rate date; `at` defaults to now', async () => {
    const rates = await withFake.engine.fx.getRates();
    expect(
      withFake.engine.fx.convert({
        minor: 1000,
        from: 'EUR',
        to: 'USD',
        rates,
        at: new Date(`${TODAY}T12:00:00Z`),
      }),
    ).toEqual({ minor: 1200, rate_date: TODAY, rate: 1.2, approx: true, source: 'ecb' });
    // The default `at` is the clock now.
    expect(withFake.engine.fx.convert({ minor: 1000, from: 'EUR', to: 'USD', rates })!.minor).toBe(
      1200,
    );
    expect(
      withFake.engine.fx.convert({ minor: 1000, from: 'GBP', to: 'GBP', rates: null })!.approx,
    ).toBe(false);
  });

  it('convert on the seed rates says source seed', async () => {
    const rates = await offline.engine.fx.getRates();
    expect(
      offline.engine.fx.convert({
        minor: 1000,
        from: 'EUR',
        to: 'USD',
        rates,
        at: new Date('2026-11-05T00:00:00Z'),
      }),
    ).toEqual({ minor: 1150, rate_date: '2026-11-03', rate: 1.15, approx: true, source: 'seed' });
  });

  it('getRates answers null, and does not throw, when the database query fails', async () => {
    await broken.db.exec('DROP TABLE fx_rates');
    await expect(broken.engine.fx.getRates()).resolves.toBeNull();
  });
});
