// WW-COR (docs/specs/db-ww-corridors.md): the worldwide corridor rows survive the boot seed, the payee sets are
// disjoint per currency, and the guard trigger refuses an overlap. Migration 0034 itself is tested in
// packages/db/src/migration-0034.state.test.ts.
import { afterAll, describe, expect, it } from 'vitest';
import { ISO_3166_1_ALPHA2 } from '@umsbx/contracts';
import { seedCatalogue, seedSupplement, SEED_DATA, SEED_SUPPLEMENT_DE } from './index';
import { fakeClock, seededIds, T0, testDb } from './support';

type Db = Awaited<ReturnType<typeof testDb>>;
const open: Db[] = [];
const fresh = async (): Promise<Db> => {
  const d = await testDb();
  open.push(d);
  return d;
};
afterAll(async () => {
  for (const d of open) await d.close();
});

interface Row {
  id: string;
  currency: string;
  payee_countries: string[];
  buyer_countries: string[];
  domestic_supported: boolean;
  enabled: boolean;
  min_charge_minor: string | number | null;
  minor_units: number;
  created_at: string;
  updated_at: string;
}
const corridors = async (d: Db): Promise<Row[]> =>
  (await d.query<Row>('SELECT * FROM corridors ORDER BY id')).rows.map((r) => ({
    ...r,
    payee_countries: [...r.payee_countries].sort(),
  }));
const boot = async (d: Db, seed: string): Promise<void> => {
  await seedCatalogue(d, fakeClock(T0), seededIds(seed), SEED_DATA);
  await seedSupplement(d, fakeClock(T0), seededIds(`${seed}-de`), SEED_SUPPLEMENT_DE);
};
const ALL_BUT_IN = ISO_3166_1_ALPHA2.filter((c) => c !== 'IN');
const WIDE = ['us-usd', 'gb-gbp', 'de-eur'];

describe('the boot seed never narrows the migration rows (acceptance 2)', () => {
  it('SEED_DATA and the DE supplement carry the wide shape, the same rows 0034 writes', async () => {
    const d = await fresh();
    const mig = await corridors(d);
    for (const c of [...SEED_DATA.corridors, ...SEED_SUPPLEMENT_DE.corridors]) {
      expect(c.enabled, c.id).toBe(true);
      expect(c.buyer_countries, c.id).toEqual(['*']);
      expect([...c.payee_countries].sort(), c.id).toEqual(ALL_BUT_IN);
      const m = mig.find((r) => r.id === c.id)!;
      expect({ ...m, payee_countries: m.payee_countries }, c.id).toMatchObject({
        id: c.id,
        currency: c.currency,
        minor_units: c.minor_units,
        buyer_countries: c.buyer_countries,
        payee_countries: [...c.payee_countries].sort(),
        domestic_supported: c.domestic_supported,
        min_charge_minor: c.min_charge_minor,
        enabled: c.enabled,
      });
    }
  });

  it('fresh migrate then the full boot seed: rows stay wide and on; a second boot changes nothing', async () => {
    const d = await fresh();
    const before = await corridors(d);
    await boot(d, 'boot-1');
    const first = await corridors(d);
    expect(first).toEqual(before);
    for (const id of WIDE) {
      const r = first.find((x) => x.id === id)!;
      expect(r.enabled, id).toBe(true);
      expect(r.payee_countries, id).toEqual(ALL_BUT_IN);
      expect(r.buyer_countries, id).toEqual(['*']);
    }
    await boot(d, 'boot-2');
    expect(await corridors(d)).toEqual(first);
  });

  it('an operator switch-off survives a re-boot (the seed is DO NOTHING)', async () => {
    const d = await fresh();
    await boot(d, 'boot-1');
    await d.query(`UPDATE corridors SET enabled = false WHERE id = 'de-eur'`);
    await boot(d, 'boot-2');
    expect((await corridors(d)).find((r) => r.id === 'de-eur')!.enabled).toBe(false);
  });
});

describe('payee sets are disjoint per currency (acceptance 3)', () => {
  it('no two enabled rows of one currency overlap', async () => {
    const d = await fresh();
    await boot(d, 'boot-1');
    const r = await d.query(
      `SELECT a.id AS a, b.id AS b FROM corridors a JOIN corridors b
         ON a.id < b.id AND a.enabled AND b.enabled AND a.currency = b.currency
        AND a.payee_countries && b.payee_countries`,
    );
    expect(r.rows).toEqual([]);
  });

  it('every ISO code except IN is covered by exactly one enabled row per currency; IN only by in-* rows', async () => {
    const d = await fresh();
    await boot(d, 'boot-1');
    const all = await corridors(d);
    for (const currency of ['USD', 'EUR', 'GBP']) {
      for (const code of ISO_3166_1_ALPHA2) {
        const covering = all
          .filter((r) => r.enabled && r.currency === currency && r.payee_countries.includes(code))
          .map((r) => r.id);
        const expected =
          code === 'IN'
            ? [`in-${currency.toLowerCase()}`]
            : [WIDE.find((id) => all.find((r) => r.id === id)!.currency === currency)!];
        expect(covering, `${currency} ${code}`).toEqual(expected);
      }
    }
    const inRows = all.filter((r) => r.payee_countries.includes('IN')).map((r) => r.id);
    expect(inRows).toEqual(['in-eur', 'in-gbp', 'in-usd']);
    // India sells outside India only; the three worldwide rows sell domestically.
    for (const r of all) expect(r.domestic_supported, r.id).toBe(!r.id.startsWith('in-'));
  });

  it('only USD, EUR and GBP rows exist', async () => {
    const d = await fresh();
    await boot(d, 'boot-1');
    expect([...new Set((await corridors(d)).map((r) => r.currency))].sort()).toEqual([
      'EUR',
      'GBP',
      'USD',
    ]);
  });
});

