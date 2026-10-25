// DP-1 (MVP-D): composite snapshot gates. Two publishers freeze a per-publisher settlement route
// inside the hash; one publisher is built exactly as before; a third publisher, an unverified
// payee (P18, D-04) and a second currency (D-07) are refused before any approval row is written.
// Synthetic rows and fake payee ids only (SBXPAYEE...); no real merchant id.
import { afterEach, describe, expect, it } from 'vitest';
import type { Result, SqlExecutor } from '@umsbx/contracts';
import { contentHash, requestApproval, verifyApproval } from './index';
import {
  BUYER_A,
  CONSENT,
  OFFER_OPTIONS,
  SEED_TIME,
  addProposal,
  addQuote,
  makeHarness,
  type Harness,
} from './test-fixtures';

let h: Harness;
afterEach(async () => {
  await h.db.close();
});

function value<T, E>(r: Result<T, E>): T {
  if (!r.ok) throw new Error(`expected ok, got ${JSON.stringify(r.error)}`);
  return r.value;
}
function code<T, E extends { code: string }>(r: Result<T, E>): string {
  if (r.ok) throw new Error('expected an error');
  return r.error.code;
}

const HARBOUR_PAYEE = 'SBXPAYEEHARBOUR1';
const QUAYSIDE_PAYEE = 'SBXPAYEEQUAYSIDE2';

async function ins(db: SqlExecutor, table: string, row: Record<string, unknown>): Promise<void> {
  const r: Record<string, unknown> = { created_at: SEED_TIME, updated_at: SEED_TIME, ...row };
  const cols = Object.keys(r);
  await db.query(
    `INSERT INTO ${table} (${cols.join(', ')}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(', ')})`,
    cols.map((c) => r[c]),
  );
}

// Harbour = pub_1 (offers ofr_1, ofr_2; USD). Quayside = pub_q (offer ofr_q1, 150; USD).
// Northfield = pub_n (offer ofr_n1; GBP). Third = pub_3 (offer ofr_31; USD).
async function world(opts: { quaysideMerchant?: string | null; quaysideVerified?: boolean } = {}) {
  h = await makeHarness();
  await h.db.query(`UPDATE publishers SET paypal_merchant_id = $1 WHERE id = 'pub_1'`, [
    HARBOUR_PAYEE,
  ]);
  const merchant = opts.quaysideMerchant === undefined ? QUAYSIDE_PAYEE : opts.quaysideMerchant;
  const verified = opts.quaysideVerified === false ? null : SEED_TIME;
  const pubs: [string, string, string, string | null, string | null][] = [
    ['pub_q', 'quayside-gazette', 'US', merchant, verified],
    ['pub_n', 'northfield-quarterly', 'GB', 'SBXPAYEENORTHFIELD3', SEED_TIME],
    ['pub_3', 'third-press', 'US', 'SBXPAYEETHIRD4', SEED_TIME],
  ];
  for (const [id, slug, country, paypal_merchant_id, payee_verified_at] of pubs) {
    await ins(h.db, 'publishers', {
      id,
      slug,
      display_name: `Publisher ${slug}`,
      country,
      paypal_merchant_id,
      payee_verified_at,
    });
  }
  const arts: [string, string][] = [
    ['art_q1', 'pub_q'],
    ['art_n1', 'pub_n'],
    ['art_31', 'pub_3'],
  ];
  for (const [id, publisher_id] of arts) {
    await ins(h.db, 'articles', {
      id,
      publisher_id,
      title: `Title ${id}`,
      abstract: 'abstract',
      language: 'en',
      topics: ['x'],
      published_at: SEED_TIME,
      sha256: id
        .charCodeAt(id.length - 1)
        .toString(16)
        .padStart(2, '0')
        .repeat(32),
      content_key: `key-${id}`,
      bytes: 10,
      mime: 'text/plain',
    });
  }
  const offers: [string, string, string, string][] = [
    ['ofr_q1', 'art_q1', 'pub_q', 'USD'],
    ['ofr_n1', 'art_n1', 'pub_n', 'GBP'],
    ['ofr_31', 'art_31', 'pub_3', 'USD'],
  ];
  for (const [id, article_id, publisher_id, currency] of offers) {
    await ins(h.db, 'offers', {
      id,
      version: '1',
      publisher_id,
      article_id,
      status: 'authorised',
      currency,
      options: JSON.stringify(OFFER_OPTIONS),
      affordability: JSON.stringify({ renegotiation_allowed: false, floor_minor: null }),
      terms_version: 'terms-1',
      rights: JSON.stringify({ scope: 'personal_use', ai_scope: 'review', redistribution: false }),
      valid_from: SEED_TIME,
      valid_until: null,
      superseded_by: null,
    });
  }
}

