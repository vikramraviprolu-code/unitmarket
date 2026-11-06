// POB-I1 (D-089, journey J9): the publisher publishes the staged items they chose. One transaction per item
// through the existing publisher offer path: the article and its hosted copy, offer version 1 live, the
// authorisation row and an audit row. The attestation of rights is asked once per batch. The buyer price
// shown at review comes from the injected ImportFeePolicy (the default is no fee). A price is the
// publisher's own and obeys the same bounds as any offer price.
import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { listAuthorisedOffers } from './read';
import { listOwnOffers } from './write';
import { fixedFeePolicy } from './fee';
import { ZERO_FEE_POLICY, buyerPriceOf, importFeeFrom } from './import-fee';
import { editItem, getBatch, runNextBatch, startVerifiedImport } from './import-stage';
import { publishBatch } from './import-publish';
import {
  PNG,
  SHOP,
  SOURCE_URL,
  auditRows,
  batchRow,
  byKey,
  countOf,
  importWorld,
  itemRows,
  sha256Hex,
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
async function staged(): Promise<{ w: ImportWorld; id: string }> {
  const w = await importWorld(shopPages(fixture));
  worlds.push(w);
  await verifyShop(w);
  const b = await startVerifiedImport(w.idep(), w.harbour, { source_url: SOURCE_URL });
  await runNextBatch(w.idep());
  return { w, id: b.ok ? b.value.batch_id : '' };
}
const give = async (w: ImportWorld, id: string, tail: string, price: number) => {
  const r = byKey(await itemRows(w.db, id), tail);
  const e = await editItem(w.idep(), w.harbour, { item_id: r.id, price_minor: price });
  expect(e.ok).toBe(true);
  return r;
};

describe('the fee port', () => {
  it('ZERO_FEE_POLICY is the default: no fee on any price', () => {
    expect(ZERO_FEE_POLICY.feeFor(1, 'USD')).toBe(0);
    expect(ZERO_FEE_POLICY.feeFor(2000, 'EUR')).toBe(0);
    expect(buyerPriceOf(ZERO_FEE_POLICY, 450, 'USD')).toEqual({ fee_minor: 0, buyer_minor: 450 });
  });
  it('buyerPriceOf adds the fee of the policy to the seller price and checks the answer', () => {
    const ten = { feeFor: (m: number) => Math.round(m * 0.1) };
    expect(buyerPriceOf(ten, 150, 'USD')).toEqual({ fee_minor: 15, buyer_minor: 165 });
    expect(buyerPriceOf(ten, 5, 'USD')).toEqual({ fee_minor: 1, buyer_minor: 6 });
    for (const bad of [
      -1,
      0.5,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      2 ** 53,
      '3' as unknown as number,
    ])
      expect(buyerPriceOf({ feeFor: () => bad }, 100, 'USD')).toBeNull();
    expect(
      buyerPriceOf(
        {
          feeFor: () => {
            throw new Error('x');
          },
        },
        100,
        'USD',
      ),
    ).toBeNull();
    expect(buyerPriceOf(ten, 0, 'USD')).toBeNull();
    expect(buyerPriceOf(ten, 1.5, 'USD')).toBeNull();
  });
  it('is asked with the seller price in minor units and the currency, nothing else', () => {
    const feeFor = vi.fn(() => 3);
    buyerPriceOf({ feeFor }, 120, 'USD');
    expect(feeFor).toHaveBeenCalledTimes(1);
    expect(feeFor).toHaveBeenCalledWith(120, 'USD');
  });
});

describe('publishBatch', () => {
  it('needs the attestation of rights, ticked, before anything is written', async () => {
    const { w, id } = await staged();
    await give(w, id, '/a/ferry', 300);
    const before = await countOf(w.db, 'SELECT count(*) AS c FROM articles');
    for (const attestation of [false, undefined, 'true', 1, null] as unknown[]) {
      expect(
        await publishBatch(w.idep(), w.harbour, {
          batch_id: id,
          attestation: attestation as boolean,
        }),
      ).toEqual({ ok: false, error: { code: 'attestation_required' } });
    }
    expect(await countOf(w.db, 'SELECT count(*) AS c FROM articles')).toBe(before);
    expect((await batchRow(w.db, id)).attested_at).toBeNull();
  });

  it('publishes every staged item that has a price: article, hosted copy, offer 1 live, authorisation, audit', async () => {
    const { w, id } = await staged();
    const listedBefore = (await listAuthorisedOffers(w.db, { corridor_id: 'us-usd', limit: 500 }))
      .length;
    const r = await publishBatch(w.idep(), w.harbour, { batch_id: id, attestation: true });
    // tides (150), chart (450) have prices; ferry and knots have none; two are refused
    expect(r).toEqual({
      ok: true,
      value: { published: 2, needs_price: 2, bad_price: 0, failed: 0 },
    });
    const rows = await itemRows(w.db, id);
    const tides = byKey(rows, '/a/tides');
    expect(tides.state).toBe('published');
    expect(tides.article_id).toMatch(/^art_/);
    expect(tides.offer_id).toMatch(/^ofr_harbour-ledger_/);
    const art = (
      await w.db.query<Record<string, unknown>>(
        'SELECT publisher_id, title, abstract, language, topics, sha256, content_key, bytes, mime, created_by, published_at FROM articles WHERE id = $1',
        [tides.article_id],
      )
    ).rows[0]!;
    expect(art).toMatchObject({
      publisher_id: w.pubId['harbour-ledger'],
      title: 'Tide notes for winter',
      abstract: 'Short notes on winter tides.',
      language: 'en',
      topics: ['tides', 'harbour'],
      sha256: tides.content_sha256,
      content_key: tides.content_ref,
      bytes: tides.content_bytes,
      mime: 'text/plain',
      created_by: `web_import:${w.pubId['harbour-ledger']}`,
    });
    expect(new Date(art.published_at as string).toISOString()).toBe('2026-09-30T08:00:00.000Z');
    // the hosted copy is the blob made at staging; its hash is the one recorded
    const blob = (
      await w.db.query<{ data: Uint8Array }>(
        'SELECT data FROM content_blobs WHERE content_key = $1',
        [tides.content_ref],
      )
    ).rows[0]!;
    expect(await sha256Hex(blob.data)).toBe(art.sha256);

    const offer = (
      await w.db.query<Record<string, unknown>>(
        'SELECT version, status, currency, options, publisher_id, article_id, terms_version, superseded_by FROM offers WHERE id = $1',
        [tides.offer_id],
      )
    ).rows[0]!;
    expect(offer).toMatchObject({
      version: '1',
      status: 'authorised',
      currency: 'USD',
      superseded_by: null,
      article_id: tides.article_id,
    });
    expect(offer.options).toEqual([
      {
        option: 'keep_retrieve',
        price_minor: 150,
        policy_id: 'keep_retrieve',
        policy_version: '1',
      },
      { option: 'online_read', price_minor: 150, policy_id: 'online_read', policy_version: '1' },
    ]);
    const auth = (
      await w.db.query<{ authorised_by: string; attestation_version: string }>(
        'SELECT authorised_by, attestation_version FROM publisher_authorisations WHERE offer_id = $1',
        [tides.offer_id],
      )
    ).rows;
    expect(auth).toEqual([
      { authorised_by: w.pubId['harbour-ledger'], attestation_version: 'PUB-ATTEST-1' },
    ]);
    expect((await auditRows(w.db, 'offer.created')).length).toBe(2);
    const done = await auditRows(w.db, 'import.published');
    expect(done).toHaveLength(1);
    expect(done[0]!.detail).toMatchObject({ batch_id: id, published: 2, needs_price: 2 });
    // buyers can now find them
    const listed = await listAuthorisedOffers(w.db, { corridor_id: 'us-usd', limit: 500 });
    expect(listed.length).toBe(listedBefore + 2);
    expect(
      (await listOwnOffers(w.db, w.harbour))!.filter((o) => o.status === 'authorised').length,
    ).toBeGreaterThanOrEqual(2);
  });

  it('a picture item becomes an article whose content is the picture, same bytes and hash', async () => {
    const { w, id } = await staged();
    await publishBatch(w.idep(), w.harbour, { batch_id: id, attestation: true });
    const chart = byKey(await itemRows(w.db, id), '/p/chart');
    expect(chart.state).toBe('published');
    const art = (
      await w.db.query<{ mime: string; bytes: number; sha256: string; content_key: string }>(
        'SELECT mime, bytes, sha256, content_key FROM articles WHERE id = $1',
        [chart.article_id],
      )
    ).rows[0]!;
    expect(art).toMatchObject({
      mime: 'image/png',
      bytes: PNG.length,
      sha256: await sha256Hex(PNG),
      content_key: chart.content_ref,
    });
    const offer = (
      await w.db.query<{ options: { price_minor: number }[] }>(
        'SELECT options FROM offers WHERE id = $1',
        [chart.offer_id],
      )
    ).rows[0]!;
    expect(offer.options.map((o) => o.price_minor)).toEqual([450, 450]);
  });

  it('the offer and the article belong to the publisher of the batch, in its corridor currency', async () => {
    const { w, id } = await staged();
    await publishBatch(w.idep(), w.harbour, { batch_id: id, attestation: true });
    expect(
      await countOf(
        w.db,
        `SELECT count(*) AS c FROM import_items i
           JOIN articles a ON a.id = i.article_id JOIN offers o ON o.id = i.offer_id
          WHERE i.state = 'published' AND a.publisher_id = i.publisher_id AND o.publisher_id = i.publisher_id AND o.currency = 'USD'`,
      ),
    ).toBe(2);
  });

  it('items without a price stay staged and are counted; a price makes them publishable', async () => {
    const { w, id } = await staged();
    const first = await publishBatch(w.idep(), w.harbour, { batch_id: id, attestation: true });
    expect(first.ok && first.value.needs_price).toBe(2);
    expect(byKey(await itemRows(w.db, id), '/a/ferry').state).toBe('staged');
    await give(w, id, '/a/ferry', 300);
    // the attestation was given once for this batch: it is not asked again
    const second = await publishBatch(w.idep(), w.harbour, { batch_id: id, attestation: false });
    expect(second).toEqual({
      ok: true,
      value: { published: 1, needs_price: 1, bad_price: 0, failed: 0 },
    });
    expect(byKey(await itemRows(w.db, id), '/a/ferry').state).toBe('published');
    expect((await batchRow(w.db, id)).attested_at).not.toBeNull();
  });

  it('hidden and refused items are never published, even when named', async () => {
    const { w, id } = await staged();
    const tides = await give(w, id, '/a/tides', 150);
    await editItem(w.idep(), w.harbour, { item_id: tides.id, hidden: true });
    const refused = byKey(await itemRows(w.db, id), '/p/cdn');
    const r = await publishBatch(w.idep(), w.harbour, {
      batch_id: id,
      attestation: true,
      item_ids: [tides.id, refused.id],
    });
    expect(r).toEqual({
      ok: true,
      value: { published: 0, needs_price: 0, bad_price: 0, failed: 0 },
    });
    const rows = await itemRows(w.db, id);
    expect(byKey(rows, '/a/tides').state).toBe('hidden');
    expect(byKey(rows, '/p/cdn').state).toBe('refused');
  });

  it('item_ids picks which staged items go; the others stay for later', async () => {
    const { w, id } = await staged();
    const chart = byKey(await itemRows(w.db, id), '/p/chart');
    const r = await publishBatch(w.idep(), w.harbour, {
      batch_id: id,
      attestation: true,
      item_ids: [chart.id],
    });
    expect(r).toEqual({
      ok: true,
      value: { published: 1, needs_price: 0, bad_price: 0, failed: 0 },
    });
    const rows = await itemRows(w.db, id);
    expect(byKey(rows, '/p/chart').state).toBe('published');
    expect(byKey(rows, '/a/tides').state).toBe('staged');
  });

  it('an item id from another batch or another publisher is ignored and published by nobody', async () => {
    const { w, id } = await staged();
    const other = await publishBatch(w.idep(), w.harbour, {
      batch_id: id,
      attestation: true,
      item_ids: ['imi_not_there', 'x'.repeat(300)],
    });
    expect(other).toEqual({
      ok: true,
      value: { published: 0, needs_price: 0, bad_price: 0, failed: 0 },
    });
    expect(
      await countOf(w.db, "SELECT count(*) AS c FROM import_items WHERE state = 'published'"),
    ).toBe(0);
  });

  it('publishing twice publishes once: a published item is skipped', async () => {
    const { w, id } = await staged();
    await publishBatch(w.idep(), w.harbour, { batch_id: id, attestation: true });
    const articles = await countOf(w.db, 'SELECT count(*) AS c FROM articles');
    const again = await publishBatch(w.idep(), w.harbour, { batch_id: id, attestation: true });
    expect(again).toEqual({
      ok: true,
      value: { published: 0, needs_price: 2, bad_price: 0, failed: 0 },
    });
    expect(await countOf(w.db, 'SELECT count(*) AS c FROM articles')).toBe(articles);
    expect(
      await countOf(w.db, "SELECT count(*) AS c FROM audit_log WHERE action = 'offer.created'"),
    ).toBe(2);
  });

  it('a price over the offer cap is bad_price and the item stays staged (cap lowered after staging)', async () => {
    const { w, id } = await staged();
    const r = await publishBatch(w.idep({ offer_max_minor: 200 }), w.harbour, {
      batch_id: id,
      attestation: true,
    });
    // tides 150 passes, chart 450 does not
    expect(r).toEqual({
      ok: true,
      value: { published: 1, needs_price: 2, bad_price: 1, failed: 0 },
    });
    expect(byKey(await itemRows(w.db, id), '/p/chart').state).toBe('staged');
  });

  it('one item failing leaves it staged and does not stop the others (one transaction per item)', async () => {
    const { w, id } = await staged();
    const tides = byKey(await itemRows(w.db, id), '/a/tides');
    // an article already holds this content key: the insert for this item collides and rolls back alone
    await w.db.query(
      `INSERT INTO articles (id, publisher_id, title, abstract, language, topics, published_at, sha256, content_key, bytes, mime, created_at, updated_at)
       VALUES ('art_collide', $1, 'Squatter', 'x', 'en', ARRAY['t'], $2, $3, $4, 1, 'text/plain', $2, $2)`,
      [w.pubId['quayside-gazette'], w.clock.now().toISOString(), 'c'.repeat(64), tides.content_ref],
    );
    const r = await publishBatch(w.idep(), w.harbour, { batch_id: id, attestation: true });
    expect(r).toEqual({
      ok: true,
      value: { published: 1, needs_price: 2, bad_price: 0, failed: 1 },
    });
    const rows = await itemRows(w.db, id);
    expect(byKey(rows, '/a/tides')).toMatchObject({
      state: 'staged',
      article_id: null,
      offer_id: null,
    });
    expect(byKey(rows, '/p/chart').state).toBe('published');
    // nothing of the failed item is left behind
    expect(
      await countOf(
        w.db,
        "SELECT count(*) AS c FROM offers WHERE id LIKE 'ofr_harbour-ledger_%' AND article_id NOT IN (SELECT id FROM articles)",
      ),
    ).toBe(0);
  });

  it('another publisher cannot publish my batch, a buyer cannot publish at all', async () => {
    const { w, id } = await staged();
    expect(await publishBatch(w.idep(), w.quayside, { batch_id: id, attestation: true })).toEqual({
      ok: false,
      error: { code: 'not_found' },
    });
    expect(await publishBatch(w.idep(), w.buyer, { batch_id: id, attestation: true })).toEqual({
      ok: false,
      error: { code: 'not_publisher' },
    });
    expect(await publishBatch(w.idep(), w.operator, { batch_id: id, attestation: true })).toEqual({
      ok: false,
      error: { code: 'not_publisher' },
    });
    expect(
      await publishBatch(w.idep(), w.harbour, { batch_id: 'imb_nothing', attestation: true }),
    ).toEqual({ ok: false, error: { code: 'not_found' } });
    expect(
      await countOf(w.db, "SELECT count(*) AS c FROM import_items WHERE state = 'published'"),
    ).toBe(0);
  });

  it('a suspended publisher publishes nothing', async () => {
    const { w, id } = await staged();
    await w.db.query(`UPDATE publishers SET status = 'suspended' WHERE id = $1`, [
      w.pubId['harbour-ledger'],
    ]);
    expect(await publishBatch(w.idep(), w.harbour, { batch_id: id, attestation: true })).toEqual({
      ok: false,
      error: { code: 'publisher_not_active' },
    });
  });

  it('a batch still running cannot be published from', async () => {
    const w = await importWorld(shopPages(fixture));
    worlds.push(w);
    await verifyShop(w);
    const b = await startVerifiedImport(w.idep(), w.harbour, { source_url: SOURCE_URL });
    const id = b.ok ? b.value.batch_id : '';
    expect(await publishBatch(w.idep(), w.harbour, { batch_id: id, attestation: true })).toEqual({
      ok: false,
      error: { code: 'batch_not_ready' },
    });
  });

  it('the listed price is the buyer price: publisher price plus the fee in force, the split recorded beside it', async () => {
    // POB-G: this test said "the offer carries the publisher price" while the fee lane was not built. The fee lane
    // (POB-M1) has landed and D-096 (2) confirms the fee on top, so the offer now carries the buyer price.
    const { w, id } = await staged();
    w.fee.policy = importFeeFrom(fixedFeePolicy(1000));
    const view = await getBatch(w.idep(), w.harbour, id);
    expect(view!.items.find((i) => i.source_key.endsWith('/a/tides'))).toMatchObject({
      price_minor: 150,
      fee_minor: 15,
      buyer_price_minor: 165,
    });
    await publishBatch(w.idep(), w.harbour, { batch_id: id, attestation: true });
    const t = byKey(await itemRows(w.db, id), '/a/tides');
    const o = (
      await w.db.query<{ options: { price_minor: number }[] }>(
        'SELECT options FROM offers WHERE id = $1',
        [t.offer_id],
      )
    ).rows[0]!;
    expect(o.options.map((x) => x.price_minor)).toEqual([165, 165]);
    const after = await getBatch(w.idep(), w.harbour, id);
    expect(after!.items.find((i) => i.source_key.endsWith('/a/tides'))).toMatchObject({
      state: 'published',
      price_minor: 150,
      buyer_price_minor: 165,
    });
  });
});

describe('publish records the parts of the offer (POB-G, gap 2)', () => {
  const partsOf = async (w: ImportWorld, offer_id: string) =>
    (
      await w.db.query<{
        option: string;
        seller_minor: string | number;
        fee_minor: string | number;
        tax_minor: string | number;
        fee_bps: number;
      }>(
        `SELECT option, seller_minor, fee_minor, tax_minor, fee_bps FROM offer_price_parts
          WHERE offer_id = $1 AND offer_version = '1' ORDER BY option`,
        [offer_id],
      )
    ).rows.map((r) => ({
      option: r.option,
      seller_minor: Number(r.seller_minor),
      fee_minor: Number(r.fee_minor),
      tax_minor: Number(r.tax_minor),
      fee_bps: r.fee_bps,
    }));

  it('10 percent: both options list the buyer price and carry parts that add up to it', async () => {
    const { w, id } = await staged();
    w.fee.policy = importFeeFrom(fixedFeePolicy(1000));
    const r = await publishBatch(w.idep(), w.harbour, { batch_id: id, attestation: true });
    expect(r.ok && r.value.published).toBe(2);
    const rows = await itemRows(w.db, id);
    const chart = byKey(rows, '/p/chart');
    const offer = (
      await w.db.query<{ options: { option: string; price_minor: number }[] }>(
        'SELECT options FROM offers WHERE id = $1',
        [chart.offer_id],
      )
    ).rows[0]!;
    expect(offer.options.map((o) => [o.option, o.price_minor])).toEqual([
      ['keep_retrieve', 495],
      ['online_read', 495],
    ]);
    expect(await partsOf(w, chart.offer_id!)).toEqual([
      { option: 'keep_retrieve', seller_minor: 450, fee_minor: 45, tax_minor: 0, fee_bps: 1000 },
      { option: 'online_read', seller_minor: 450, fee_minor: 45, tax_minor: 0, fee_bps: 1000 },
    ]);
    // the audit row names the listed (buyer) prices
    const audit = await w.db.query<{ detail: { new_prices: string } }>(
      `SELECT detail FROM audit_log WHERE action = 'offer.created' AND target = $1`,
      [chart.offer_id],
    );
    expect(audit.rows[0]!.detail.new_prices).toBe('keep_retrieve=495,online_read=495');
  });

  it('fee 0 still records parts: seller equals the listed price, fee 0', async () => {
    const { w, id } = await staged();
    await publishBatch(w.idep(), w.harbour, { batch_id: id, attestation: true });
    const tides = byKey(await itemRows(w.db, id), '/a/tides');
    expect(await partsOf(w, tides.offer_id!)).toEqual([
      { option: 'keep_retrieve', seller_minor: 150, fee_minor: 0, tax_minor: 0, fee_bps: 0 },
      { option: 'online_read', seller_minor: 150, fee_minor: 0, tax_minor: 0, fee_bps: 0 },
    ]);
  });

  it('the rate is read once for the batch from the loader, and a later setting does not change a published offer', async () => {
    const { w, id } = await staged();
    let rate = 1000;
    let loads = 0;
    const loadFee = async () => {
      loads += 1;
      return importFeeFrom(fixedFeePolicy(rate));
    };
    await publishBatch(w.idep({ loadFee }), w.harbour, {
      batch_id: id,
      attestation: true,
      item_ids: [byKey(await itemRows(w.db, id), '/p/chart').id],
    });
    expect(loads).toBe(1);
    rate = 2000;
    await publishBatch(w.idep({ loadFee }), w.harbour, { batch_id: id, attestation: true });
    const rows = await itemRows(w.db, id);
    expect((await partsOf(w, byKey(rows, '/p/chart').offer_id!))[0]).toMatchObject({
      fee_minor: 45,
      fee_bps: 1000,
    });
    expect((await partsOf(w, byKey(rows, '/a/tides').offer_id!))[0]).toMatchObject({
      fee_minor: 30,
      fee_bps: 2000,
    });
  });

  it('a fee that cannot be read refuses the publish (fail closed): nothing is written, the items stay staged', async () => {
    const { w, id } = await staged();
    const loadFee = async (): Promise<never> => {
      throw new Error('fee_settings unreadable');
    };
    const r = await publishBatch(w.idep({ loadFee }), w.harbour, {
      batch_id: id,
      attestation: true,
    });
    expect(r).toEqual({ ok: false, error: { code: 'fee_unavailable' } });
    expect(
      await countOf(w.db, "SELECT count(*) AS c FROM import_items WHERE state = 'published'"),
    ).toBe(0);
    expect(await countOf(w.db, 'SELECT count(*) AS c FROM offer_price_parts')).toBe(0);
  });

  it('a policy whose answer is not a whole fee, or has a fee but no rate, refuses the publish', async () => {
    for (const policy of [
      { feeFor: () => 1.5, fee_bps: 1000 },
      { feeFor: () => -1, fee_bps: 1000 },
      { feeFor: (m: number) => Math.round(m * 0.1) }, // a fee with no rate to record
    ]) {
      const { w, id } = await staged();
      w.fee.policy = policy;
      const offers = await countOf(w.db, 'SELECT count(*) AS c FROM offers');
      const r = await publishBatch(w.idep(), w.harbour, { batch_id: id, attestation: true });
      expect(r).toEqual({ ok: false, error: { code: 'fee_unavailable' } });
      expect(await countOf(w.db, 'SELECT count(*) AS c FROM offers')).toBe(offers);
      expect(await countOf(w.db, 'SELECT count(*) AS c FROM offer_price_parts')).toBe(0);
    }
  });

  it('a buyer price over the offer cap is bad_price and the item stays staged', async () => {
    const { w, id } = await staged();
    w.fee.policy = importFeeFrom(fixedFeePolicy(1000));
    // the publisher prices (150, 450) alone: 150 fits a cap of 160, but the buyer price 165 does not
    const r = await publishBatch(w.idep({ offer_max_minor: 160 }), w.harbour, {
      batch_id: id,
      attestation: true,
    });
    expect(r).toEqual({
      ok: true,
      value: { published: 0, needs_price: 2, bad_price: 2, failed: 0 },
    });
    expect(await countOf(w.db, 'SELECT count(*) AS c FROM offer_price_parts')).toBe(0);
    expect(byKey(await itemRows(w.db, id), '/a/tides').state).toBe('staged');
  });
});

describe('the fee at review comes from the loader (POB-G, gap 1)', () => {
  it('the review shows the fee of the loaded policy, read each time', async () => {
    const { w, id } = await staged();
    let rate = 1000;
    const loadFee = async () => importFeeFrom(fixedFeePolicy(rate));
    const tides = async () =>
      (await getBatch(w.idep({ loadFee }), w.harbour, id))!.items.find((i) =>
        i.source_key.endsWith('/a/tides'),
      );
    expect(await tides()).toMatchObject({ fee_minor: 15, buyer_price_minor: 165 });
    rate = 500;
    expect(await tides()).toMatchObject({ fee_minor: 8, buyer_price_minor: 158 });
  });

  it('an unreadable fee shows the publisher price and no buyer price; the page does not break', async () => {
    const { w, id } = await staged();
    const loadFee = async (): Promise<never> => {
      throw new Error('fee_settings unreadable');
    };
    const view = await getBatch(w.idep({ loadFee }), w.harbour, id);
    const tides = view!.items.find((i) => i.source_key.endsWith('/a/tides'))!;
    expect(tides).toMatchObject({ price_minor: 150, fee_minor: null, buyer_price_minor: null });
  });

  it('importFeeFrom keeps the rate and the fee of a FeePolicy', () => {
    const p = importFeeFrom(fixedFeePolicy(1000));
    expect(p.fee_bps).toBe(1000);
    expect(p.feeFor(150, 'USD')).toBe(15);
    expect(p.feeFor(5, 'USD')).toBe(1);
  });
});

describe('re-import after publishing', () => {
  it('skips the published keys, never overwrites the article or the offer, and writes nothing new', async () => {
    const { w, id } = await staged();
    await publishBatch(w.idep(), w.harbour, { batch_id: id, attestation: true });
    const snapshot = async () => ({
      articles: (
        await w.db.query(
          'SELECT id, title, sha256, content_key, updated_at FROM articles ORDER BY id',
        )
      ).rows,
      offers: (
        await w.db.query('SELECT id, version, status, options FROM offers ORDER BY id, version')
      ).rows,
      blobs: await countOf(w.db, 'SELECT count(*) AS c FROM content_blobs'),
      auths: await countOf(w.db, 'SELECT count(*) AS c FROM publisher_authorisations'),
    });
    const before = await snapshot();
    // the source now has a different text and price for the published article
    w.web.pages[SOURCE_URL] = {
      content_type: 'text/html',
      body: w.web.pages[SOURCE_URL]!.body!.replace(
        'Low water is at dawn.',
        'Low water is at noon.',
      ).replace('"1.50"', '"9.99"'),
    };
    w.web.calls.length = 0;
    const b2 = await startVerifiedImport(w.idep(), w.harbour, { source_url: SOURCE_URL });
    expect(b2.ok).toBe(true);
    await runNextBatch(w.idep());
    const row = await batchRow(w.db, b2.ok ? b2.value.batch_id : '');
    expect(row).toMatchObject({ state: 'done', existing: 6, changed: 1 });
    expect(await snapshot()).toEqual(before);
    expect(w.web.calls.filter((c) => c.url.startsWith(`${SHOP}/img/`))).toHaveLength(0);
  });
});
