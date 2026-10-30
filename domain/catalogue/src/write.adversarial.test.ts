// PUB-B adversarial tests: a publisher touches only its own offers, also by a guessed id; buyers,
// operators and the system have no publisher writes; extra input fields change nothing (mass assignment).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Actor } from '@umsbx/contracts';
import { getOffer, listOwnOffers, reviseOffer, withdrawOffer, getOwnOffer } from './index';
import { FERRY, QUAY, HALL, count, offersWorld, prices, versionsOf } from './write-support';
import type { OffersWorld } from './write-support';

let w: OffersWorld;
beforeAll(async () => {
  w = await offersWorld();
});
afterAll(async () => {
  await w.db.close();
});

const both = (keep: number, online: number) => [
  { option: 'keep_retrieve' as const, price_minor: keep },
  { option: 'online_read' as const, price_minor: online },
];

const totals = async () => [
  await count(w.db, 'SELECT count(*) AS c FROM offers'),
  await count(w.db, 'SELECT count(*) AS c FROM publisher_authorisations'),
  await count(w.db, "SELECT count(*) AS c FROM audit_log WHERE action LIKE 'offer.%'"),
];

describe('another publisher', () => {
  it('cannot list, read, revise or withdraw an offer of someone else, and cannot tell it exists', async () => {
    const n = await totals();
    const before = await versionsOf(w.db, QUAY);
    // Quayside offer, touched by Harbour; and a guessed id that does not exist.
    const results = [];
    for (const id of [QUAY, 'ofr_quayside-gazette_does-not-exist', 'ofr_nothing']) {
      results.push(
        await reviseOffer(w.deps(), w.harbour, {
          offer_id: id,
          expected_version: '1',
          options: both(100, 100),
          attestation: true,
        }),
        await withdrawOffer(w.deps(), w.harbour, {
          offer_id: id,
          expected_version: '1',
          reason: 'Not mine to withdraw.',
        }),
      );
      expect(await getOwnOffer(w.db, w.harbour, id)).toBeNull();
    }
    // Every answer is the same value: the existing offer and the guessed id look alike.
    for (const r of results) expect(r).toEqual({ ok: false, error: { code: 'not_found' } });
    expect(await totals()).toEqual(n);
    expect(await versionsOf(w.db, QUAY)).toEqual(before);
  });

  it('lists only its own offers', async () => {
    const a = (await listOwnOffers(w.db, w.harbour))!.map((o) => o.offer_id);
    const b = (await listOwnOffers(w.db, w.quayside))!.map((o) => o.offer_id);
    const c = (await listOwnOffers(w.db, w.northfield))!.map((o) => o.offer_id);
    expect(a.every((id) => id.startsWith('ofr_harbour-ledger_'))).toBe(true);
    expect(b.sort()).toEqual([HALL, QUAY].sort());
    expect(c.every((id) => id.startsWith('ofr_northfield-quarterly_'))).toBe(true);
    expect(new Set([...a, ...b, ...c]).size).toBe(a.length + b.length + c.length);
  });

  it('an id with SQL or wildcard characters finds nothing', async () => {
    for (const id of ["' OR 1=1 --", 'ofr_%', 'ofr_quayside-gazette_quay-walk\u0000', '', ' ']) {
      expect(await getOwnOffer(w.db, w.harbour, id)).toBeNull();
      const r = await reviseOffer(w.deps(), w.harbour, {
        offer_id: id,
        expected_version: '1',
        options: both(100, 100),
        attestation: true,
      });
      expect(r.ok).toBe(false);
    }
  });
});