async function propose(
  offers: [offer_id: string, currency?: string | undefined, corridor?: string | undefined][],
) {
  const quotes: { quote_id: string; offer_id: string }[] = [];
  let n = 0;
  for (const [offer_id, currency, corridor_id] of offers) {
    n += 1;
    const quote_id = `quo_c${n}`;
    await addQuote(h.db, {
      id: quote_id,
      offer_id,
      ...(currency === undefined ? {} : { currency }),
      ...(corridor_id === undefined ? {} : { corridor_id }),
    });
    quotes.push({ quote_id, offer_id });
  }
  await addProposal(h.db, 'prp_c', 'buy_A', quotes);
  return {
    kind: 'proposal',
    proposal_id: 'prp_c',
    offer_ids: offers.map(([offer_id]) => offer_id),
  } as const;
}
const request = (selection: Awaited<ReturnType<typeof propose>>) =>
  requestApproval(h.deps, { actor: BUYER_A, selection, consent: CONSENT });
const approvalRows = async (): Promise<number> =>
  (await h.db.query<{ n: number }>('SELECT count(*)::int AS n FROM approvals')).rows[0]!.n;

// The content_hash of the one-publisher fixture below, computed by the code before DP-1 (commit
// 22670d2). It must not change: a single-publisher snapshot carries no `settlement`.
const PRE_CHANGE_SINGLE_HASH = 'e7d26637d339e8aed70062864e7ac5266054dd9751fac3da44620fe3f65d1b80';

