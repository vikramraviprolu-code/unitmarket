import { afterEach, describe, expect, it } from 'vitest';
import { APPROVAL_TTL_MS } from '@umsbx/contracts';
import type { Result } from '@umsbx/contracts';
import { contentHash, markUsed, requestApproval, verifyApproval } from './index';
import {
  BUYER_A,
  BUYER_B,
  CONSENT,
  OFFER_OPTIONS,
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
const quote = { kind: 'quote', quote_id: 'quo_1' } as const;
const BUYER_DE = { kind: 'buyer', buyer_id: 'buy_DE' } as const;
const SEEDED = '2026-10-01T00:00:00Z';

async function addGermanBuyer(db: Harness['db']): Promise<void> {
  await db.query(
    'INSERT INTO buyers (id, display_name, auth_subject, country, created_at, updated_at) VALUES ($1,$2,$3,$4,$5,$5)',
    ['buy_DE', 'D', 'sub-de', 'DE', SEEDED],
  );
}

// A GB publisher with one GBP offer, and the gb-gbp corridor switched on or off. Since 0034 (WW-COR) the row
// already exists (wide, on); the test sets only its switch (it used to insert the narrow GB row, a duplicate key now).
async function addGbpOffer(db: Harness['db'], enabled: boolean): Promise<void> {
  await db.query(`UPDATE corridors SET enabled = $1, updated_at = $2 WHERE id = 'gb-gbp'`, [
    enabled,
    SEEDED,
  ]);
  await db.query(
    `INSERT INTO publishers (id, slug, display_name, country, paypal_merchant_id, payee_verified_at, created_at, updated_at)
     VALUES ('pub_gb','pgb','Publisher gb','GB','MERCHGB',$1,$1,$1)`,
    [SEEDED],
  );
  await db.query(
    `INSERT INTO articles (id, publisher_id, title, abstract, language, topics, published_at, sha256, content_key, bytes, mime, created_at, updated_at)
     VALUES ('art_gb','pub_gb','Title gb','abstract','en',ARRAY['x'],$1,$2,'key-art_gb',10,'text/plain',$1,$1)`,
    [SEEDED, '67'.repeat(32)],
  );
  await db.query(
    `INSERT INTO offers (id, version, publisher_id, article_id, status, currency, options, affordability, terms_version, rights, valid_from, valid_until, superseded_by, created_at, updated_at)
     VALUES ('ofr_gbp','1','pub_gb','art_gb','authorised','GBP',$1,$2,'terms-1',$3,$4,NULL,NULL,$4,$4)`,
    [
      JSON.stringify(OFFER_OPTIONS),
      JSON.stringify({ renegotiation_allowed: false, floor_minor: null }),
      JSON.stringify({ scope: 'personal_use', ai_scope: 'review', redistribution: false }),
      SEEDED,
    ],
  );
}

describe('requestApproval freezes the offer', () => {
  it('snapshot freezes offer id and version, terms, payee, amount, currency, option, policy, rights, reader, rule and pricing versions', async () => {
    h = await makeHarness();
    await addQuote(h.db, { id: 'quo_1', offer_id: 'ofr_1' });
    const g = value(
      await requestApproval(h.deps, { actor: BUYER_A, selection: quote, consent: CONSENT }),
    );
    expect(g.snapshot).toEqual({
      snapshot_version: '2',
      items: [
        {
          article_id: 'art_1',
          article_sha256: '31'.repeat(32),
          offer_id: 'ofr_1',
          offer_version: '1',
          terms_version: 'terms-1',
          publisher_id: 'pub_1',
          payee_merchant_id: 'MERCH1',
          option: 'keep_retrieve',
          policy: {
            id: 'keep_retrieve',
            version: '1+rules',
            option: 'keep_retrieve',
            window_ms: 604_800_000,
            start_rule: 'payment_verified_and_delivery_ready',
          },
          rights: { scope: 'personal_use', ai_scope: 'review', redistribution: false },
          amount_minor: 400,
        },
      ],
      publishers: [
        {
          publisher_id: 'pub_1',
          payee_merchant_id: 'MERCH1',
          amount_minor: 400,
          platform_fee_minor: 0,
        },
      ],
      total_minor: 400,
      currency: 'USD',
      corridor_id: 'us-usd',
      reader: { buyer_id: 'buy_A' },
      rule_version: 'rules-1',
      pricing_rule_version: 'pricing-1',
      terms: {
        rules_version: '1',
        values: { 'refund.request_window': 7, 'access.window': 7, 'mandate.max_days': 90 },
        sources: {
          'refund.request_window': 'default',
          'access.window': 'linked:refund.request_window',
          'mandate.max_days': 'default',
        },
        digest: expect.stringMatching(/^[0-9a-f]{64}$/),
      },
    });
    expect(g.content_hash).toBe(contentHash(g.snapshot));
    expect(g.expires_at).toBe('2026-10-22T10:15:00.000Z');
    expect(Date.parse(g.expires_at) - h.clock.now().getTime()).toBe(APPROVAL_TTL_MS);
    expect(g.token.startsWith(`${g.approval_id}.`)).toBe(true);
    expect(g.approval_id).toMatch(/^apr_/);

    const row = await h.db.query<{
      nonce: string;
      used_at: unknown;
      environment: string;
      buyer_id: string;
    }>('SELECT nonce, used_at, environment, buyer_id FROM approvals WHERE id = $1', [
      g.approval_id,
    ]);
    expect(row.rows[0]).toMatchObject({ used_at: null, environment: 'dryrun', buyer_id: 'buy_A' });
    expect(row.rows[0]!.nonce).toMatch(/^[a-f0-9]{32}$/);
  });

  it('never stores the token or anything that lets a reader of the DB mint one', async () => {
    h = await makeHarness();
    await addQuote(h.db, { id: 'quo_1', offer_id: 'ofr_1' });
    const g = value(
      await requestApproval(h.deps, { actor: BUYER_A, selection: quote, consent: CONSENT }),
    );
    const dump = JSON.stringify((await h.db.query('SELECT * FROM approvals')).rows);
    expect(dump).not.toContain(g.token);
    expect(dump).not.toContain(g.token.split('.')[1]!);
    expect(dump).not.toContain('a'.repeat(32));
  });

  it('platform fee is 0, one publisher block per publisher, items from a proposal of up to five offers', async () => {
    h = await makeHarness();
    const ids: [string, string][] = [
      ['quo_a', 'ofr_1'],
      ['quo_b', 'ofr_2'],
      ['quo_c', 'ofr_3'],
      ['quo_d', 'ofr_5'],
      ['quo_e', 'ofr_6'],
    ];
    for (const [id, offer_id] of ids) await addQuote(h.db, { id, offer_id });
    await addProposal(
      h.db,
      'prp_1',
      'buy_A',
      ids.map(([quote_id, offer_id]) => ({ quote_id, offer_id })),
    );
    const g = value(
      await requestApproval(h.deps, {
        actor: BUYER_A,
        selection: { kind: 'proposal', proposal_id: 'prp_1', offer_ids: ids.map(([, o]) => o) },
        consent: CONSENT,
      }),
    );
    expect(g.snapshot.items).toHaveLength(5);
    expect(
      g.snapshot.publishers.map((p) => [p.publisher_id, p.amount_minor, p.platform_fee_minor]),
    ).toEqual([
      ['pub_1', 800, 0],
      ['pub_2', 1200, 0],
    ]);
    expect(g.snapshot.total_minor).toBe(2000);
  });

  it('a proposal selection may pick a subset of the proposal', async () => {
    h = await makeHarness();
    await addQuote(h.db, { id: 'quo_a', offer_id: 'ofr_1' });
    await addQuote(h.db, { id: 'quo_b', offer_id: 'ofr_3' });
    await addProposal(h.db, 'prp_1', 'buy_A', [
      { quote_id: 'quo_a', offer_id: 'ofr_1' },
      { quote_id: 'quo_b', offer_id: 'ofr_3' },
    ]);
    const g = value(
      await requestApproval(h.deps, {
        actor: BUYER_A,
        selection: { kind: 'proposal', proposal_id: 'prp_1', offer_ids: ['ofr_3'] },
        consent: CONSENT,
      }),
    );
    expect(g.snapshot.items.map((i) => i.offer_id)).toEqual(['ofr_3']);
  });

  it('records the consent in the audit trail; identity_share is recorded, not required', async () => {
    h = await makeHarness();
    await addQuote(h.db, { id: 'quo_1', offer_id: 'ofr_1' });
    const g = value(
      await requestApproval(h.deps, {
        actor: BUYER_A,
        selection: quote,
        consent: { terms: true, identity_share: false },
      }),
    );
    expect(h.audits).toHaveLength(1);
    expect(h.audits[0]).toMatchObject({
      action: 'approval.requested',
      target: g.approval_id,
      actor: BUYER_A,
      detail: { terms: true, identity_share: false, content_hash: g.content_hash },
    });
  });

  it('price change after approval: approval still holds the frozen price', async () => {
    h = await makeHarness();
    await addQuote(h.db, { id: 'quo_1', offer_id: 'ofr_1' });
    const g = value(
      await requestApproval(h.deps, { actor: BUYER_A, selection: quote, consent: CONSENT }),
    );
    // The publisher publishes version 2 at a new price and withdraws version 1.
    await h.db.query(
      `UPDATE offers SET options = $1::jsonb, status = 'withdrawn', superseded_by = 'ofr_1' WHERE id = 'ofr_1' AND version = '1'`,
      [
        JSON.stringify([
          {
            option: 'keep_retrieve',
            price_minor: 9999,
            policy_id: 'keep_retrieve',
            policy_version: '1',
          },
        ]),
      ],
    );
    await h.db.query(`UPDATE quotes SET price_minor = 9999 WHERE id = 'quo_1'`);
    const v = value(
      await verifyApproval(h.db, h.deps, {
        approval_id: g.approval_id,
        token: g.token,
        actor: BUYER_A,
      }),
    );
    expect(v.snapshot.items[0]!.amount_minor).toBe(400);
    expect(v.snapshot.total_minor).toBe(400);
    expect(v.content_hash).toBe(g.content_hash);
    // A new request now sees the changed offer and is refused.
    const again = await requestApproval(h.deps, {
      actor: BUYER_A,
      selection: quote,
      consent: CONSENT,
    });
    expect(code(again)).toBe('offer_changed');
  });
});

describe('requestApproval refusals', () => {
  it('mixed currency refused (A-09)', async () => {
    h = await makeHarness();
    await addQuote(h.db, { id: 'quo_usd', offer_id: 'ofr_1' });
    await addQuote(h.db, {
      id: 'quo_eur',
      offer_id: 'ofr_eur',
      currency: 'EUR',
      corridor_id: 'eu-eur',
    });
    await addProposal(h.db, 'prp_1', 'buy_A', [
      { quote_id: 'quo_usd', offer_id: 'ofr_1' },
      { quote_id: 'quo_eur', offer_id: 'ofr_eur' },
    ]);
    const r = await requestApproval(h.deps, {
      actor: BUYER_A,
      selection: { kind: 'proposal', proposal_id: 'prp_1', offer_ids: ['ofr_1', 'ofr_eur'] },
      consent: CONSENT,
    });
    expect(code(r)).toBe('mixed_currency');
    expect((await h.db.query('SELECT id FROM approvals')).rows).toHaveLength(0);
  });

  it('unverified payee refused', async () => {
    h = await makeHarness();
    await addQuote(h.db, { id: 'quo_u', offer_id: 'ofr_unv' });
    await addQuote(h.db, { id: 'quo_n', offer_id: 'ofr_nom' });
    expect(
      code(
        await requestApproval(h.deps, {
          actor: BUYER_A,
          selection: { kind: 'quote', quote_id: 'quo_u' },
          consent: CONSENT,
        }),
      ),
    ).toBe('publisher_unverified');
    expect(
      code(
        await requestApproval(h.deps, {
          actor: BUYER_A,
          selection: { kind: 'quote', quote_id: 'quo_n' },
          consent: CONSENT,
        }),
      ),
    ).toBe('publisher_unverified');
    // Verification removed after the offer was authorised: refused too.
    await addQuote(h.db, { id: 'quo_1', offer_id: 'ofr_1' });
    await h.db.query(`UPDATE publishers SET payee_verified_at = NULL WHERE id = 'pub_1'`);
    expect(
      code(await requestApproval(h.deps, { actor: BUYER_A, selection: quote, consent: CONSENT })),
    ).toBe('publisher_unverified');
  });

  it('consent: terms required', async () => {
    h = await makeHarness();
    await addQuote(h.db, { id: 'quo_1', offer_id: 'ofr_1' });
    const r = await requestApproval(h.deps, {
      actor: BUYER_A,
      selection: quote,
      consent: { terms: false, identity_share: true },
    });
    expect(code(r)).toBe('consent_missing');
  });

  it('unknown quote, unknown proposal, offer not in the proposal, duplicates, none', async () => {
    h = await makeHarness();
    await addQuote(h.db, { id: 'quo_1', offer_id: 'ofr_1' });
    await addProposal(h.db, 'prp_1', 'buy_A', [{ quote_id: 'quo_1', offer_id: 'ofr_1' }]);
    const go = (selection: Parameters<typeof requestApproval>[1]['selection']) =>
      requestApproval(h.deps, { actor: BUYER_A, selection, consent: CONSENT }).then(code);
    expect(await go({ kind: 'quote', quote_id: 'quo_nope' })).toBe('unknown_selection');
    expect(await go({ kind: 'proposal', proposal_id: 'prp_nope', offer_ids: ['ofr_1'] })).toBe(
      'unknown_selection',
    );
    expect(await go({ kind: 'proposal', proposal_id: 'prp_1', offer_ids: ['ofr_3'] })).toBe(
      'unknown_selection',
    );
    expect(
      await go({ kind: 'proposal', proposal_id: 'prp_1', offer_ids: ['ofr_1', 'ofr_1'] }),
    ).toBe('unknown_selection');
    expect(await go({ kind: 'proposal', proposal_id: 'prp_1', offer_ids: [] })).toBe(
      'unknown_selection',
    );
  });

  it('too many items: six offers refused', async () => {
    h = await makeHarness();
    const r = await requestApproval(h.deps, {
      actor: BUYER_A,
      selection: {
        kind: 'proposal',
        proposal_id: 'prp_1',
        offer_ids: ['o1', 'o2', 'o3', 'o4', 'o5', 'o6'],
      },
      consent: CONSENT,
    });
    expect(code(r)).toBe('too_many_items');
  });

  it('not_owner: another buyer, or a non-buyer actor', async () => {
    h = await makeHarness();
    await addQuote(h.db, { id: 'quo_1', offer_id: 'ofr_1' });
    await addProposal(h.db, 'prp_1', 'buy_A', [{ quote_id: 'quo_1', offer_id: 'ofr_1' }]);
    expect(
      code(await requestApproval(h.deps, { actor: BUYER_B, selection: quote, consent: CONSENT })),
    ).toBe('not_owner');
    expect(
      code(
        await requestApproval(h.deps, {
          actor: BUYER_B,
          selection: { kind: 'proposal', proposal_id: 'prp_1', offer_ids: ['ofr_1'] },
          consent: CONSENT,
        }),
      ),
    ).toBe('not_owner');
    expect(
      code(
        await requestApproval(h.deps, {
          actor: { kind: 'system' },
          selection: quote,
          consent: CONSENT,
        }),
      ),
    ).toBe('not_owner');
    expect(
      code(
        await requestApproval(h.deps, {
          actor: { kind: 'publisher', publisher_id: 'pub_1' },
          selection: quote,
          consent: CONSENT,
        }),
      ),
    ).toBe('not_owner');
  });

  it('an anonymous quote (no buyer yet) may be approved by a signed-in buyer', async () => {
    h = await makeHarness();
    await addQuote(h.db, { id: 'quo_1', offer_id: 'ofr_1', buyer_id: null });
    value(await requestApproval(h.deps, { actor: BUYER_B, selection: quote, consent: CONSENT }));
  });

  it('quote expired at or after expires_at', async () => {
    h = await makeHarness();
    await addQuote(h.db, {
      id: 'quo_1',
      offer_id: 'ofr_1',
      expires_at: '2026-10-22T10:05:00.000Z',
    });
    h.clock.advance(5 * 60_000 - 1);
    value(await requestApproval(h.deps, { actor: BUYER_A, selection: quote, consent: CONSENT }));
    h.clock.advance(1);
    expect(
      code(await requestApproval(h.deps, { actor: BUYER_A, selection: quote, consent: CONSENT })),
    ).toBe('quote_expired');
  });

  it.each([
    ['withdrawn', `UPDATE offers SET status = 'withdrawn'`],
    ['draft', `UPDATE offers SET status = 'draft'`],
    ['superseded', `UPDATE offers SET superseded_by = 'ofr_1'`],
    ['not yet valid', `UPDATE offers SET valid_from = '2026-10-23T00:00:00Z'`],
    ['valid_until passed', `UPDATE offers SET valid_until = '2026-10-22T10:00:00Z'`],
    ['quote price differs from the offer', `UPDATE quotes SET price_minor = 401`],
    ['offer currency differs', `UPDATE offers SET currency = 'EUR'`],
    ['option no longer offered', `UPDATE offers SET options = '[]'::jsonb`],
    ['policy row missing', `DELETE FROM access_policies WHERE id = 'keep_retrieve'`],
  ])('offer_changed: %s', async (_name, sql) => {
    h = await makeHarness();
    await addQuote(h.db, { id: 'quo_1', offer_id: 'ofr_1' });
    await h.db.query(sql);
    const r = await requestApproval(h.deps, { actor: BUYER_A, selection: quote, consent: CONSENT });
    expect(code(r)).toBe('offer_changed');
  });

  it('corridor_unsupported: disabled, unknown, or currency of the corridor differs from the quote', async () => {
    h = await makeHarness();
    await addQuote(h.db, { id: 'quo_off', offer_id: 'ofr_1', corridor_id: 'off-usd' });
    await addQuote(h.db, { id: 'quo_cur', offer_id: 'ofr_1', corridor_id: 'eu-eur' });
    const go = (quote_id: string) =>
      requestApproval(h.deps, {
        actor: BUYER_A,
        selection: { kind: 'quote', quote_id },
        consent: CONSENT,
      }).then(code);
    expect(await go('quo_off')).toBe('corridor_unsupported');
    expect(await go('quo_cur')).toBe('corridor_unsupported');
  });

  // MC2-L1 (D-084 3): the buyer's country is data, not a gate. This replaces the old assertion that a
  // corridor whose buyer_countries lacked the buyer's country gave corridor_unsupported.
  it('buyer country is not a gate: a corridor that lists other buyer countries still approves', async () => {
    h = await makeHarness();
    await h.db.query(`UPDATE corridors SET buyer_countries = ARRAY['GB'] WHERE id = 'us-usd'`);
    await addQuote(h.db, { id: 'quo_1', offer_id: 'ofr_1' });
    const g = value(
      await requestApproval(h.deps, { actor: BUYER_A, selection: quote, consent: CONSENT }),
    );
    expect(g.snapshot.corridor_id).toBe('us-usd');
  });

  // Review fix (MC2-L1): an anonymous quote passes the ownership check, so a buyer id with no buyers row
  // must be refused with a typed code, not reach the INSERT and fail on the foreign key.
  it('a buyer id that does not exist is refused as not_owner, not a thrown error', async () => {
    h = await makeHarness();
    await addQuote(h.db, { id: 'quo_anon', offer_id: 'ofr_1', buyer_id: null });
    const r = await requestApproval(h.deps, {
      actor: { kind: 'buyer', buyer_id: 'buy_GONE' },
      selection: { kind: 'quote', quote_id: 'quo_anon' },
      consent: CONSENT,
    });
    expect(code(r)).toBe('not_owner');
  });

  it('a buyer from DE gets an approval for a USD offer in us-usd (buyer_countries is [*] since 0034)', async () => {
    h = await makeHarness();
    await addGermanBuyer(h.db);
    expect(
      (
        await h.db.query<{ b: string[] }>(
          `SELECT buyer_countries AS b FROM corridors WHERE id = 'us-usd'`,
        )
      ).rows[0]!.b,
    ).toEqual(['*']);
    await addQuote(h.db, { id: 'quo_de', offer_id: 'ofr_1', buyer_id: 'buy_DE' });
    const g = value(
      await requestApproval(h.deps, {
        actor: BUYER_DE,
        selection: { kind: 'quote', quote_id: 'quo_de' },
        consent: CONSENT,
      }),
    );
    expect(g.snapshot.currency).toBe('USD');
    expect(g.snapshot.corridor_id).toBe('us-usd');
    expect(g.snapshot.reader).toEqual({ buyer_id: 'buy_DE' });
    expect(g.snapshot.total_minor).toBe(400);
  });

  it('a buyer from DE gets an approval for a GBP offer in an enabled gb-gbp corridor', async () => {
    h = await makeHarness();
    await addGermanBuyer(h.db);
    await addGbpOffer(h.db, true);
    await addQuote(h.db, {
      id: 'quo_gbp',
      offer_id: 'ofr_gbp',
      buyer_id: 'buy_DE',
      currency: 'GBP',
      corridor_id: 'gb-gbp',
    });
    const g = value(
      await requestApproval(h.deps, {
        actor: BUYER_DE,
        selection: { kind: 'quote', quote_id: 'quo_gbp' },
        consent: CONSENT,
      }),
    );
    expect(g.snapshot.currency).toBe('GBP');
    expect(g.snapshot.corridor_id).toBe('gb-gbp');
    expect(g.snapshot.items[0]!.payee_merchant_id).toBe('MERCHGB');
  });

  it('a disabled gb-gbp corridor still gives corridor_unsupported to a DE buyer', async () => {
    h = await makeHarness();
    await addGermanBuyer(h.db);
    await addGbpOffer(h.db, false);
    await addQuote(h.db, {
      id: 'quo_gbp',
      offer_id: 'ofr_gbp',
      buyer_id: 'buy_DE',
      currency: 'GBP',
      corridor_id: 'gb-gbp',
    });
    const r = await requestApproval(h.deps, {
      actor: BUYER_DE,
      selection: { kind: 'quote', quote_id: 'quo_gbp' },
      consent: CONSENT,
    });
    expect(code(r)).toBe('corridor_unsupported');
  });

  it('a failed request writes no approval and no audit row', async () => {
    h = await makeHarness();
    await addQuote(h.db, { id: 'quo_u', offer_id: 'ofr_unv' });
    await requestApproval(h.deps, {
      actor: BUYER_A,
      selection: { kind: 'quote', quote_id: 'quo_u' },
      consent: CONSENT,
    });
    expect((await h.db.query('SELECT id FROM approvals')).rows).toHaveLength(0);
    expect(h.audits).toHaveLength(0);
  });
});

describe('verifyApproval and markUsed', () => {
  async function granted() {
    h = await makeHarness();
    await addQuote(h.db, { id: 'quo_1', offer_id: 'ofr_1' });
    return value(
      await requestApproval(h.deps, { actor: BUYER_A, selection: quote, consent: CONSENT }),
    );
  }

  it('returns the stored approval for the owner with a good token', async () => {
    const g = await granted();
    const a = value(
      await verifyApproval(h.db, h.deps, {
        approval_id: g.approval_id,
        token: g.token,
        actor: BUYER_A,
      }),
    );
    expect(a).toEqual({
      approval_id: g.approval_id,
      buyer_id: 'buy_A',
      snapshot: g.snapshot,
      content_hash: g.content_hash,
      nonce: expect.stringMatching(/^[a-f0-9]{32}$/) as string,
      created_at: '2026-10-22T10:00:00.000Z',
      expires_at: g.expires_at,
      used_at: null,
      environment: 'dryrun',
    });
  });

  it('expiry at 14:59 valid, 15:00 410', async () => {
    const g = await granted();
    const check = () =>
      verifyApproval(h.db, h.deps, { approval_id: g.approval_id, token: g.token, actor: BUYER_A });
    h.clock.advance(14 * 60_000 + 59_000);
    expect((await check()).ok).toBe(true);
    h.clock.advance(999);
    expect((await check()).ok).toBe(true);
    h.clock.advance(1);
    const r = await check();
    expect(r).toEqual({ ok: false, error: { code: 'expired', http: 410 } });
  });

  it('the 24 h abandonment window is not the approval window: 15 min is the limit', async () => {
    const g = await granted();
    h.clock.advance(APPROVAL_TTL_MS);
    const r = await verifyApproval(h.db, h.deps, {
      approval_id: g.approval_id,
      token: g.token,
      actor: BUYER_A,
    });
    expect(code(r)).toBe('expired');
  });

  it('markUsed sets used_at once; the second call is already_used; verify then answers 409', async () => {
    const g = await granted();
    expect(await markUsed(h.db, h.deps, { approval_id: g.approval_id })).toEqual({
      ok: true,
      value: undefined,
    });
    expect(await markUsed(h.db, h.deps, { approval_id: g.approval_id })).toEqual({
      ok: false,
      error: { code: 'already_used' },
    });
    const r = await verifyApproval(h.db, h.deps, {
      approval_id: g.approval_id,
      token: g.token,
      actor: BUYER_A,
    });
    expect(r).toEqual({ ok: false, error: { code: 'already_used', http: 409 } });
    const row = await h.db.query<{ used_at: Date }>('SELECT used_at FROM approvals WHERE id = $1', [
      g.approval_id,
    ]);
    expect(row.rows[0]!.used_at.toISOString()).toBe('2026-10-22T10:00:00.000Z');
  });

  it('markUsed on an unknown approval is already_used (nothing was claimed)', async () => {
    await granted();
    expect(code(await markUsed(h.db, h.deps, { approval_id: 'apr_nope' }))).toBe('already_used');
  });

  it('unknown approval 404', async () => {
    await granted();
    const r = await verifyApproval(h.db, h.deps, {
      approval_id: 'apr_nope',
      token: 'apr_nope.00',
      actor: BUYER_A,
    });
    expect(r).toEqual({ ok: false, error: { code: 'unknown_approval', http: 404 } });
  });
});
