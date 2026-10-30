// PUB-D: a suspended publisher's offers answer no_match "not_authorised" to a new quote; reactivating
// restores the quote. The existing start tests are unchanged. One database per file.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Actor, CoreDeps } from '@umsbx/contracts';
import { startFromOffer } from './index';
import { addBuyer, seededDb, type TestDb } from './support';

let db: TestDb;
let deps: CoreDeps;
beforeAll(async () => {
  ({ db, deps } = await seededDb());
});
afterAll(async () => {
  await db.close();
});

const setStatus = (slug: string, status: string) =>
  db.query('UPDATE publishers SET status = $2 WHERE slug = $1', [slug, status]);
const quote = async (slug: string, code: string) => {
  const actor: Actor = { kind: 'buyer', buyer_id: await addBuyer(db) };
  const r = await startFromOffer(deps, {
    offer: { publisher_slug: slug, offer_code: code },
    actor,
    source: 'direct',
  });
  if (!r.ok) throw new Error(`unexpected error ${r.error.code}`);
  return r.value;
};

describe('startFromOffer and publisher status', () => {
  it('quotes for an active publisher', async () => {
    expect((await quote('harbour-ledger', 'ferry-timetables')).kind).toBe('quote');
  });

  it('answers no_match not_authorised for a suspended publisher, and writes no quote', async () => {
    const before = Number(
      (await db.query<{ c: string }>('SELECT count(*) AS c FROM quotes')).rows[0]!.c,
    );
    await setStatus('harbour-ledger', 'suspended');
    const v = await quote('harbour-ledger', 'ferry-timetables');
    expect(v).toMatchObject({ kind: 'no_match', reason: 'not_authorised' });
    const after = Number(
      (await db.query<{ c: string }>('SELECT count(*) AS c FROM quotes')).rows[0]!.c,
    );
    expect(after).toBe(before);
  });

  it('does not affect another publisher: its offer is judged by its own rules, not by the suspension', async () => {
    const q = await quote('northfield-quarterly', 'village-bus');
    expect(q).toMatchObject({ kind: 'no_match', reason: 'corridor_unsupported' });
  });

  it('a withdrawn offer of a suspended publisher still says withdrawn (the older rule first)', async () => {
    await db.query(
      `UPDATE offers SET status = 'withdrawn' WHERE id = 'ofr_harbour-ledger_tide-tables'`,
    );
    expect(await quote('harbour-ledger', 'tide-tables')).toMatchObject({
      kind: 'no_match',
      reason: 'withdrawn',
    });
  });

  it('reactivating restores the quote', async () => {
    await setStatus('harbour-ledger', 'active');
    expect((await quote('harbour-ledger', 'ferry-timetables')).kind).toBe('quote');
  });

  it('a publisher that is not active at all (applied) gets no quote either', async () => {
    await setStatus('harbour-ledger', 'applied');
    expect(await quote('harbour-ledger', 'ferry-timetables')).toMatchObject({
      kind: 'no_match',
      reason: 'not_authorised',
    });
    await setStatus('harbour-ledger', 'active');
  });
});
