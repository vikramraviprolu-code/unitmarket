// BR-3: the business terms are resolved inside requestApproval and frozen into the snapshot (version 2).
// A later rule change never alters a stored snapshot.
import { afterEach, describe, expect, it } from 'vitest';
import { resolveTerms } from '@umsbx/rules';
import type { Result } from '@umsbx/contracts';
import { requestApproval, verifyApproval } from './index';
import {
  BUYER_A,
  CONSENT,
  addProposal,
  addQuote,
  makeHarness,
  setRule,
  T0,
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
const DAY = 86_400_000;
const quote = { kind: 'quote', quote_id: 'quo_1' } as const;

async function one() {
  h = await makeHarness();
  await addQuote(h.db, { id: 'quo_1', offer_id: 'ofr_1' });
  return h;
}
async function grant(selection: Parameters<typeof requestApproval>[1]['selection'] = quote) {
  return value(await requestApproval(h.deps, { actor: BUYER_A, selection, consent: CONSENT }));
}
async function pack(order: string[]) {
  await addProposal(h.db, 'prp_1', 'buy_A', [
    { quote_id: 'quo_1', offer_id: 'ofr_1' },
    { quote_id: 'quo_3', offer_id: 'ofr_3' },
  ]);
  return grant({ kind: 'proposal', proposal_id: 'prp_1', offer_ids: order });
}
async function twoPublishers() {
  h = await makeHarness();
  await addQuote(h.db, { id: 'quo_1', offer_id: 'ofr_1' });
  await addQuote(h.db, { id: 'quo_3', offer_id: 'ofr_3' });
}

describe('terms frozen at approval (BR-3)', () => {
  it('with no override rows: refund 7, access 7 (linked), mandate 90; the item window is 7 days and labelled', async () => {
    await one();
    const g = await grant();
    expect(g.snapshot.snapshot_version).toBe('2');
    if (g.snapshot.snapshot_version !== '2') throw new Error('version');
    expect(g.snapshot.terms.rules_version).toBe('1');
    expect(g.snapshot.terms.values).toEqual({
      'refund.request_window': 7,
      'access.window': 7,
      'mandate.max_days': 90,
    });
    expect(g.snapshot.terms.sources).toEqual({
      'refund.request_window': 'default',
      'access.window': 'linked:refund.request_window',
      'mandate.max_days': 'default',
    });
    const policy = g.snapshot.items[0]!.policy;
    expect(policy.window_ms).toBe(604_800_000);
    expect(policy.id).toBe('keep_retrieve');
    expect(policy.version).toBe('1+rules');
  });

  it('the stored row holds version 2 and its content hash covers the terms', async () => {
    await one();
    const g = await grant();
    const r = await h.db.query<{ snapshot: { terms?: unknown; snapshot_version: string } }>(
      'SELECT snapshot FROM approvals WHERE id = $1',
      [g.approval_id],
    );
    const stored = r.rows[0]!.snapshot;
    expect(stored.snapshot_version).toBe('2');
    expect(stored.terms).toEqual(g.snapshot.snapshot_version === '2' ? g.snapshot.terms : null);
    const { contentHash } = await import('./index');
    const changed = structuredClone(g.snapshot);
    if (changed.snapshot_version !== '2') throw new Error('version');
    changed.terms.values['refund.request_window'] = 8;
    changed.terms.values['access.window'] = 8;
    expect(contentHash(changed)).not.toBe(g.content_hash);
  });

  it('a seller row of 14 days raises both the refund window and the access window', async () => {
    await one();
    await setRule(h.db, {
      id: 'rls_s14',
      rule_key: 'refund.request_window',
      scope_kind: 'seller',
      scope_id: 'pub_1',
      value: 14,
    });
    const g = await grant();
    if (g.snapshot.snapshot_version !== '2') throw new Error('version');
    expect(g.snapshot.terms.values['refund.request_window']).toBe(14);
    expect(g.snapshot.terms.values['access.window']).toBe(14);
    expect(g.snapshot.terms.sources['refund.request_window']).toBe('seller:pub_1@rls_s14');
    expect(g.snapshot.terms.sources['access.window']).toBe('linked:refund.request_window');
    expect(g.snapshot.items[0]!.policy.window_ms).toBe(14 * DAY);
  });

  it('a row for another seller or another buyer changes nothing', async () => {
    await one();
    await setRule(h.db, {
      id: 'rls_o1',
      rule_key: 'refund.request_window',
      scope_kind: 'seller',
      scope_id: 'pub_2',
      value: 20,
    });
    await setRule(h.db, {
      id: 'rls_o2',
      rule_key: 'mandate.max_days',
      scope_kind: 'buyer',
      scope_id: 'buy_B',
      value: 10,
    });
    const g = await grant();
    if (g.snapshot.snapshot_version !== '2') throw new Error('version');
    expect(g.snapshot.terms.values).toEqual({
      'refund.request_window': 7,
      'access.window': 7,
      'mandate.max_days': 90,
    });
  });

  it('the access window is never made shorter: a platform access of 3 days with refund 0 keeps the 5-day policy', async () => {
    await one();
    await setRule(h.db, {
      id: 'rls_r0',
      rule_key: 'refund.request_window',
      scope_kind: 'platform',
      scope_id: null,
      value: 0,
    });
    await setRule(h.db, {
      id: 'rls_a3',
      rule_key: 'access.window',
      scope_kind: 'platform',
      scope_id: null,
      value: 3,
    });
    const g = await grant();
    if (g.snapshot.snapshot_version !== '2') throw new Error('version');
    expect(g.snapshot.terms.values['access.window']).toBe(3);
    const policy = g.snapshot.items[0]!.policy;
    expect(policy.window_ms).toBe(432_000_000);
    expect(policy.version).toBe('1');
  });

  it('a platform row added after the approval leaves verify ok and the stored terms unchanged', async () => {
    await one();
    const g = await grant();
    await setRule(h.db, {
      id: 'rls_late',
      rule_key: 'refund.request_window',
      scope_kind: 'platform',
      scope_id: null,
      value: 30,
    });
    const v = await verifyApproval(h.db, h.deps, {
      approval_id: g.approval_id,
      token: g.token,
      actor: BUYER_A,
    });
    const approval = value(v);
    expect(approval.snapshot).toEqual(g.snapshot);
    if (approval.snapshot.snapshot_version !== '2') throw new Error('version');
    expect(approval.snapshot.terms.values['refund.request_window']).toBe(7);
  });

  it('a rule added before a second approval is included in that one only', async () => {
    await one();
    const first = await grant();
    await setRule(h.db, {
      id: 'rls_new',
      rule_key: 'refund.request_window',
      scope_kind: 'platform',
      scope_id: null,
      value: 21,
    });
    const second = await grant();
    if (first.snapshot.snapshot_version !== '2' || second.snapshot.snapshot_version !== '2') {
      throw new Error('version');
    }
    expect(first.snapshot.terms.values['refund.request_window']).toBe(7);
    expect(second.snapshot.terms.values['refund.request_window']).toBe(21);
    expect(second.snapshot.terms.values['access.window']).toBe(21);
  });

  it('two publishers merge per key by its strategy, whatever the selection order', async () => {
    await twoPublishers();
    // pub_1: refund 10, access 20. pub_2: refund 14, access 9 (raised to 14 by the link rule).
    const rows = [
      ['rls_1r', 'refund.request_window', 'pub_1', 10],
      ['rls_1a', 'access.window', 'pub_1', 20],
      ['rls_2r', 'refund.request_window', 'pub_2', 14],
      ['rls_2a', 'access.window', 'pub_2', 9],
    ] as const;
    for (const [id, rule_key, scope_id, v] of rows) {
      await setRule(h.db, { id, rule_key, scope_kind: 'seller', scope_id, value: v });
    }
    await setRule(h.db, {
      id: 'rls_bm',
      rule_key: 'mandate.max_days',
      scope_kind: 'buyer',
      scope_id: 'buy_A',
      value: 30,
    });
    const forward = await pack(['ofr_1', 'ofr_3']);
    const backward = await pack(['ofr_3', 'ofr_1']);
    if (forward.snapshot.snapshot_version !== '2' || backward.snapshot.snapshot_version !== '2') {
      throw new Error('version');
    }
    expect(forward.snapshot.terms.values).toEqual({
      'refund.request_window': 14,
      'access.window': 20,
      'mandate.max_days': 30,
    });
    expect(forward.snapshot.terms.sources['refund.request_window']).toBe('seller:pub_2@rls_2r');
    expect(forward.snapshot.terms.sources['access.window']).toBe('seller:pub_1@rls_1a');
    expect(backward.snapshot.terms).toEqual(forward.snapshot.terms);
    expect(forward.snapshot.items.map((i) => i.policy.window_ms)).toEqual([20 * DAY, 20 * DAY]);
    expect(forward.snapshot.publishers).toHaveLength(2);
  });

  it('two publishers: the link rule runs again after the merge', async () => {
    await twoPublishers();
    // pub_1 refund 25 (access linked to 25); pub_2 access 6 only. Merged access is at least the merged refund.
    await setRule(h.db, {
      id: 'rls_1r',
      rule_key: 'refund.request_window',
      scope_kind: 'seller',
      scope_id: 'pub_1',
      value: 25,
    });
    await setRule(h.db, {
      id: 'rls_2a',
      rule_key: 'access.window',
      scope_kind: 'seller',
      scope_id: 'pub_2',
      value: 6,
    });
    const g = await pack(['ofr_1', 'ofr_3']);
    if (g.snapshot.snapshot_version !== '2') throw new Error('version');
    const v = g.snapshot.terms.values;
    expect(v['refund.request_window']).toBe(25);
    expect(v['access.window']).toBeGreaterThanOrEqual(v['refund.request_window']);
  });

  it('refuses with terms_invalid when the resolver fails closed (a stored value outside its range)', async () => {
    await one();
    await setRule(h.db, {
      id: 'rls_bad',
      rule_key: 'refund.request_window',
      scope_kind: 'platform',
      scope_id: null,
      value: 99,
    });
    const r = await requestApproval(h.deps, { actor: BUYER_A, selection: quote, consent: CONSENT });
    expect(r).toEqual({ ok: false, error: { code: 'terms_invalid' } });
    const n = await h.db.query<{ n: number }>('SELECT count(*)::int AS n FROM approvals');
    expect(n.rows[0]!.n).toBe(0);
  });
});

describe('terms digest pin (BR-3)', () => {
  it('the same inputs give the same digest in two runs, equal to the resolver digest', async () => {
    await one();
    const a = await grant();
    await h.db.close();
    await one();
    const b = await grant();
    if (a.snapshot.snapshot_version !== '2' || b.snapshot.snapshot_version !== '2') {
      throw new Error('version');
    }
    expect(a.snapshot.terms.digest).toBe(b.snapshot.terms.digest);
    const resolved = value(
      resolveTerms(
        { seller_id: 'pub_1', buyer_id: 'buy_A', category: null },
        [],
        new Date(T0).toISOString(),
      ),
    );
    expect(a.snapshot.terms.digest).toBe(resolved.digest);
  });

  it('a different value gives a different digest', async () => {
    await one();
    const a = await grant();
    await setRule(h.db, {
      id: 'rls_x',
      rule_key: 'refund.request_window',
      scope_kind: 'platform',
      scope_id: null,
      value: 9,
    });
    const b = await grant();
    if (a.snapshot.snapshot_version !== '2' || b.snapshot.snapshot_version !== '2') {
      throw new Error('version');
    }
    expect(b.snapshot.terms.digest).not.toBe(a.snapshot.terms.digest);
  });
});
