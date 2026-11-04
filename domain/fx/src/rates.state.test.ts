import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getRates } from './index';
import { SEED, fxWorld } from './support';
import type { FxWorld } from './support';

// MC2-L4. getRates reads the newest date that has both quotes, with its fetch time and age.
let w: FxWorld;
beforeAll(async () => {
  w = await fxWorld('2026-11-04T09:00:00Z');
});
afterAll(async () => {
  await w.db.close();
});

describe('getRates', () => {
  it('on a fresh database returns the seed set, marked seed, with its age', async () => {
    const r = await getRates(w.db, w.clock);
    expect(r).toEqual({
      date: SEED.date,
      eur_usd: '1.15',
      eur_gbp: '0.87',
      fetched_at: SEED.fetched_at,
      age_ms: Date.parse('2026-11-04T09:00:00Z') - Date.parse(SEED.fetched_at),
      source: 'seed',
    });
  });
  it('age follows the injected clock', async () => {
    w.clock.advance(3600_000);
    expect((await getRates(w.db, w.clock))!.age_ms).toBe(
      Date.parse('2026-11-04T10:00:00Z') - Date.parse(SEED.fetched_at),
    );
  });
  it('a newer date with only one quote is ignored until both quotes are there', async () => {
    const ins = (quote: string, rate: string) =>
      w.db.query(
        `INSERT INTO fx_rates (date, base, quote, rate, source, fetched_at) VALUES ('2026-11-04', 'EUR', $1, $2, 'ecb', $3)`,
        [quote, rate, '2026-11-04T09:30:00Z'],
      );
    await ins('USD', '1.1612');
    expect((await getRates(w.db, w.clock))!.date).toBe(SEED.date);
    await ins('GBP', '0.8731');
    expect(await getRates(w.db, w.clock)).toMatchObject({
      date: '2026-11-04',
      eur_usd: '1.1612',
      eur_gbp: '0.8731',
      source: 'ecb',
      fetched_at: '2026-11-04T09:30:00.000Z',
    });
  });
});
