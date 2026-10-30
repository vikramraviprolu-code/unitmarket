// PUB-B state tests (docs/specs/pub-b-offer-revise-withdraw.md): revise and withdraw write a new offer
// version with its own authorisation row, never an in-place price update; the demo prices (decision 37)
// are applied as audited revisions and are idempotent. Migrated in-memory database, fake clock.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Database, SqlExecutor } from '@umsbx/contracts';
import {
  PUB_ATTEST_1,
  applyDemoPrices,
  checkPrice,
  getOffer,
  listAuthorisedOffers,
  listOwnOffers,
  reviseOffer,
  withdrawOffer,
} from './index';
import {
  CAP,
  DOCK,
  FEES,
  FERRY,
  HALL,
  KNOT,
  QUAY,
  TIDE,
  count,
  offersWorld,
  prices,
  versionsOf,
} from './write-support';
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

describe('checkPrice', () => {
  it('accepts integers from 1 to the cap and says why otherwise', () => {
    expect(checkPrice(1, CAP)).toEqual({ ok: true });
    expect(checkPrice(2000, CAP)).toEqual({ ok: true });
    expect(checkPrice(0, CAP)).toEqual({ ok: false, reason: 'below_one' });
    expect(checkPrice(-5, CAP)).toEqual({ ok: false, reason: 'below_one' });
    expect(checkPrice(2001, CAP)).toEqual({ ok: false, reason: 'above_cap' });
    expect(checkPrice(1.5, CAP)).toEqual({ ok: false, reason: 'not_integer' });
    expect(checkPrice(Number.NaN, CAP)).toEqual({ ok: false, reason: 'not_integer' });
    expect(checkPrice(Number.POSITIVE_INFINITY, CAP)).toEqual({ ok: false, reason: 'not_integer' });
    expect(checkPrice(501, 500)).toEqual({ ok: false, reason: 'above_cap' });
  });
});