describe('composite snapshot (DP-1, D-04, D-07, P5)', () => {
  it('two publishers, USD: settlement per_publisher, payments 2, two blocks with their own payee and amount, total = sum', async () => {
    await world();
    const g = value(await request(await propose([['ofr_1'], ['ofr_q1']])));
    expect(g.snapshot.settlement).toEqual({ route: 'per_publisher', payments: 2 });
    expect(g.snapshot.publishers).toEqual([
      {
        publisher_id: 'pub_1',
        payee_merchant_id: HARBOUR_PAYEE,
        amount_minor: 400,
        platform_fee_minor: 0,
      },
      {
        publisher_id: 'pub_q',
        payee_merchant_id: QUAYSIDE_PAYEE,
        amount_minor: 400,
        platform_fee_minor: 0,
      },
    ]);
    expect(g.snapshot.items.map((i) => [i.publisher_id, i.payee_merchant_id])).toEqual([
      ['pub_1', HARBOUR_PAYEE],
      ['pub_q', QUAYSIDE_PAYEE],
    ]);
    expect(g.snapshot.total_minor).toBe(
      g.snapshot.publishers.reduce((sum, p) => sum + p.amount_minor, 0),
    );
    expect(g.snapshot.total_minor).toBe(800);
    // The settlement is inside the hash and inside the stored row.
    expect(g.content_hash).toBe(contentHash(g.snapshot));
    const without: Record<string, unknown> = { ...g.snapshot };
    delete without['settlement'];
    expect(contentHash(without as typeof g.snapshot)).not.toBe(g.content_hash);
    const stored = await h.db.query<{ snapshot: { settlement?: unknown } }>(
      'SELECT snapshot FROM approvals WHERE id = $1',
      [g.approval_id],
    );
    expect(stored.rows[0]!.snapshot.settlement).toEqual({ route: 'per_publisher', payments: 2 });
    expect((await verifyApproval(h.db, h.deps, { ...g, actor: BUYER_A })).ok).toBe(true);
  });

  it('two publishers, several items: still payments 2, one block per publisher', async () => {
    await world();
    const g = value(await request(await propose([['ofr_1'], ['ofr_2'], ['ofr_q1']])));
    expect(g.snapshot.settlement).toEqual({ route: 'per_publisher', payments: 2 });
    expect(g.snapshot.items).toHaveLength(3);
    expect(g.snapshot.publishers.map((p) => [p.publisher_id, p.amount_minor])).toEqual([
      ['pub_1', 800],
      ['pub_q', 400],
    ]);
  });

  it('one publisher: no settlement, content_hash equal to the pre-change hash of the same fixture', async () => {
    await world();
    const g = value(await request(await propose([['ofr_1']])));
    expect(Object.keys(g.snapshot)).not.toContain('settlement');
    expect(g.snapshot.settlement).toBeUndefined();
    expect(g.content_hash).toBe(PRE_CHANGE_SINGLE_HASH);
    expect(contentHash(g.snapshot)).toBe(PRE_CHANGE_SINGLE_HASH);
    const stored = await h.db.query<{ snapshot: Record<string, unknown> }>(
      'SELECT snapshot FROM approvals WHERE id = $1',
      [g.approval_id],
    );
    expect(Object.keys(stored.rows[0]!.snapshot)).not.toContain('settlement');
  });

  it('one publisher with two items: still no settlement', async () => {
    await world();
    const g = value(await request(await propose([['ofr_1'], ['ofr_2']])));
    expect(g.snapshot.publishers).toHaveLength(1);
    expect(g.snapshot.items).toHaveLength(2);
    expect(Object.keys(g.snapshot)).not.toContain('settlement');
  });

  it('three publishers: too_many_publishers, no approval row', async () => {
    await world();
    const r = await request(await propose([['ofr_1'], ['ofr_q1'], ['ofr_31']]));
    expect(code(r)).toBe('too_many_publishers');
    expect(await approvalRows()).toBe(0);
    expect(h.audits).toEqual([]);
  });

  it('three publishers among five items: still too_many_publishers', async () => {
    await world();
    const r = await request(
      await propose([['ofr_1'], ['ofr_2'], ['ofr_q1'], ['ofr_3'], ['ofr_31']]),
    );
    expect(code(r)).toBe('too_many_publishers');
    expect(await approvalRows()).toBe(0);
  });

  it('error order: mixed_currency and publisher_unverified come before too_many_publishers', async () => {
    await world();
    // three publishers, one of them in GBP: mixed_currency
    const mixed = await propose([['ofr_1'], ['ofr_q1'], ['ofr_n1', 'GBP']]);
    expect(code(await request(mixed))).toBe('mixed_currency');
    expect(await approvalRows()).toBe(0);
    await h.db.close();
    // three publishers, the third unverified: publisher_unverified
    await world();
    await h.db.query(`UPDATE publishers SET payee_verified_at = NULL WHERE id = 'pub_3'`);
    const unverified = await propose([['ofr_1'], ['ofr_q1'], ['ofr_31']]);
    expect(code(await request(unverified))).toBe('publisher_unverified');
    expect(await approvalRows()).toBe(0);
  });

  it('D-04 Quayside has no payee_verified_at: publisher_unverified, no row', async () => {
    await world({ quaysideVerified: false });
    const r = await request(await propose([['ofr_1'], ['ofr_q1']]));
    expect(code(r)).toBe('publisher_unverified');
    expect(await approvalRows()).toBe(0);
  });

  it('D-04 Quayside has no merchant id: publisher_unverified', async () => {
    await world({ quaysideMerchant: null });
    const r = await request(await propose([['ofr_1'], ['ofr_q1']]));
    expect(code(r)).toBe('publisher_unverified');
    expect(await approvalRows()).toBe(0);
  });

  it('D-04 the one-publisher path for the unverified publisher is refused too', async () => {
    await world({ quaysideVerified: false });
    const r = await request(await propose([['ofr_q1']]));
    expect(code(r)).toBe('publisher_unverified');
    expect(await approvalRows()).toBe(0);
  });

  it('D-07 Harbour (USD) plus Northfield (GBP): mixed_currency, no row', async () => {
    await world();
    const sel = await propose([['ofr_1'], ['ofr_n1', 'GBP']]);
    expect(code(await request(sel))).toBe('mixed_currency');
    expect(await approvalRows()).toBe(0);
  });

  it('D-07 the other order (GBP first) is mixed_currency as well', async () => {
    await world();
    const sel = await propose([['ofr_n1', 'GBP'], ['ofr_1']]);
    expect(code(await request(sel))).toBe('mixed_currency');
    expect(await approvalRows()).toBe(0);
  });

  it('D-07 two publishers in two corridors with one currency: corridor_unsupported, no row', async () => {
    await world();
    const sel = await propose([['ofr_1'], ['ofr_q1', undefined, 'eu-eur']]);
    expect(code(await request(sel))).toBe('corridor_unsupported');
    expect(await approvalRows()).toBe(0);
  });

  describe('a stored composite snapshot that changes after approval', () => {
    async function edit(id: string, mutate: (s: Record<string, unknown>) => void) {
      const row = await h.db.query<{ snapshot: Record<string, unknown> }>(
        'SELECT snapshot FROM approvals WHERE id = $1',
        [id],
      );
      const s = structuredClone(row.rows[0]!.snapshot);
      mutate(s);
      // Test-only: the immutability trigger is bypassed to simulate an attacker with DB write access.
      await h.db.exec('ALTER TABLE approvals DISABLE TRIGGER approvals_guard');
      await h.db.query('UPDATE approvals SET snapshot = $1::jsonb WHERE id = $2', [
        JSON.stringify(s),
        id,
      ]);
      await h.db.exec('ALTER TABLE approvals ENABLE TRIGGER approvals_guard');
    }
    const verify = (g: { approval_id: string; token: string }) =>
      verifyApproval(h.db, h.deps, { approval_id: g.approval_id, token: g.token, actor: BUYER_A });

    it('changing payments in a stored snapshot: snapshot_tampered at verify', async () => {
      await world();
      const g = value(await request(await propose([['ofr_1'], ['ofr_q1']])));
      expect((await verify(g)).ok).toBe(true);
      await edit(g.approval_id, (s) => {
        (s['settlement'] as { payments: number }).payments = 3;
      });
      expect(await verify(g)).toEqual({
        ok: false,
        error: { code: 'snapshot_tampered', http: 403 },
      });
    });

    it('removing the settlement from a stored composite: snapshot_tampered (the hash covers it)', async () => {
      await world();
      const g = value(await request(await propose([['ofr_1'], ['ofr_q1']])));
      await edit(g.approval_id, (s) => {
        delete s['settlement'];
      });
      expect(await verify(g)).toEqual({
        ok: false,
        error: { code: 'snapshot_tampered', http: 403 },
      });
    });

    it('adding a settlement to a stored one-publisher snapshot: snapshot_tampered', async () => {
      await world();
      const g = value(await request(await propose([['ofr_1']])));
      await edit(g.approval_id, (s) => {
        s['settlement'] = { route: 'per_publisher', payments: 2 };
      });
      expect(await verify(g)).toEqual({
        ok: false,
        error: { code: 'snapshot_tampered', http: 403 },
      });
    });
  });
});
