import { afterEach, describe, expect, it } from 'vitest';
import { APPROVAL_TTL_MS } from '@umsbx/contracts';
import type { Result } from '@umsbx/contracts';
import { contentHash, markUsed, requestApproval, verifyApproval } from './index';
import {
  BUYER_A,
  BUYER_B,
  CONSENT,
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

describe('requestApproval freezes the offer', () => {
  it('snapshot freezes offer id and version, terms, payee, amount, currency, option, policy, rights, reader, rule and pricing versions', async () => {
    h = await makeHarness();
    await addQuote(h.db, { id: 'quo_1', offer_id: 'ofr_1' });
    const g = value(
      await requestApproval(h.deps, { actor: BUYER_A, selection: quote, consent: CONSENT }),
    );
    expect(g.snapshot).toEqual({
      snapshot_version: '1',
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
            version: '1',
            option: 'keep_retrieve',
            window_ms: 432_000_000,
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
    await h.db.query(`UPDATE corridors SET buyer_countries = ARRAY['GB'] WHERE id = 'us-usd'`);
    await addQuote(h.db, { id: 'quo_1', offer_id: 'ofr_1' });
    expect(await go('quo_1')).toBe('corridor_unsupported');
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
