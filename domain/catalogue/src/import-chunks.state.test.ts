// POB-Q2 (owner decision 10 Nov 2026: auto-continue in chunks of 100). One address may list up to
// MAX_SOURCE_ITEMS items. A batch stages at most MAX_BATCH_ITEMS NEW items (items this publisher already has are
// skipped, never fetched again); when more new items remain, the batch ends 'done' with the note 'continues' and
// queues the next batch for the same address in the same transaction. A batch stopped by the deadline after it
// staged at least one item queues the next batch too. A source over MAX_SOURCE_ITEMS still stages nothing.
// A source of 100 items or fewer behaves exactly as before (import-stage.state.test.ts).
import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import {
  BATCH_DEADLINE_MS,
  MAX_BATCH_ITEMS,
  MAX_SOURCE_ITEMS,
  getBatch,
  runNextBatch,
  startVerifiedImport,
} from './import-stage';
import { setPriceForAll } from './import-quick';
import {
  SHOP,
  auditRows,
  batchRow,
  countOf,
  importWorld,
  itemRows,
  shopPages,
  verifyShop,
} from './import-support';
import type { ImportWorld } from './import-support';

const fixture = (name: string): string =>
  readFileSync(new URL(`../test-data/${name}`, import.meta.url), 'utf8');

const worlds: ImportWorld[] = [];
const fresh = async (): Promise<ImportWorld> => {
  const w = await importWorld(shopPages(fixture));
  worlds.push(w);
  return w;
};
afterEach(async () => {
  for (const w of worlds.splice(0)) await w.db.close();
});

/** A JSON feed of n text items (no fetch per item). */
function feed(w: ImportWorld, n: number, path = '/big.json'): string {
  const items = Array.from({ length: n }, (_, i) => ({
    id: `i${i}`,
    title: `T${i}`,
    content_text: `text ${i}`,
  }));
  w.web.pages[`${SHOP}${path}`] = {
    content_type: 'application/feed+json',
    body: JSON.stringify({ items }),
  };
  return `${SHOP}${path}`;
}

async function begin(w: ImportWorld, url: string): Promise<string> {
  await verifyShop(w);
  const b = await startVerifiedImport(w.idep(), w.harbour, { source_url: url });
  if (!b.ok) throw new Error(`begin refused: ${b.error.code}`);
  return b.value.batch_id;
}

const batchIds = async (
  w: ImportWorld,
): Promise<{ id: string; state: string; note: string | null }[]> =>
  (
    await w.db.query<{ id: string; state: string; note: string | null }>(
      'SELECT id, state, note FROM import_batches ORDER BY created_at, id',
    )
  ).rows;