describe('other actor kinds', () => {
  it('a buyer, an operator and the system get no list and no write', async () => {
    const n = await totals();
    const actors: Actor[] = [
      w.buyer,
      w.operator,
      w.system,
      { kind: 'publisher', publisher_id: 'pub_unknown' },
    ];
    for (const actor of actors) {
      const isUnknownPublisher = actor.kind === 'publisher';
      expect(await listOwnOffers(w.db, actor)).toEqual(isUnknownPublisher ? [] : null);
      expect(await getOwnOffer(w.db, actor, FERRY)).toBeNull();
      const rev = await reviseOffer(w.deps(), actor, {
        offer_id: FERRY,
        expected_version: '1',
        options: both(100, 100),
        attestation: true,
      });
      const wd = await withdrawOffer(w.deps(), actor, {
        offer_id: FERRY,
        expected_version: '1',
        reason: 'Not a publisher.',
      });
      const code = isUnknownPublisher ? 'not_found' : 'not_publisher';
      expect(rev, actor.kind).toEqual({ ok: false, error: { code } });
      expect(wd, actor.kind).toEqual({ ok: false, error: { code } });
    }
    expect(await totals()).toEqual(n);
  });
});

describe('mass assignment', () => {
  it('extra fields in the input change nothing but the prices', async () => {
    const before = (await versionsOf(w.db, FERRY))[0]!;
    const input = {
      offer_id: FERRY,
      expected_version: '1',
      options: [
        {
          option: 'keep_retrieve',
          price_minor: 111,
          policy_id: 'evil',
          policy_version: '9',
          currency: 'EUR',
        },
        { option: 'online_read', price_minor: 112 },
      ],
      attestation: true,
      currency: 'EUR',
      publisher_id: w.pubId['quayside-gazette'],
      article_id: 'art_other',
      status: 'draft',
      terms_version: 'terms-evil',
      valid_until: '2020-01-01T00:00:00.000Z',
      superseded_by: 'ofr_x',
      rights: { scope: 'personal_use', ai_scope: 'agent_allowed', redistribution: true },
      affordability: { renegotiation_allowed: true, floor_minor: 1 },
    };
    const r = await reviseOffer(
      w.deps(),
      w.harbour,
      input as unknown as Parameters<typeof reviseOffer>[2],
    );
    expect(r).toEqual({ ok: true, value: { version: '2' } });
    const v2 = (await versionsOf(w.db, FERRY))[1]!;
    expect(v2.currency).toBe(before.currency);
    expect(v2.publisher_id).toBe(before.publisher_id);
    expect(v2.article_id).toBe(before.article_id);
    expect(v2.status).toBe('authorised');
    expect(v2.terms_version).toBe(before.terms_version);
    expect(v2.valid_until).toEqual(before.valid_until);
    expect(v2.superseded_by).toBeNull();
    expect(v2.rights).toEqual(before.rights);
    expect(v2.affordability).toEqual(before.affordability);
    expect(prices(v2.options)).toEqual({ keep_retrieve: 111, online_read: 112 });
    expect(v2.options.map((o) => [o.policy_id, o.policy_version])).toEqual([
      ['keep_retrieve', '1'],
      ['online_read', '1'],
    ]);
    expect(JSON.stringify(v2.options)).not.toContain('evil');
  });

  it('a withdraw cannot carry a status or a publisher either', async () => {
    const v = (await getOffer(w.db, { offer_id: HALL }))!.offer.version;
    const r = await withdrawOffer(w.deps(), w.quayside, {
      offer_id: HALL,
      expected_version: v,
      reason: 'Pulled for the winter.',
      ...({ publisher_id: w.pubId['harbour-ledger'], status: 'authorised' } as object),
    });
    expect(r.ok).toBe(true);
    const last = (await versionsOf(w.db, HALL)).at(-1)!;
    expect(last.status).toBe('withdrawn');
    expect(last.publisher_id).toBe(w.pubId['quayside-gazette']);
  });
});

describe('what the answers carry', () => {
  it('error values hold a code and nothing else', async () => {
    const r = await reviseOffer(w.deps(), w.harbour, {
      offer_id: QUAY,
      expected_version: '1',
      options: both(100, 100),
      attestation: true,
    });
    expect(r).toEqual({ ok: false, error: { code: 'not_found' } });
    expect(JSON.stringify(r)).not.toMatch(/quayside|publisher|price/i);
  });
});
