// POB-Q1 (bulk photo onboarding): the publisher gives ONE address. quickImport makes the proof code and a
// ready-made proof file, then (asked again by the page every few seconds) checks the site and starts the import
// by itself. setPriceForAll prices every unpriced staged item of a batch in one transaction, so a catalogue of
// photos with no prices is ready to publish with one click. The scripted web of import-support is used: no
// test opens a socket.
import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { WELL_KNOWN_PATH } from './domain-proof';
import { runNextBatch, startVerifiedImport } from './import-stage';
import { publishBatch } from './import-publish';
import { quickImport, setPriceForAll } from './import-quick';
import {
  SHOP,
  SHOP_HOST,
  SOURCE_URL,
  WELL_KNOWN_URL,
  auditRows,
  byKey,
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

const TOKEN_RE = /^umv-[0-9a-f]{32}$/;

async function stagedShop(w: ImportWorld): Promise<string> {
  await verifyShop(w);
  const b = await startVerifiedImport(w.idep(), w.harbour, { source_url: SOURCE_URL });
  if (!b.ok) throw new Error(`begin refused: ${b.error.code}`);
  await runNextBatch(w.idep());
  return b.value.batch_id;
}

describe('quickImport: one address, no second paste', () => {
  it('a new site: gives the code, the proof file and the meta tag, fetches nothing', async () => {
    const w = await fresh();
    const r = await quickImport(w.idep(), w.harbour, { source_url: SOURCE_URL });
    expect(r.ok).toBe(true);
    if (!r.ok || r.value.step !== 'prove') throw new Error('expected prove');
    expect(r.value.host).toBe(SHOP_HOST);
    expect(r.value.token).toMatch(TOKEN_RE);
    expect(r.value.file_path).toBe(WELL_KNOWN_PATH);
    expect(r.value.file_body).toBe(`${r.value.token}\n`);
    expect(r.value.meta_tag).toBe(`<meta name="unitmarket-verify" content="${r.value.token}">`);
    expect(w.web.calls).toEqual([]);
    expect(await countOf(w.db, "SELECT count(*) AS c FROM publisher_domains WHERE state = 'pending'")).toBe(1);
  });

  it('asked again before the file is up: waiting, the same code still works, no new token', async () => {
    const w = await fresh();
    const first = await quickImport(w.idep(), w.harbour, { source_url: SOURCE_URL });
    if (!first.ok || first.value.step !== 'prove') throw new Error('expected prove');
    const again = await quickImport(w.idep(), w.harbour, { source_url: SOURCE_URL });
    expect(again).toEqual({ ok: true, value: { step: 'waiting', host: SHOP_HOST } });
    // The uploaded file from the first answer now proves the site.
    w.web.pages[WELL_KNOWN_URL] = { content_type: 'text/plain', body: first.value.file_body };
    const third = await quickImport(w.idep(), w.harbour, { source_url: SOURCE_URL });
    expect(third.ok && third.value.step).toBe('started');
  });

  it('once the proof file is up: verifies the site and starts the import by itself', async () => {
    const w = await fresh();
    const first = await quickImport(w.idep(), w.harbour, { source_url: SOURCE_URL });
    if (!first.ok || first.value.step !== 'prove') throw new Error('expected prove');
    w.web.pages[WELL_KNOWN_URL] = { content_type: 'text/plain', body: first.value.file_body };
    const r = await quickImport(w.idep(), w.harbour, { source_url: SOURCE_URL });
    expect(r.ok).toBe(true);
    if (!r.ok || r.value.step !== 'started') throw new Error('expected started');
    expect(r.value.batch_id).toMatch(/^imb_/);
    expect(await countOf(w.db, "SELECT count(*) AS c FROM publisher_domains WHERE state = 'verified'")).toBe(1);
    expect(await countOf(w.db, "SELECT count(*) AS c FROM import_batches WHERE state = 'queued'")).toBe(1);
    const acts = (await auditRows(w.db, '%')).map((a) => a.action);
    expect(acts).toEqual(
      expect.arrayContaining(['domain.requested', 'domain.verified', 'import.begun']),
    );
  });

  it('a site already proved: starts the import at once', async () => {
    const w = await fresh();
    await verifyShop(w);
    const r = await quickImport(w.idep(), w.harbour, { source_url: SOURCE_URL });
    expect(r.ok && r.value.step).toBe('started');
  });

  it('new_code gives a fresh code for a pending site (the old one stops working)', async () => {
    const w = await fresh();
    const a = await quickImport(w.idep(), w.harbour, { source_url: SOURCE_URL });
    const b = await quickImport(w.idep(), w.harbour, { source_url: SOURCE_URL, new_code: true });
    if (!a.ok || a.value.step !== 'prove' || !b.ok || b.value.step !== 'prove')
      throw new Error('expected prove twice');
    expect(b.value.token).not.toBe(a.value.token);
    w.web.pages[WELL_KNOWN_URL] = { content_type: 'text/plain', body: a.value.file_body };
    expect(await quickImport(w.idep(), w.harbour, { source_url: SOURCE_URL })).toEqual({
      ok: true,
      value: { step: 'waiting', host: SHOP_HOST },
    });
  });

  it.each(['http://shop.pub-one.invalid/catalogue', 'https://localhost/x', '', 'shop'])(
    'refuses the address %j and writes nothing',
    async (source_url) => {
      const w = await fresh();
      expect(await quickImport(w.idep(), w.harbour, { source_url })).toEqual({
        ok: false,
        error: { code: 'invalid_address' },
      });
      expect(await countOf(w.db, 'SELECT count(*) AS c FROM publisher_domains')).toBe(0);
    },
  );

  it('a buyer or an operator is not_publisher', async () => {
    const w = await fresh();
    expect(
      await quickImport(w.idep(), { kind: 'system' }, { source_url: SOURCE_URL }),
    ).toEqual({ ok: false, error: { code: 'not_publisher' } });
  });

  it('a site proved by another publisher is host_taken', async () => {
    const w = await fresh();
    await verifyShop(w);
    expect(await quickImport(w.idep(), w.quayside, { source_url: SOURCE_URL })).toEqual({
      ok: false,
      error: { code: 'host_taken' },
    });
  });

  it('with the import switched off it fetches nothing and says import_off', async () => {
    const w = await fresh();
    await verifyShop(w);
    const r = await quickImport(w.idep({ fetcher: null }), w.harbour, { source_url: SOURCE_URL });
    expect(r).toEqual({ ok: false, error: { code: 'import_off' } });
  });
});

describe('setPriceForAll: one price for every unpriced photo', () => {
  it('prices only staged items with no price, keeps the others, one audit row', async () => {
    const w = await fresh();
    const id = await stagedShop(w);
    const r = await setPriceForAll(w.idep(), w.harbour, { batch_id: id, price_minor: 10 });
    expect(r).toEqual({ ok: true, value: { priced: 2 } });
    const rows = await itemRows(w.db, id);
    expect(byKey(rows, '/a/ferry').price_minor).toBe(10);
    expect(byKey(rows, '/p/knots').price_minor).toBe(10);
    expect(byKey(rows, '/a/tides').price_minor).toBe(150);
    expect(byKey(rows, '/p/chart').price_minor).toBe(450);
    // refused items are never priced
    expect(byKey(rows, '/p/cdn').price_minor).toBe(300);
    const audit = await auditRows(w.db, 'import.price_all');
    expect(audit).toHaveLength(1);
    expect(audit[0]!.detail).toMatchObject({ batch_id: id, price_minor: 10, priced: 2 });
  });

  it('replace_existing sets the one price on every staged item', async () => {
    const w = await fresh();
    const id = await stagedShop(w);
    const r = await setPriceForAll(w.idep(), w.harbour, {
      batch_id: id,
      price_minor: 25,
      replace_existing: true,
    });
    expect(r).toEqual({ ok: true, value: { priced: 4 } });
    const staged = (await itemRows(w.db, id)).filter((x) => x.state === 'staged');
    expect(staged.map((x) => x.price_minor)).toEqual([25, 25, 25, 25]);
  });

  it('then publish all publishes every staged item with no "needs a price" left', async () => {
    const w = await fresh();
    const id = await stagedShop(w);
    await setPriceForAll(w.idep(), w.harbour, { batch_id: id, price_minor: 10 });
    const p = await publishBatch(w.idep(), w.harbour, { batch_id: id, attestation: true });
    expect(p.ok).toBe(true);
    if (!p.ok) return;
    expect(p.value).toMatchObject({ published: 4, needs_price: 0, bad_price: 0, failed: 0 });
  });

  it.each([0, -1, 1.5, Number.NaN, 10_000_000_000])('refuses the price %j', async (price_minor) => {
    const w = await fresh();
    const id = await stagedShop(w);
    expect(await setPriceForAll(w.idep(), w.harbour, { batch_id: id, price_minor })).toEqual({
      ok: false,
      error: { code: 'invalid_price' },
    });
    expect(await countOf(w.db, 'SELECT count(*) AS c FROM import_items WHERE price_minor IS NULL AND state = $1', ['staged'])).toBe(2);
  });

  it("another publisher's batch is not_found and nothing changes", async () => {
    const w = await fresh();
    const id = await stagedShop(w);
    expect(
      await setPriceForAll(w.idep(), w.quayside, { batch_id: id, price_minor: 10 }),
    ).toEqual({ ok: false, error: { code: 'not_found' } });
    expect((await auditRows(w.db, 'import.price_all')).length).toBe(0);
  });

  it('a batch still running is batch_not_ready', async () => {
    const w = await fresh();
    await verifyShop(w);
    const b = await startVerifiedImport(w.idep(), w.harbour, { source_url: SOURCE_URL });
    if (!b.ok) throw new Error('begin refused');
    expect(
      await setPriceForAll(w.idep(), w.harbour, { batch_id: b.value.batch_id, price_minor: 10 }),
    ).toEqual({ ok: false, error: { code: 'batch_not_ready' } });
  });

  it('a buyer or system actor is not_publisher', async () => {
    const w = await fresh();
    const id = await stagedShop(w);
    expect(
      await setPriceForAll(w.idep(), { kind: 'system' }, { batch_id: id, price_minor: 10 }),
    ).toEqual({ ok: false, error: { code: 'not_publisher' } });
  });

  it('does not touch the shop pages again', async () => {
    const w = await fresh();
    const id = await stagedShop(w);
    w.web.calls.length = 0;
    await setPriceForAll(w.idep(), w.harbour, { batch_id: id, price_minor: 10 });
    expect(w.web.calls).toEqual([]);
    expect(SHOP).toContain(SHOP_HOST);
  });
});