describe('chunks of 100 from one address', () => {
  it('MAX_BATCH_ITEMS is 100 and MAX_SOURCE_ITEMS is 1000', () => {
    expect(MAX_BATCH_ITEMS).toBe(100);
    expect(MAX_SOURCE_ITEMS).toBe(1000);
  });

  it('250 items: three batches of 100, 100 and 50, each queued by the one before', async () => {
    const w = await fresh();
    const url = feed(w, 250);
    const first = await begin(w, url);
    expect(await runNextBatch(w.idep())).toEqual({ ran: true, batch_id: first });
    expect(await batchRow(w.db, first)).toMatchObject({
      state: 'done',
      note: 'continues',
      total: 100,
      done: 100,
    });
    let all = await batchIds(w);
    expect(all.map((b) => b.state)).toEqual(['done', 'queued']);
    const second = all[1]!.id;
    await runNextBatch(w.idep());
    expect(await batchRow(w.db, second)).toMatchObject({
      state: 'done',
      note: 'continues',
      total: 100,
    });
    await runNextBatch(w.idep());
    all = await batchIds(w);
    expect(all).toHaveLength(3);
    expect(await batchRow(w.db, all[2]!.id)).toMatchObject({
      state: 'done',
      note: null,
      total: 50,
    });
    expect(await runNextBatch(w.idep())).toEqual({ ran: false, batch_id: null });
    expect(
      await countOf(w.db, "SELECT count(*) AS c FROM import_items WHERE state = 'staged'"),
    ).toBe(250);
    // every item once: the second and third batch never stage an item again
    expect(await countOf(w.db, 'SELECT count(DISTINCT source_key) AS c FROM import_items')).toBe(
      250,
    );
    expect((await itemRows(w.db, second)).length).toBe(100);
    const cont = await auditRows(w.db, 'import.continued');
    expect(cont).toHaveLength(2);
    expect(cont[0]!.detail).toMatchObject({ from: first, staged: 100 });
  });

  it('exactly 1000 items are accepted; 1001 stage nothing (too_many_items)', async () => {
    const w = await fresh();
    const ok = feed(w, MAX_SOURCE_ITEMS, '/thousand.json');
    const id = await begin(w, ok);
    await runNextBatch(w.idep());
    expect(await batchRow(w.db, id)).toMatchObject({
      state: 'done',
      note: 'continues',
      total: 100,
    });

    const w2 = await fresh();
    const big = feed(w2, MAX_SOURCE_ITEMS + 1, '/too-big.json');
    const id2 = await begin(w2, big);
    await runNextBatch(w2.idep());
    expect(await batchRow(w2.db, id2)).toMatchObject({
      state: 'done',
      note: 'too_many_items',
      total: 0,
    });
    expect(await countOf(w2.db, 'SELECT count(*) AS c FROM import_items')).toBe(0);
    expect(
      await countOf(w2.db, "SELECT count(*) AS c FROM import_batches WHERE state = 'queued'"),
    ).toBe(0);
  });

  it('a chunk stopped by the deadline after staging items queues the next batch, which goes on', async () => {
    const w = await fresh();
    // 150 links, each page fetched: the deadline can fall in the middle.
    const locs = Array.from({ length: 150 }, (_, i) => `<url><loc>${SHOP}/a/n${i}</loc></url>`);
    w.web.pages[`${SHOP}/big-sitemap.xml`] = {
      content_type: 'application/xml',
      body: `<?xml version="1.0"?><urlset>${locs.join('')}</urlset>`,
    };
    for (let i = 0; i < 150; i += 1)
      w.web.pages[`${SHOP}/a/n${i}`] = {
        body: `<html><head><script type="application/ld+json">${JSON.stringify({
          '@type': 'Article',
          '@id': `${SHOP}/a/n${i}`,
          headline: `N${i}`,
          articleBody: `body ${i}`,
        })}</script></head><body></body></html>`,
      };
    const first = await begin(w, `${SHOP}/big-sitemap.xml`);
    w.web.calls.length = 0;
    w.web.hook = (n) => {
      if (n === 11) w.clock.advance(BATCH_DEADLINE_MS + 1);
    };
    await runNextBatch(w.idep());
    w.web.hook = null;
    expect(await batchRow(w.db, first)).toMatchObject({ state: 'interrupted', note: 'deadline' });
    const staged1 = (await itemRows(w.db, first)).length;
    expect(staged1).toBeGreaterThan(0);
    const all = await batchIds(w);
    expect(all.map((b) => b.state)).toEqual(['interrupted', 'queued']);
    for (let k = 0; k < 5; k += 1) await runNextBatch(w.idep());
    expect(await countOf(w.db, 'SELECT count(DISTINCT source_key) AS c FROM import_items')).toBe(
      150,
    );
  });

  it('a deadline before any item is staged does not queue a next batch (no endless chain)', async () => {
    const w = await fresh();
    const locs = Array.from({ length: 120 }, (_, i) => `<url><loc>${SHOP}/a/m${i}</loc></url>`);
    w.web.pages[`${SHOP}/s2.xml`] = {
      content_type: 'application/xml',
      body: `<?xml version="1.0"?><urlset>${locs.join('')}</urlset>`,
    };
    const first = await begin(w, `${SHOP}/s2.xml`);
    w.web.calls.length = 0;
    w.web.hook = (n) => {
      if (n === 1) w.clock.advance(BATCH_DEADLINE_MS + 1);
    };
    await runNextBatch(w.idep());
    expect(await batchRow(w.db, first)).toMatchObject({ state: 'interrupted', note: 'deadline' });
    expect(
      await countOf(w.db, "SELECT count(*) AS c FROM import_batches WHERE state = 'queued'"),
    ).toBe(0);
  });

  it('the review lists every batch of the same address, and one price covers them all', async () => {
    const w = await fresh();
    const url = feed(w, 230);
    const first = await begin(w, url);
    for (let k = 0; k < 3; k += 1) await runNextBatch(w.idep());
    const v = await getBatch(w.idep(), w.harbour, first);
    expect(v?.source_batches).toHaveLength(3);
    expect(v?.source_batches[0]).toBe(first);
    const r = await setPriceForAll(w.idep(), w.harbour, {
      batch_id: first,
      price_minor: 10,
      all_from_source: true,
    });
    expect(r).toEqual({ ok: true, value: { priced: 230 } });
    expect(
      await countOf(w.db, 'SELECT count(*) AS c FROM import_items WHERE price_minor = 10'),
    ).toBe(230);
  });

  it('one price for the whole address waits while a batch of that address is still queued', async () => {
    const w = await fresh();
    const url = feed(w, 150);
    const first = await begin(w, url);
    await runNextBatch(w.idep());
    expect(
      await setPriceForAll(w.idep(), w.harbour, {
        batch_id: first,
        price_minor: 10,
        all_from_source: true,
      }),
    ).toEqual({ ok: false, error: { code: 'batch_not_ready' } });
  });
});
