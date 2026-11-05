// BR-3 gate round 1: boundary and refusal cases of approval.ts that the mutation run showed were unpinned.
// Tests only; each case names the line of behaviour it pins.
import { afterEach, describe, expect, it } from 'vitest';
import type { Result } from '@umsbx/contracts';
import { requestApproval, verifyApproval } from './index';
import {
  BUYER_A,
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
const ask = (selection: Parameters<typeof requestApproval>[1]['selection'], actor = BUYER_A) =>
  requestApproval(h.deps, { actor: actor as never, selection, consent: CONSENT });

describe('selection refusals', () => {
  it('a proposal owned by another buyer is not_owner', async () => {
    h = await makeHarness();
    await addQuote(h.db, { id: 'quo_1', offer_id: 'ofr_1' });
    await addProposal(h.db, 'prp_b', 'buy_B', [{ quote_id: 'quo_1', offer_id: 'ofr_1' }]);
    expect(await ask({ kind: 'proposal', proposal_id: 'prp_b', offer_ids: ['ofr_1'] })).toEqual({
      ok: false,
      error: { code: 'not_owner' },
    });
  });

  it('an offer id that the proposal has no quote for is unknown_selection', async () => {
    h = await makeHarness();
    await addQuote(h.db, { id: 'quo_1', offer_id: 'ofr_1' });
    await addProposal(h.db, 'prp_a', 'buy_A', [{ quote_id: 'quo_1', offer_id: 'ofr_1' }]);
    expect(
      await ask({ kind: 'proposal', proposal_id: 'prp_a', offer_ids: ['ofr_1', 'ofr_2'] }),
    ).toEqual({ ok: false, error: { code: 'unknown_selection' } });
  });

  it('two offers that map to one quote are unknown_selection, and no row is written', async () => {
    h = await makeHarness();
    await addQuote(h.db, { id: 'quo_1', offer_id: 'ofr_1' });
    await addProposal(h.db, 'prp_dup', 'buy_A', [
      { quote_id: 'quo_1', offer_id: 'ofr_1' },
      { quote_id: 'quo_1', offer_id: 'ofr_2' },
    ]);
    expect(
      await ask({ kind: 'proposal', proposal_id: 'prp_dup', offer_ids: ['ofr_1', 'ofr_2'] }),
    ).toEqual({ ok: false, error: { code: 'unknown_selection' } });
    const n = await h.db.query<{ n: number }>('SELECT count(*)::int AS n FROM approvals');
    expect(n.rows[0]!.n).toBe(0);
  });

  it('six offers are too_many_items and five are allowed', async () => {
    h = await makeHarness();
    const six = ['ofr_1', 'ofr_2', 'ofr_3', 'ofr_5', 'ofr_6', 'ofr_7'];
    for (const [i, offer_id] of six.entries()) {
      await addQuote(h.db, { id: `quo_${i}`, offer_id });
    }
    await addProposal(
      h.db,
      'prp_six',
      'buy_A',
      six.map((offer_id, i) => ({ quote_id: `quo_${i}`, offer_id })),
    );
    expect(await ask({ kind: 'proposal', proposal_id: 'prp_six', offer_ids: six })).toEqual({
      ok: false,
      error: { code: 'too_many_items' },
    });
    const r = await ask({ kind: 'proposal', proposal_id: 'prp_six', offer_ids: six.slice(0, 5) });
    expect(r.ok).toBe(true); // five offers on two publishers is allowed
  });

  it('an operator or publisher actor is not_owner', async () => {
    h = await makeHarness();
    await addQuote(h.db, { id: 'quo_1', offer_id: 'ofr_1' });
    const sel = { kind: 'quote', quote_id: 'quo_1' } as const;
    expect(await ask(sel, { kind: 'operator', operator_id: 'opr_x', mfa: true } as never)).toEqual({
      ok: false,
      error: { code: 'not_owner' },
    });
    expect(await ask(sel, { kind: 'publisher', publisher_id: 'pub_1' } as never)).toEqual({
      ok: false,
      error: { code: 'not_owner' },
    });
  });
});

describe('snapshot order and the corridor minimum', () => {
  it('publishers are sorted by id and items by article id, whatever the selection order', async () => {
    h = await makeHarness();
    await addQuote(h.db, { id: 'quo_1', offer_id: 'ofr_1' });
    await addQuote(h.db, { id: 'quo_2', offer_id: 'ofr_2' });
    await addQuote(h.db, { id: 'quo_3', offer_id: 'ofr_3' });
    const quotes = [
      { quote_id: 'quo_3', offer_id: 'ofr_3' },
      { quote_id: 'quo_2', offer_id: 'ofr_2' },
      { quote_id: 'quo_1', offer_id: 'ofr_1' },
    ];
    await addProposal(h.db, 'prp_rev', 'buy_A', quotes);
    const g = value(
      await ask({
        kind: 'proposal',
        proposal_id: 'prp_rev',
        offer_ids: ['ofr_3', 'ofr_2', 'ofr_1'],
      }),
    );
    expect(g.snapshot.publishers.map((p) => p.publisher_id)).toEqual(['pub_1', 'pub_2']);
    expect(g.snapshot.items.map((i) => i.article_id)).toEqual(['art_1', 'art_2', 'art_3']);
  });

  it('a total equal to the corridor minimum is allowed; one minor unit below is refused', async () => {
    h = await makeHarness();
    await addQuote(h.db, { id: 'quo_1', offer_id: 'ofr_1' }); // 400
    await h.db.query(`UPDATE corridors SET min_charge_minor = 400 WHERE id = 'us-usd'`);
    expect(value(await ask({ kind: 'quote', quote_id: 'quo_1' })).snapshot.total_minor).toBe(400);
    await h.db.query(`UPDATE corridors SET min_charge_minor = 401 WHERE id = 'us-usd'`);
    expect(await ask({ kind: 'quote', quote_id: 'quo_1' })).toEqual({
      ok: false,
      error: { code: 'corridor_unsupported' },
    });
  });
});

describe('verify refusals', () => {
  it('an unknown approval id is ok:false with 404', async () => {
    h = await makeHarness();
    const r = await verifyApproval(h.db, h.deps, {
      approval_id: 'apr_nope',
      token: 'apr_nope.x',
      actor: BUYER_A,
    });
    expect(r.ok).toBe(false);
    expect(r).toEqual({ ok: false, error: { code: 'unknown_approval', http: 404 } });
  });

  it('a stored row whose approval fields fail their schema is snapshot_tampered', async () => {
    h = await makeHarness();
    await addQuote(h.db, { id: 'quo_1', offer_id: 'ofr_1' });
    const g = value(await ask({ kind: 'quote', quote_id: 'quo_1' }));
    // Test-only: the guard is bypassed. created_at moves, so expires_at - created_at is no longer 15 minutes.
    // The snapshot, its hash, the token and the expiry are untouched, so only the ApprovalSchema check catches it.
    await h.db.exec('ALTER TABLE approvals DISABLE TRIGGER approvals_guard');
    await h.db.exec('ALTER TABLE approvals DROP CONSTRAINT approvals_check');
    await h.db.query(
      `UPDATE approvals SET created_at = created_at - interval '1 hour' WHERE id = $1`,
      [g.approval_id],
    );
    await h.db.exec('ALTER TABLE approvals ENABLE TRIGGER approvals_guard');
    expect(
      await verifyApproval(h.db, h.deps, {
        approval_id: g.approval_id,
        token: g.token,
        actor: BUYER_A,
      }),
    ).toEqual({ ok: false, error: { code: 'snapshot_tampered', http: 403 } });
  });
});
