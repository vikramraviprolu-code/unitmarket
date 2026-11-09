// COR-IN (docs/specs/db-in-usd-corridor.md): a publisher whose payee country is India can import from a web page.
// The corridor of the batch is in-usd (migration 0033), so a price in USD is kept and staged in USD, and a price in
// another currency (EUR) is not carried over. Same scripted web as the other import tests; no socket is opened.
import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import type { Actor } from '@umsbx/contracts';
import { getBatch, runNextBatch, startVerifiedImport } from './import-stage';
import {
  SOURCE_URL,
  batchRow,
  byKey,
  importWorld,
  itemRows,
  shopPages,
  verifyShop,
} from './import-support';
import type { ImportWorld } from './import-support';

const fixture = (name: string): string =>
  readFileSync(new URL(`../test-data/${name}`, import.meta.url), 'utf8');

const worlds: ImportWorld[] = [];
afterEach(async () => {
  for (const w of worlds.splice(0)) await w.db.close();
});

/** The world of the import tests plus one active publisher in India (fictional). */
async function indiaWorld(): Promise<{ w: ImportWorld; india: Actor }> {
  const w = await importWorld(shopPages(fixture));
  worlds.push(w);
  const T = w.clock.now().toISOString();
  await w.db.query(
    `INSERT INTO publishers (id, slug, display_name, country, status, created_at, updated_at)
     VALUES ('pub_in_1', 'delhi-desk', 'Delhi Desk (fictional)', 'IN', 'active', $1, $1)`,
    [T],
  );
  return { w, india: { kind: 'publisher', publisher_id: 'pub_in_1' } };
}

describe('an India publisher imports a web page (corridor in-usd)', () => {
  it('begins an import: no_corridor is gone', async () => {
    const { w, india } = await indiaWorld();
    await verifyShop(w, india);
    const b = await startVerifiedImport(w.idep(), india, { source_url: SOURCE_URL });
    expect(b.ok).toBe(true);
  });

  it('keeps a USD price and stages it in USD; a EUR price keeps none', async () => {
    const { w, india } = await indiaWorld();
    await verifyShop(w, india);
    const b = await startVerifiedImport(w.idep(), india, { source_url: SOURCE_URL });
    if (!b.ok) throw new Error(`begin refused: ${b.error.code}`);
    const ran = await runNextBatch(w.idep());
    expect(ran).toEqual({ ran: true, batch_id: b.value.batch_id });
    expect(await batchRow(w.db, b.value.batch_id)).toMatchObject({ state: 'done', note: null });

    const rows = await itemRows(w.db, b.value.batch_id);
    // the page lists 1.50 USD and 4.50 USD, and 12 EUR for the knot poster
    expect(byKey(rows, '/a/tides')).toMatchObject({
      state: 'staged',
      price_minor: 150,
      source_price_minor: 150,
      currency: 'USD',
    });
    expect(byKey(rows, '/p/chart')).toMatchObject({
      state: 'staged',
      price_minor: 450,
      currency: 'USD',
    });
    expect(byKey(rows, '/p/knots')).toMatchObject({
      state: 'staged',
      price_minor: null,
      source_price_minor: null,
      currency: 'USD',
    });
    expect(new Set(rows.filter((r) => r.state !== 'refused').map((r) => r.currency))).toEqual(
      new Set(['USD']),
    );
    // the images and text were fetched from the verified host only
    expect(w.web.calls.every((c) => c.allow.length === 1)).toBe(true);
  });

  it('the review view shows the price and the buyer price in USD', async () => {
    const { w, india } = await indiaWorld();
    await verifyShop(w, india);
    const b = await startVerifiedImport(w.idep(), india, { source_url: SOURCE_URL });
    if (!b.ok) throw new Error(`begin refused: ${b.error.code}`);
    await runNextBatch(w.idep());
    const view = await getBatch(w.idep(), india, b.value.batch_id);
    const tides = view!.items.find((i) => i.source_key.endsWith('/a/tides'))!;
    expect(tides).toMatchObject({ price_minor: 150, currency: 'USD', buyer_price_minor: 150 });
  });

  it('a publisher in a country with no corridor still cannot begin: no_corridor', async () => {
    const { w } = await indiaWorld();
    await w.db.query(
      `INSERT INTO publishers (id, slug, display_name, country, status, created_at, updated_at)
       VALUES ('pub_zz_1', 'zz-desk', 'ZZ Desk (fictional)', 'ZZ', 'active', $1, $1)`,
      [w.clock.now().toISOString()],
    );
    const zz: Actor = { kind: 'publisher', publisher_id: 'pub_zz_1' };
    await verifyShop(w, zz);
    expect(await startVerifiedImport(w.idep(), zz, { source_url: SOURCE_URL })).toEqual({
      ok: false,
      error: { code: 'no_corridor' },
    });
  });
});
