import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { CoreDeps } from '@umsbx/contracts';
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

const base = {
  offer: { publisher_slug: 'harbour-ledger', offer_code: 'tide-tables' },
  actor: null,
  source: 'direct' as const,
};
const call = (over: Record<string, unknown>) =>
  startFromOffer(deps, { ...base, ...over } as unknown as Parameters<typeof startFromOffer>[1]);
const invalid = { ok: false, error: { code: 'invalid_input' } };

describe('startFromOffer input', () => {
  it('price or payee in the input is ignored (strict schema refuses unknown keys)', async () => {
    for (const key of [
      'price',
      'price_minor',
      'payee',
      'payee_merchant_id',
      'currency',
      'amount',
      'corridor_id',
      'floor_minor',
    ]) {
      expect(await call({ [key]: 1 }), key).toEqual(invalid);
    }
    const before = await db.query('SELECT count(*)::int AS n FROM quotes');
    expect(await call({ offer: { ...base.offer, price_minor: 1 } })).toEqual(invalid);
    expect(await call({ offer: { offer_id: 'ofr_x', publisher_slug: 'harbour-ledger' } })).toEqual(
      invalid,
    );
    const after = await db.query('SELECT count(*)::int AS n FROM quotes');
    expect(after.rows).toEqual(before.rows);
  });

  it('offer_code with path characters is invalid_input', async () => {
    for (const code of [
      '../etc/passwd',
      'a/b',
      'a\\b',
      'tide tables',
      'tide-tables?x=1',
      '%2e%2e',
      '',
      'x'.repeat(200),
      'tide\u0000',
      "a'b",
    ]) {
      expect(
        await call({ offer: { publisher_slug: 'harbour-ledger', offer_code: code } }),
        JSON.stringify(code),
      ).toEqual(invalid);
    }
    expect(await call({ offer: { publisher_slug: '../x', offer_code: 'tide-tables' } })).toEqual(
      invalid,
    );
    expect(
      await call({ offer: { publisher_slug: 'Harbour Ledger', offer_code: 'tide-tables' } }),
    ).toEqual(invalid);
  });

  it('bad numbers, option, source and actor are invalid_input', async () => {
    for (const over of [
      { ceiling_minor: -1 },
      { ceiling_minor: 1.5 },
      { ceiling_minor: Number.NaN },
      { ceiling_minor: '100' },
      { ceiling_minor: Number.MAX_SAFE_INTEGER + 2 },
      { proposed_minor: -5 },
      { proposed_minor: 0.5 },
      { option: 'steal' },
      { source: 'email' },
      { actor: { kind: 'buyer' } },
      { actor: { kind: 'buyer', buyer_id: 'b', admin: true } },
      { actor: 'buyer' },
      { offer: null },
      { offer: {} },
      { offer: { offer_id: '' } },
    ]) {
      expect(await call(over), JSON.stringify(over)).toEqual(invalid);
    }
  });

  it('a buyer id that does not exist is invalid_input and stores nothing', async () => {
    const r = await call({ actor: { kind: 'buyer', buyer_id: 'buy_ghost' } });
    expect(r).toEqual(invalid);
    expect(
      (await db.query('SELECT count(*)::int AS n FROM quotes WHERE buyer_id = $1', ['buy_ghost']))
        .rows[0],
    ).toEqual({ n: 0 });
  });

  it('non-buyer actors are treated as anonymous and cannot own anything', async () => {
    const r = await call({ actor: { kind: 'operator', operator_id: 'op1', mfa: true } });
    expect(r.ok && r.value.kind).toBe('quote');
  });

  it('a prototype-pollution style key is refused', async () => {
    const polluted = JSON.parse('{"__proto__": {"price_minor": 1}}');
    expect(await call(polluted)).toEqual(invalid);
  });

  it('a valid buyer still gets exactly the publisher price whatever else is sent (no price in input path)', async () => {
    const id = await addBuyer(db);
    const r = await startFromOffer(deps, { ...base, actor: { kind: 'buyer', buyer_id: id } });
    expect(r.ok && r.value.kind === 'quote' && r.value.price.minor).toBe(40);
  });
});