describe('reviseOffer', () => {
  it('writes version 2 as a new row, sets superseded_by on version 1 and leaves the other facts alone', async () => {
    const before = await versionsOf(w.db, FERRY);
    expect(before).toHaveLength(1);
    const r = await reviseOffer(w.deps(), w.harbour, {
      offer_id: FERRY,
      expected_version: '1',
      options: both(130, 90),
      attestation: true,
    });
    expect(r).toEqual({ ok: true, value: { version: '2' } });
    const v = await versionsOf(w.db, FERRY);
    expect(v.map((x) => x.version)).toEqual(['1', '2']);
    // The old row keeps its price: no in-place price update.
    expect(prices(v[0]!.options)).toEqual({ keep_retrieve: 125, online_read: 125 });
    expect(v[0]!.superseded_by).not.toBeNull();
    expect(v[1]!.superseded_by).toBeNull();
    expect(v[1]!.status).toBe('authorised');
    expect(prices(v[1]!.options)).toEqual({ keep_retrieve: 130, online_read: 90 });
    // Currency, article, terms, rights, window and affordability never change here.
    for (const k of [
      'currency',
      'article_id',
      'publisher_id',
      'terms_version',
      'rights',
      'affordability',
      'valid_from',
      'valid_until',
    ] as const) {
      expect(v[1]![k], k).toEqual(before[0]![k]);
    }
    // Policy ids and versions are kept for the options that stay.
    expect(v[1]!.options.map((o) => [o.option, o.policy_id, o.policy_version])).toEqual(
      before[0]!.options.map((o) => [o.option, o.policy_id, o.policy_version]),
    );
  });

  it('writes one authorisation row for the new version and one audit row', async () => {
    const auth = await w.db.query<{
      authorised_by: string;
      attestation_version: string | null;
      offer_version: string;
    }>(
      'SELECT authorised_by, attestation_version, offer_version FROM publisher_authorisations WHERE offer_id = $1 ORDER BY offer_version',
      [FERRY],
    );
    expect(auth.rows).toEqual([
      { authorised_by: w.pubId['harbour-ledger'], attestation_version: null, offer_version: '1' },
      {
        authorised_by: w.pubId['harbour-ledger'],
        attestation_version: PUB_ATTEST_1,
        offer_version: '2',
      },
    ]);
    expect(PUB_ATTEST_1).toBe('PUB-ATTEST-1');
    const audit = await w.db.query<{ actor_kind: string; actor_id: string; detail: unknown }>(
      "SELECT actor_kind, actor_id, detail FROM audit_log WHERE action = 'offer.revised' AND target = $1",
      [FERRY],
    );
    expect(audit.rows).toHaveLength(1);
    expect(audit.rows[0]).toMatchObject({
      actor_kind: 'publisher',
      actor_id: w.pubId['harbour-ledger'],
    });
    expect(audit.rows[0]!.detail).toMatchObject({ from_version: '1', to_version: '2' });
  });

  it('the new version is the one buyers see: getOffer and the authorised list', async () => {
    const o = (await getOffer(w.db, { offer_id: FERRY }))!;
    expect(o.offer.version).toBe('2');
    expect(prices(o.offer.options)).toEqual({ keep_retrieve: 130, online_read: 90 });
    const list = await listAuthorisedOffers(w.db, { corridor_id: 'usd_us', limit: 100 });
    const rows = list.filter((x) => x.offer.id === FERRY);
    expect(rows.map((x) => x.offer.version)).toEqual(['2']);
  });

  it('a version 3 follows version 2, and the numbers compare as numbers', async () => {
    const r = await reviseOffer(w.deps(), w.harbour, {
      offer_id: FERRY,
      expected_version: '2',
      options: both(131, 91),
      attestation: true,
    });
    expect(r).toEqual({ ok: true, value: { version: '3' } });
    expect((await getOffer(w.db, { offer_id: FERRY }))!.offer.version).toBe('3');
  });

  it('can offer one option only, and can add the other back later', async () => {
    const one = await reviseOffer(w.deps(), w.harbour, {
      offer_id: KNOT,
      expected_version: '1',
      options: [{ option: 'online_read', price_minor: 300 }],
      attestation: true,
    });
    expect(one).toEqual({ ok: true, value: { version: '2' } });
    expect((await getOffer(w.db, { offer_id: KNOT }))!.offer.options.map((o) => o.option)).toEqual([
      'online_read',
    ]);
    const back = await reviseOffer(w.deps(), w.harbour, {
      offer_id: KNOT,
      expected_version: '2',
      options: [
        { option: 'online_read', price_minor: 300 },
        { option: 'keep_retrieve', price_minor: 350 },
      ],
      attestation: true,
    });
    expect(back).toEqual({ ok: true, value: { version: '3' } });
    const o = (await getOffer(w.db, { offer_id: KNOT }))!.offer;
    expect(o.options.map((x) => [x.option, x.policy_id, x.policy_version])).toEqual([
      ['keep_retrieve', 'keep_retrieve', '1'],
      ['online_read', 'online_read', '1'],
    ]);
  });

  it('refuses a bad price, a bad option set and a missing attestation, and writes nothing', async () => {
    const rows = () => count(w.db, 'SELECT count(*) AS c FROM offers');
    const auths = () => count(w.db, 'SELECT count(*) AS c FROM publisher_authorisations');
    const audits = () =>
      count(w.db, "SELECT count(*) AS c FROM audit_log WHERE action LIKE 'offer.%'");
    const n = [await rows(), await auths(), await audits()];
    const v = (await getOffer(w.db, { offer_id: TIDE }))!.offer.version;
    const base = { offer_id: TIDE, expected_version: v, attestation: true } as const;
    const bad = async (input: Parameters<typeof reviseOffer>[2], code: string) => {
      const r = await reviseOffer(w.deps(), w.harbour, input);
      expect(r, JSON.stringify(input.options)).toEqual({ ok: false, error: { code } });
    };
    await bad({ ...base, options: both(0, 100) }, 'invalid_price');
    await bad({ ...base, options: both(100, 2001) }, 'invalid_price');
    await bad({ ...base, options: both(100, 1.5) }, 'invalid_price');
    await bad({ ...base, options: both(-1, 100) }, 'invalid_price');
    await bad({ ...base, options: both(Number.NaN, 100) }, 'invalid_price');
    await bad(
      { ...base, options: [{ option: 'download' as 'keep_retrieve', price_minor: 100 }] },
      'invalid_options',
    );
    await bad({ ...base, options: [] }, 'invalid_options');
    await bad(
      {
        ...base,
        options: [
          { option: 'online_read', price_minor: 100 },
          { option: 'online_read', price_minor: 200 },
        ],
      },
      'invalid_options',
    );
    await bad({ ...base, options: both(100, 100), attestation: false }, 'attestation_required');
    await bad(
      { ...base, options: both(100, 100), attestation: 'yes' as unknown as boolean },
      'attestation_required',
    );
    expect([await rows(), await auths(), await audits()]).toEqual(n);
  });

  it('the cap comes from the caller: a lower cap refuses a price the default allows', async () => {
    const v = (await getOffer(w.db, { offer_id: TIDE }))!.offer.version;
    const refused = await reviseOffer(w.deps(500), w.harbour, {
      offer_id: TIDE,
      expected_version: v,
      options: both(500, 501),
      attestation: true,
    });
    expect(refused).toEqual({ ok: false, error: { code: 'invalid_price' } });
    const ok = await reviseOffer(w.deps(500), w.harbour, {
      offer_id: TIDE,
      expected_version: v,
      options: both(500, 500),
      attestation: true,
    });
    expect(ok.ok).toBe(true);
  });

  it('a stale expected_version answers conflict and writes nothing', async () => {
    const n = await count(w.db, 'SELECT count(*) AS c FROM offers');
    const r = await reviseOffer(w.deps(), w.harbour, {
      offer_id: FERRY,
      expected_version: '1',
      options: both(100, 100),
      attestation: true,
    });
    expect(r).toEqual({ ok: false, error: { code: 'conflict' } });
    expect(await count(w.db, 'SELECT count(*) AS c FROM offers')).toBe(n);
  });

  it('a second revise from the same base version loses', async () => {
    const base = (await getOffer(w.db, { offer_id: HALL }))!.offer.version;
    const a = await reviseOffer(w.deps(), w.quayside, {
      offer_id: HALL,
      expected_version: base,
      options: both(160, 130),
      attestation: true,
    });
    const b = await reviseOffer(w.deps(), w.quayside, {
      offer_id: HALL,
      expected_version: base,
      options: both(170, 140),
      attestation: true,
    });
    expect(a.ok).toBe(true);
    expect(b).toEqual({ ok: false, error: { code: 'conflict' } });
  });

  it('a suspended publisher cannot revise or withdraw', async () => {
    await w.db.query("UPDATE publishers SET status = 'suspended' WHERE id = $1", [
      w.pubId['quayside-gazette'],
    ]);
    try {
      const v = (await getOffer(w.db, { offer_id: QUAY }))!.offer.version;
      const r = await reviseOffer(w.deps(), w.quayside, {
        offer_id: QUAY,
        expected_version: v,
        options: both(100, 100),
        attestation: true,
      });
      expect(r).toEqual({ ok: false, error: { code: 'publisher_not_active' } });
      const wd = await withdrawOffer(w.deps(), w.quayside, {
        offer_id: QUAY,
        expected_version: v,
        reason: 'Testing a suspended account.',
      });
      expect(wd).toEqual({ ok: false, error: { code: 'publisher_not_active' } });
    } finally {
      await w.db.query("UPDATE publishers SET status = 'active' WHERE id = $1", [
        w.pubId['quayside-gazette'],
      ]);
    }
  });
});

