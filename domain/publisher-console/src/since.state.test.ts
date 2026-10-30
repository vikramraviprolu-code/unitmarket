// PUB-E1: counts since a given instant, for one publisher only. PGlite, synthetic rows.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { countsSince } from './since';
import { makeWorld } from './world';
import type { World } from './world';

let w: World;
const P1 = { kind: 'publisher', publisher_id: 'pub_1' } as const;
const P2 = { kind: 'publisher', publisher_id: 'pub_2' } as const;
const SINCE = '2026-10-25T00:00:00.000Z';
const OLD = '2026-10-24T00:00:00.000Z';
const NEW1 = '2026-10-26T00:00:00.000Z';

let audit = 0;
const auditRow = (
  actor_kind: string,
  action: string,
  target: string | null,
  at: string,
): Promise<void> =>
  w.insert('audit_log', {
    id: `aud_${String(++audit)}`,
    actor_kind,
    actor_id: actor_kind === 'operator' ? 'opr_1' : null,
    action,
    target,
    reason: null,
    detail: '{}',
    created_at: at,
  });

beforeAll(async () => {
  w = await makeWorld();
  const a = await w.unit({ n: 1, publisher: 'pub_1' });
  const b = await w.unit({ n: 2, publisher: 'pub_1' });
  const c = await w.unit({ n: 3, publisher: 'pub_2', buyer: 'buy_2' });
  // sales: one old, two new for pub_1; one new for pub_2
  await w.ledger('unt_1', a.capture_id!, 'sale', 500, { at: OLD });
  await w.ledger('unt_2', b.capture_id!, 'sale', 500, { at: NEW1 });
  await w.ledger('unt_2', b.capture_id!, 'refund', 100, { refund_id: 'rf_1', at: NEW1 });
  await w.ledger('unt_1', a.capture_id!, 'refund', 100, { refund_id: 'rf_0', at: OLD });
  await w.ledger('unt_3', c.capture_id!, 'sale', 500, { at: NEW1 });
  await w.ledger('unt_3', c.capture_id!, 'refund', 500, { refund_id: 'rf_2', at: NEW1 });
  // an offer of pub_1 so an audit target can name it
  await w.insert('articles', {
    id: 'art_o1',
    publisher_id: 'pub_1',
    title: 'T',
    abstract: 'x',
    language: 'en',
    topics: ['t'],
    published_at: OLD,
    sha256: 'a'.repeat(64),
    content_key: 'key_o1',
    bytes: 1,
    mime: 'text/plain',
  });
  await w.insert('offers', {
    id: 'ofr_p1_t',
    version: '1',
    publisher_id: 'pub_1',
    article_id: 'art_o1',
    status: 'authorised',
    currency: 'USD',
    options: '[]',
    affordability: '{"renegotiation_allowed":false,"floor_minor":null}',
    terms_version: 'terms-1',
    rights: '{"scope":"personal_use","ai_scope":"review","redistribution":false}',
    valid_from: OLD,
    valid_until: null,
    superseded_by: null,
  });
  // audit: operator suspends pub_1 (new), operator touches the offer (new), operator old, publisher own change,
  // operator action on pub_2 (new), system action on pub_1 (new)
  await auditRow('operator', 'publisher.suspended', 'pub_1', NEW1);
  await auditRow('operator', 'offer.revised', 'ofr_p1_t', NEW1);
  await auditRow('operator', 'publisher.reactivated', 'pub_1', OLD);
  await auditRow('publisher', 'offer.revised', 'ofr_p1_t', NEW1);
  await auditRow('operator', 'publisher.suspended', 'pub_2', NEW1);
  await auditRow('system', 'offer.revised', 'ofr_p1_t', NEW1);
  // payee decisions
  for (const [pub, n, at] of [
    ['pub_1', 1, NEW1],
    ['pub_1', 2, OLD],
    ['pub_2', 3, NEW1],
  ] as const) {
    await w.insert('payee_change_requests', {
      id: `pcr_${String(n)}`,
      publisher_id: pub,
      requested_merchant_id: `MERCHANTREQ${String(n)}`,
      note: 'n',
      created_by: pub,
      created_at: OLD,
    });
    await w.insert('payee_decisions', {
      id: `pdc_${String(n)}`,
      request_id: `pcr_${String(n)}`,
      decision: 'verified',
      operator_id: 'opr_1',
      reason: 'ok',
      created_at: at,
    });
  }
});
afterAll(async () => {
  await w.close();
});

describe('countsSince', () => {
  it('counts only rows of this publisher newer than the instant', async () => {
    expect(await countsSince(w.db, P1, SINCE)).toEqual({
      since: SINCE,
      new_sales: 1,
      refunds: 1,
      operator_offer_changes: 2,
      payee_decisions: 1,
    });
  });
  it('keeps publisher 2 apart', async () => {
    expect(await countsSince(w.db, P2, SINCE)).toEqual({
      since: SINCE,
      new_sales: 1,
      refunds: 1,
      operator_offer_changes: 1,
      payee_decisions: 1,
    });
  });
  it('counts more with an earlier instant', async () => {
    const c = await countsSince(w.db, P1, '2026-10-01T00:00:00.000Z');
    expect(c).toMatchObject({
      new_sales: 2,
      refunds: 2,
      operator_offer_changes: 3,
      payee_decisions: 2,
    });
  });
  it('does not count a row written at the instant itself', async () => {
    const c = await countsSince(w.db, P1, NEW1);
    expect(c).toMatchObject({
      new_sales: 0,
      refunds: 0,
      operator_offer_changes: 0,
      payee_decisions: 0,
    });
  });
  it('answers null for a non publisher actor', async () => {
    expect(
      await countsSince(w.db, { kind: 'buyer', buyer_id: 'buy_1' } as never, SINCE),
    ).toBeNull();
  });
  it('is read only: no table changed', async () => {
    const before = (await w.db.query('SELECT count(*)::int AS n FROM audit_log')).rows;
    await countsSince(w.db, P1, SINCE);
    expect((await w.db.query('SELECT count(*)::int AS n FROM audit_log')).rows).toEqual(before);
  });
});
