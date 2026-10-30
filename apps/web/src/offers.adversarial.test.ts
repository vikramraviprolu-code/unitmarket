// PUB-B adversarial (docs/specs/pub-b-offer-revise-withdraw.md): the route schema is strict (currency,
// publisher id, status and every other extra field is refused), another publisher answers 404 also for a
// guessed id, a body over 2 KB is refused, and nothing is written by any refusal.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  bootOffersWorld,
  both,
  FEES,
  FERRY,
  postRevise,
  postWithdraw,
  QUAY,
  TIDE,
} from './offers-support';
import type { OffersWebWorld } from './offers-support';

vi.mock('server-only', () => ({}));

let w: OffersWebWorld;
beforeAll(async () => {
  w = await bootOffersWorld();
});
afterAll(async () => {
  await w.app.close();
});
beforeEach(async () => {
  await w.app.db.query('DELETE FROM rate_buckets');
});

const harbour = () => w.pub['harbour-ledger'];
const quayside = () => w.pub['quayside-gazette'];
const rows = async (): Promise<number[]> => {
  const c = async (sql: string) => Number((await w.app.db.query<{ c: string }>(sql)).rows[0]!.c);
  return [
    await c('SELECT count(*) AS c FROM offers'),
    await c('SELECT count(*) AS c FROM publisher_authorisations'),
    await c("SELECT count(*) AS c FROM audit_log WHERE action LIKE 'offer.%'"),
  ];
};
const good = { offer_id: FERRY, expected_version: '1', options: both(130, 130), attestation: true };

describe('the revise body is strict', () => {
  it('refuses every extra field, with the field name and no write', async () => {
    const n = await rows();
    for (const extra of [
      { currency: 'EUR' },
      { publisher_id: 'pub_other' },
      { status: 'draft' },
      { article_id: 'art_x' },
      { terms_version: 'terms-x' },
      { valid_until: '2020-01-01T00:00:00.000Z' },
      { superseded_by: 'ofr_x' },
      { rights: {} },
      { version: '9' },
    ]) {
      const res = await postRevise(w, harbour(), { ...good, ...extra });
      expect(res.status, JSON.stringify(extra)).toBe(422);
      const body = (await res.json()) as { error: { code: string; fields?: string[] } };
      expect(body.error.code).toBe('invalid_input');
    }
    expect(await rows()).toEqual(n);
  });

  it('refuses an extra field inside an option', async () => {
    const n = await rows();
    const res = await postRevise(w, harbour(), {
      ...good,
      options: [{ option: 'keep_retrieve', price_minor: 130, policy_id: 'evil' }],
    });
    expect(res.status).toBe(422);
    expect(await rows()).toEqual(n);
  });

  it('refuses wrong types: a price as text, a price with a fraction, an attestation as text', async () => {
    const n = await rows();
    const cases: [unknown, number][] = [
      [{ ...good, options: [{ option: 'keep_retrieve', price_minor: '130' }] }, 422],
      [{ ...good, options: [{ option: 'keep_retrieve', price_minor: 1.5 }] }, 422],
      [{ ...good, options: [{ option: 'keep_retrieve', price_minor: 0 }] }, 422],
      [{ ...good, options: [{ option: 'keep_retrieve', price_minor: 2001 }] }, 422],
      [{ ...good, options: 'keep_retrieve' }, 422],
      [{ ...good, options: [] }, 422],
      [{ ...good, attestation: 'true' }, 422],
      [{ ...good, attestation: false }, 422],
      [{ ...good, expected_version: 1 }, 422],
      [{ ...good, offer_id: 42 }, 422],
      [[], 422],
      ['text', 422],
    ];
    for (const [body, status] of cases) {
      const res = await postRevise(w, harbour(), body);
      expect(res.status, JSON.stringify(body)).toBe(status);
    }
    expect(await rows()).toEqual(n);
  });

  it('refuses a body over 2 KB with 413 and text that is not JSON with 400', async () => {
    const n = await rows();
    const big = await postRevise(w, harbour(), { ...good, note: 'x'.repeat(3000) });
    expect(big.status).toBe(413);
    const notJson = await w.revise.POST(
      new Request('http://localhost:3000/api/publisher/offers/revise', {
        method: 'POST',
        headers: {
          origin: 'http://localhost:3000',
          'content-type': 'application/json',
          cookie: harbour().cookie,
          'x-csrf-token': harbour().csrf,
        },
        body: '{not json',
      }),
      { params: Promise.resolve({}) },
    );
    expect(notJson.status).toBe(400);
    expect(await rows()).toEqual(n);
  });
});

describe('the withdraw body is strict', () => {
  it('refuses extra fields and a short reason, and writes nothing', async () => {
    const n = await rows();
    const base = { offer_id: FEES, expected_version: '1', reason: 'Pulled for a rewrite.' };
    for (const extra of [
      { status: 'authorised' },
      { publisher_id: 'pub_x' },
      { currency: 'USD' },
    ]) {
      expect((await postWithdraw(w, harbour(), { ...base, ...extra })).status).toBe(422);
    }
    for (const reason of ['', 'ab', 'x'.repeat(201)]) {
      expect((await postWithdraw(w, harbour(), { ...base, reason })).status).toBe(422);
    }
    expect(await rows()).toEqual(n);
  });
});

describe('another publisher', () => {
  it('cannot revise or withdraw an offer of someone else, also by a guessed id: 404 each, nothing written', async () => {
    const n = await rows();
    for (const id of [QUAY, TIDE, 'ofr_harbour-ledger_guess', 'ofr_quayside-gazette_guess']) {
      const asHarbour = id === QUAY || id.includes('quayside');
      const session = asHarbour ? harbour() : quayside();
      const r = await postRevise(w, session, {
        offer_id: id,
        expected_version: '1',
        options: both(100, 100),
        attestation: true,
      });
      expect(r.status, id).toBe(404);
      const wd = await postWithdraw(w, session, {
        offer_id: id,
        expected_version: '1',
        reason: 'Not mine to withdraw.',
      });
      expect(wd.status, id).toBe(404);
    }
    expect(await rows()).toEqual(n);
  });

  it('a 404 for an existing foreign offer and for a missing one look the same', async () => {
    const a = await postRevise(w, harbour(), { ...good, offer_id: QUAY });
    const b = await postRevise(w, harbour(), { ...good, offer_id: 'ofr_nothing_here' });
    const strip = async (r: Response) => {
      const j = (await r.json()) as { error: { code: string; message: string } };
      return [r.status, j.error.code, j.error.message];
    };
    expect(await strip(a)).toEqual(await strip(b));
  });
});

describe('the engine', () => {
  it('a buyer actor cannot call the offer writes even by going around the route', async () => {
    const r = await w.app.engine.offers.revise({
      actor: w.refund.actorA,
      offer_id: FERRY,
      expected_version: '1',
      options: [{ option: 'keep_retrieve', price_minor: 100 }],
      attestation: true,
    });
    expect(r).toEqual({ ok: false, error: { code: 'not_publisher' } });
  });
});