describe('the article freeze of migration 0012 keeps holding', () => {
  it('after a revise the authorised offer still pins the article bytes', async () => {
    const o = (await getOffer(w.db, { offer_id: FERRY }))!;
    await expect(
      w.db.query("UPDATE articles SET sha256 = repeat('0', 64) WHERE id = $1", [o.article.id]),
    ).rejects.toThrow(/cannot change while an authorised offer/);
  });

  it('authorising takes a share lock on the article and an update lock on the offer, before the insert', async () => {
    const seen: string[] = [];
    const spy: Database = {
      dialect: w.db.dialect,
      query: (sql, params) => w.db.query(sql, params),
      exec: (sql) => w.db.exec(sql),
      transaction: (fn) =>
        w.db.transaction((tx: SqlExecutor) =>
          fn({
            query: (sql, params) => {
              seen.push(sql.replace(/\s+/g, ' ').trim());
              return tx.query(sql, params);
            },
            exec: (sql) => tx.exec(sql),
          }),
        ),
    };
    const v = (await getOffer(w.db, { offer_id: FERRY }))!.offer.version;
    const r = await reviseOffer({ ...w.deps(), db: spy }, w.harbour, {
      offer_id: FERRY,
      expected_version: v,
      options: both(140, 95),
      attestation: true,
    });
    expect(r.ok).toBe(true);
    const at = (re: RegExp) => seen.findIndex((s) => re.test(s));
    const offerLock = at(/FROM offers .*FOR UPDATE/);
    const articleLock = at(/FROM articles .*FOR SHARE/);
    const insert = at(/^INSERT INTO offers/);
    expect(offerLock).toBeGreaterThanOrEqual(0);
    expect(articleLock).toBeGreaterThan(offerLock);
    expect(insert).toBeGreaterThan(articleLock);
  });
});

