// COR-IN (docs/specs/db-in-usd-corridor.md): corridorFor with the India USD corridor of migration 0033.
// A USD offer of an India payee finds in-usd for a buyer anywhere and for a buyer whose country is not known; a USD
// offer of a US payee still finds us-usd; a payee country with no corridor finds none.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { corridorFor, getCorridor } from './index';
import { testDb } from './support';

let db: Awaited<ReturnType<typeof testDb>>;
beforeAll(async () => {
  db = await testDb();
});
afterAll(async () => {
  await db.close();
});

describe('corridorFor with in-usd', () => {
  it.each([
    ['US', 'a US buyer'],
    ['GB', 'a GB buyer'],
    [null, 'a buyer whose country is not known'],
  ] as const)('USD, payee IN, %s (%s) is in-usd', async (buyer_country) => {
    const c = await corridorFor(db, { currency: 'USD', payee_country: 'IN', buyer_country });
    expect(c).toEqual({
      id: 'in-usd',
      currency: 'USD',
      minor_units: 2,
      buyer_countries: ['*'],
      payee_countries: ['IN'],
      domestic_supported: false,
      min_charge_minor: null,
      enabled: true,
    });
  });

  it('USD, payee US is still us-usd, for a US buyer and for an unknown buyer', async () => {
    for (const buyer_country of ['US', null])
      expect(
        (await corridorFor(db, { currency: 'USD', payee_country: 'US', buyer_country }))?.id,
      ).toBe('us-usd');
  });

  it('the India corridor is for USD only: EUR and GBP with payee IN find none', async () => {
    for (const currency of ['EUR', 'GBP'] as const)
      expect(
        await corridorFor(db, { currency, payee_country: 'IN', buyer_country: 'US' }),
      ).toBeNull();
  });

  it('a payee country with no corridor still finds none', async () => {
    expect(
      await corridorFor(db, { currency: 'USD', payee_country: 'ZZ', buyer_country: 'US' }),
    ).toBeNull();
  });

  it('getCorridor reads in-usd by id and it is enabled', async () => {
    expect((await getCorridor(db, 'in-usd'))?.enabled).toBe(true);
  });
});