describe('the guard trigger', () => {
  const insert = (d: Db, id: string, currency: string, payee: string[], enabled: boolean) =>
    d.query(
      `INSERT INTO corridors (id, currency, minor_units, buyer_countries, payee_countries, domestic_supported, min_charge_minor, enabled, created_at, updated_at)
       VALUES ($1, $2, 2, ARRAY['*'], $3, true, NULL, $4, $5, $5)`,
      [id, currency, payee, enabled, T0],
    );

  it('refuses an enabled insert that overlaps another enabled row of the same currency', async () => {
    const d = await fresh();
    await expect(insert(d, 'eu-eur', 'EUR', ['US'], true)).rejects.toThrow(
      /overlaps corridor de-eur/,
    );
    await expect(insert(d, 'xx-usd', 'USD', ['FR', 'IN'], true)).rejects.toThrow(/overlaps/);
    expect((await corridors(d)).map((r) => r.id)).toEqual([
      'de-eur',
      'gb-gbp',
      'in-eur',
      'in-gbp',
      'in-usd',
      'us-usd',
    ]);
  });

  it('refuses an update that widens a row into an overlap, and an update that switches an overlapping row on', async () => {
    const d = await fresh();
    await expect(
      d.query(`UPDATE corridors SET payee_countries = ARRAY['IN','US'] WHERE id = 'us-usd'`),
    ).rejects.toThrow(/overlaps corridor in-usd/);
    await insert(d, 'eu-eur', 'EUR', ['US'], false);
    await expect(
      d.query(`UPDATE corridors SET enabled = true WHERE id = 'eu-eur'`),
    ).rejects.toThrow(/overlaps corridor de-eur/);
  });

  it('allows a disjoint enabled row, an overlapping DISABLED row, and a row of another currency', async () => {
    const d = await fresh();
    await insert(d, 'off-eur', 'EUR', ['US'], false);
    await d.query(`UPDATE corridors SET enabled = false WHERE id = 'de-eur'`);
    await insert(d, 'us-eur', 'EUR', ['US'], true);
    expect((await corridors(d)).find((r) => r.id === 'us-eur')!.enabled).toBe(true);
  });

  it('allows two rows to swap payee sets in one statement, and in one transaction when the constraint is deferred', async () => {
    const d = await fresh();
    await d.query(`UPDATE corridors SET payee_countries = ARRAY['DE'] WHERE id = 'de-eur'`);
    await insert(d, 'fr-eur', 'EUR', ['FR'], true);
    await d.query(
      `UPDATE corridors SET payee_countries = CASE id WHEN 'de-eur' THEN ARRAY['FR'] ELSE ARRAY['DE'] END WHERE id IN ('de-eur', 'fr-eur')`,
    );
    let all = await corridors(d);
    expect(all.find((r) => r.id === 'de-eur')!.payee_countries).toEqual(['FR']);
    expect(all.find((r) => r.id === 'fr-eur')!.payee_countries).toEqual(['DE']);
    // Two statements: the first leaves an overlap that the second clears, so the check must wait for commit.
    await d.transaction(async (tx) => {
      await tx.query('SET CONSTRAINTS corridors_payee_disjoint DEFERRED');
      await tx.query(`UPDATE corridors SET payee_countries = ARRAY['DE'] WHERE id = 'de-eur'`);
      await tx.query(`UPDATE corridors SET payee_countries = ARRAY['FR'] WHERE id = 'fr-eur'`);
    });
    all = await corridors(d);
    expect(all.find((r) => r.id === 'de-eur')!.payee_countries).toEqual(['DE']);
    expect(all.find((r) => r.id === 'fr-eur')!.payee_countries).toEqual(['FR']);
    // A deferred overlap that is still there at commit is refused.
    await expect(
      d.transaction(async (tx) => {
        await tx.query('SET CONSTRAINTS corridors_payee_disjoint DEFERRED');
        await tx.query(`UPDATE corridors SET payee_countries = ARRAY['DE'] WHERE id = 'fr-eur'`);
      }),
    ).rejects.toThrow(/overlaps/);
  });
});