describe('withdrawOffer', () => {
  it('writes a withdrawn version, supersedes the old one and a new buyer finds no live offer', async () => {
    const v = (await getOffer(w.db, { offer_id: TIDE }))!.offer.version;
    const r = await withdrawOffer(w.deps(), w.harbour, {
      offer_id: TIDE,
      expected_version: v,
      reason: 'Pulled for a rewrite.',
    });
    expect(r.ok).toBe(true);
    const versions = await versionsOf(w.db, TIDE);
    const last = versions[versions.length - 1]!;
    expect(last.status).toBe('withdrawn');
    expect(last.superseded_by).toBeNull();
    expect(versions[versions.length - 2]!.superseded_by).not.toBeNull();
    // A new version needs its own authorisation row and an audit row.
    const lastVersion = r.ok ? r.value.version : '';
    expect(
      await count(
        w.db,
        'SELECT count(*) AS c FROM publisher_authorisations WHERE offer_id = $1 AND offer_version = $2',
        [TIDE, lastVersion],
      ),
    ).toBe(1);
    const audit = await w.db.query<{ reason: string }>(
      "SELECT reason FROM audit_log WHERE action = 'offer.withdrawn' AND target = $1",
      [TIDE],
    );
    expect(audit.rows).toEqual([{ reason: 'Pulled for a rewrite.' }]);
    expect((await getOffer(w.db, { offer_id: TIDE }))!.offer.status).toBe('withdrawn');
    const list = await listAuthorisedOffers(w.db, { corridor_id: 'usd_us', limit: 100 });
    expect(list.some((x) => x.offer.id === TIDE)).toBe(false);
  });

  it('refuses a second withdraw, a revise of a withdrawn offer and a stale version', async () => {
    const v = (await getOffer(w.db, { offer_id: TIDE }))!.offer.version;
    expect(
      await withdrawOffer(w.deps(), w.harbour, {
        offer_id: TIDE,
        expected_version: v,
        reason: 'Again, for no reason.',
      }),
    ).toEqual({ ok: false, error: { code: 'withdrawn' } });
    expect(
      await reviseOffer(w.deps(), w.harbour, {
        offer_id: TIDE,
        expected_version: v,
        options: both(100, 100),
        attestation: true,
      }),
    ).toEqual({ ok: false, error: { code: 'withdrawn' } });
    expect(
      await withdrawOffer(w.deps(), w.harbour, {
        offer_id: FERRY,
        expected_version: '1',
        reason: 'Stale version.',
      }),
    ).toEqual({ ok: false, error: { code: 'conflict' } });
  });

  it('needs a reason of 3 to 200 characters', async () => {
    const v = (await getOffer(w.db, { offer_id: FEES }))!.offer.version;
    for (const reason of ['', 'ab', '   ', 'x'.repeat(201)]) {
      expect(
        await withdrawOffer(w.deps(), w.harbour, { offer_id: FEES, expected_version: v, reason }),
      ).toEqual({ ok: false, error: { code: 'invalid_reason' } });
    }
    expect((await getOffer(w.db, { offer_id: FEES }))!.offer.status).toBe('authorised');
  });
});

describe('listOwnOffers', () => {
  it('shows the newest version per offer of the publisher, with status and option prices', async () => {
    const list = (await listOwnOffers(w.db, w.harbour))!;
    const ids = list.map((o) => o.offer_id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toContain(FERRY);
    const ferry = list.find((o) => o.offer_id === FERRY)!;
    expect(ferry.version).toBe('4');
    expect(ferry.status).toBe('authorised');
    expect(prices(ferry.options)).toEqual({ keep_retrieve: 140, online_read: 95 });
    expect(list.find((o) => o.offer_id === TIDE)!.status).toBe('withdrawn');
    expect(list.find((o) => o.offer_id === DOCK)!.status).toBe('withdrawn');
    expect(list.every((o) => o.currency.length === 3 && o.article_title.length > 0)).toBe(true);
    // Only its own offers.
    expect(ids.some((id) => id.startsWith('ofr_quayside'))).toBe(false);
  });
});

describe('applyDemoPrices (decision 37)', () => {
  let dw: OffersWorld;
  beforeAll(async () => {
    dw = await offersWorld();
  });
  afterAll(async () => {
    await dw.db.close();
  });
  const priceOf = async (id: string) =>
    prices((await getOffer(dw.db, { offer_id: id }))!.offer.options);

  it('clamps USD prices into 1.00 to 2.50 and leaves the rest', async () => {
    const gbpBefore = await versionsOf(dw.db, 'ofr_northfield-quarterly_allotment-diary');
    const revised = await applyDemoPrices(dw.deps());
    expect(
      revised
        .map((r) => [r.offer_id, prices(r.from), prices(r.to)])
        .sort((a, b) => a[0]!.toString().localeCompare(b[0]!.toString())),
    ).toEqual(
      [
        [FEES, { keep_retrieve: 300, online_read: 250 }, { keep_retrieve: 250, online_read: 250 }],
        [KNOT, { keep_retrieve: 450, online_read: 450 }, { keep_retrieve: 250, online_read: 250 }],
        [QUAY, { keep_retrieve: 90, online_read: 90 }, { keep_retrieve: 100, online_read: 100 }],
        [TIDE, { keep_retrieve: 40, online_read: 40 }, { keep_retrieve: 100, online_read: 100 }],
      ].sort((a, b) => a[0]!.toString().localeCompare(b[0]!.toString())),
    );
    expect(await priceOf(TIDE)).toEqual({ keep_retrieve: 100, online_read: 100 });
    expect(await priceOf(FEES)).toEqual({ keep_retrieve: 250, online_read: 250 });
    expect(await priceOf(KNOT)).toEqual({ keep_retrieve: 250, online_read: 250 });
    expect(await priceOf(QUAY)).toEqual({ keep_retrieve: 100, online_read: 100 });
    // 120, 125, 150 and 200 stay: untouched offers keep their single version.
    expect(await priceOf(FERRY)).toEqual({ keep_retrieve: 125, online_read: 125 });
    expect(await priceOf(HALL)).toEqual({ keep_retrieve: 150, online_read: 120 });
    expect(await versionsOf(dw.db, FERRY)).toHaveLength(1);
    expect(await versionsOf(dw.db, HALL)).toHaveLength(1);
    // GBP, the withdrawn offer and the draft are untouched.
    expect(await versionsOf(dw.db, 'ofr_northfield-quarterly_allotment-diary')).toEqual(gbpBefore);
    expect(await versionsOf(dw.db, 'ofr_northfield-quarterly_village-bus')).toHaveLength(1);
    expect(await versionsOf(dw.db, DOCK)).toHaveLength(1);
    expect(await versionsOf(dw.db, 'ofr_harbour-ledger_draft-weather-notes')).toHaveLength(1);
  });

  it('each revision is a version with its own authorisation and an audit row with the reason', async () => {
    const audit = await dw.db.query<{ reason: string; actor_kind: string; target: string }>(
      "SELECT reason, actor_kind, target FROM audit_log WHERE action = 'offer.revised' ORDER BY target",
    );
    expect(audit.rows.map((r) => r.target)).toEqual([FEES, KNOT, QUAY, TIDE].sort());
    for (const r of audit.rows) {
      expect(r.reason).toBe('seed: demo prices (decision 37)');
      expect(r.actor_kind).toBe('publisher');
    }
    for (const id of [TIDE, FEES, KNOT, QUAY]) {
      const v = await versionsOf(dw.db, id);
      expect(v.map((x) => x.version)).toEqual(['1', '2']);
      expect(v[0]!.superseded_by).not.toBeNull();
      expect(
        await count(
          dw.db,
          'SELECT count(*) AS c FROM publisher_authorisations WHERE offer_id = $1 AND offer_version = $2',
          [id, '2'],
        ),
      ).toBe(1);
    }
  });

  it('a second run revises nothing', async () => {
    const offers = await count(dw.db, 'SELECT count(*) AS c FROM offers');
    const auths = await count(dw.db, 'SELECT count(*) AS c FROM publisher_authorisations');
    const audits = await count(dw.db, 'SELECT count(*) AS c FROM audit_log');
    expect(await applyDemoPrices(dw.deps())).toEqual([]);
    expect(await count(dw.db, 'SELECT count(*) AS c FROM offers')).toBe(offers);
    expect(await count(dw.db, 'SELECT count(*) AS c FROM publisher_authorisations')).toBe(auths);
    expect(await count(dw.db, 'SELECT count(*) AS c FROM audit_log')).toBe(audits);
  });

  it('a publisher edit made after the demo step is not undone by a later boot', async () => {
    const v = (await getOffer(dw.db, { offer_id: TIDE }))!.offer.version;
    const r = await reviseOffer(dw.deps(), dw.harbour, {
      offer_id: TIDE,
      expected_version: v,
      options: both(500, 600),
      attestation: true,
    });
    expect(r.ok).toBe(true);
    // 5.00 and 6.00 are outside 1.00 to 2.50, so the clamp would move them: it must not, because the
    // offer's history already holds the demo revision (it ran once for this offer).
    expect(await applyDemoPrices(dw.deps())).toEqual([]);
    expect(await priceOf(TIDE)).toEqual({ keep_retrieve: 500, online_read: 600 });
  });
});

describe('applyDemoPrices respects a publisher who already changed the offer', () => {
  it('an offer revised before the demo step is not clamped', async () => {
    const x = await offersWorld();
    try {
      const r = await reviseOffer(x.deps(), x.quayside, {
        offer_id: HALL,
        expected_version: '1',
        options: both(900, 900),
        attestation: true,
      });
      expect(r.ok).toBe(true);
      const revised = await applyDemoPrices(x.deps());
      expect(revised.map((v) => v.offer_id).sort()).toEqual([FEES, KNOT, QUAY, TIDE].sort());
      expect(prices((await getOffer(x.db, { offer_id: HALL }))!.offer.options)).toEqual({
        keep_retrieve: 900,
        online_read: 900,
      });
    } finally {
      await x.db.close();
    }
  });
});
