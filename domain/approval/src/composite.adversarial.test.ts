// DP-1 (MVP-D): the caller cannot steer a composite. Route, payee and amount come from the
// database; a duplicate article is refused; the stored snapshot does not consult live rows (the
// live payee re-check is placeOrder's, covered in domain/payments composite-gates.adversarial).
import { afterEach, describe, expect, it } from 'vitest';
import type { Result, SqlExecutor } from '@umsbx/contracts';
import { requestApproval, verifyApproval } from './index';
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

async function ins(db: SqlExecutor, table: string, row: Record<string, unknown>): Promise<void> {
  const r: Record<string, unknown> = { created_at: SEED_TIME, updated_at: SEED_TIME, ...row };
  const cols = Object.keys(r);
  await db.query(
    `INSERT INTO ${table} (${cols.join(', ')}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(', ')})`,
    cols.map((c) => r[c]),
  );
}

// pub_1 (Harbour, MERCH1) offers ofr_1, ofr_2; pub_2 (MERCH2) offer ofr_3. ofr_1b is a second
// offer for art_1.
async function world(): Promise<void> {
  h = await makeHarness();
  await ins(h.db, 'offers', {
    id: 'ofr_1b',
    version: '1',
    publisher_id: 'pub_1',
    article_id: 'art_1',
    status: 'authorised',
    currency: 'USD',
    options: JSON.stringify(OFFER_OPTIONS),
    affordability: JSON.stringify({ renegotiation_allowed: false, floor_minor: null }),
    terms_version: 'terms-1',
    rights: JSON.stringify({ scope: 'personal_use', ai_scope: 'review', redistribution: false }),
    valid_from: SEED_TIME,
    valid_until: null,
    superseded_by: null,
  });
}
async function propose(offers: string[]) {
  const quotes: { quote_id: string; offer_id: string }[] = [];
  let n = 0;
  for (const offer_id of offers) {
    n += 1;
    await addQuote(h.db, { id: `quo_x${n}`, offer_id });
    quotes.push({ quote_id: `quo_x${n}`, offer_id });
  }
  await addProposal(h.db, 'prp_x', 'buy_A', quotes);
  return { kind: 'proposal', proposal_id: 'prp_x', offer_ids: offers } as const;
}
const approvalRows = async (): Promise<number> =>
  (await h.db.query<{ n: number }>('SELECT count(*)::int AS n FROM approvals')).rows[0]!.n;

describe('composite: the caller steers nothing', () => {
  it('the caller cannot pass a route, payee or amount (strict input)', async () => {
    await world();
    const sel = await propose(['ofr_1', 'ofr_3']);
    const honest = value(
      await requestApproval(h.deps, { actor: BUYER_A, selection: sel, consent: CONSENT }),
    );
    // The same call with extra fields a hostile client might add at every level.
    const hostile = {
      actor: BUYER_A,
      selection: {
        ...sel,
        settlement: { route: 'single', payments: 1 },
        route: 'single',
        payee_merchant_id: 'ATTACKER',
        amount_minor: 1,
      },
      consent: { ...CONSENT, route: 'single', amount_minor: 1 },
      settlement: { route: 'single', payments: 1 },
      payee_merchant_id: 'ATTACKER',
      amount_minor: 1,
      total_minor: 1,
    } as unknown as Parameters<typeof requestApproval>[1];
    const second = value(await requestApproval(h.deps, hostile));
    expect(second.snapshot).toEqual(honest.snapshot);
    expect(second.content_hash).toBe(honest.content_hash);
    expect(second.snapshot.settlement).toEqual({ route: 'per_publisher', payments: 2 });
    expect(JSON.stringify(second.snapshot)).not.toContain('ATTACKER');
    expect(second.snapshot.total_minor).toBe(800);
  });

  it('same article through two offers: unknown_selection, no row', async () => {
    await world();
    const sel = await propose(['ofr_1', 'ofr_1b', 'ofr_3']);
    const r = await requestApproval(h.deps, { actor: BUYER_A, selection: sel, consent: CONSENT });
    expect(r).toEqual({ ok: false, error: { code: 'unknown_selection' } });
    expect(await approvalRows()).toBe(0);
  });

  it('the same offer twice in a composite selection: unknown_selection, no row', async () => {
    await world();
    const sel = await propose(['ofr_1', 'ofr_3']);
    const r = await requestApproval(h.deps, {
      actor: BUYER_A,
      selection: { ...sel, offer_ids: ['ofr_1', 'ofr_3', 'ofr_3'] },
      consent: CONSENT,
    });
    expect(r).toEqual({ ok: false, error: { code: 'unknown_selection' } });
    expect(await approvalRows()).toBe(0);
  });

  it('payee lost after approval: the frozen snapshot still verifies; the live check is placeOrder (409 payee_unavailable)', async () => {
    await world();
    const g = value(
      await requestApproval(h.deps, {
        actor: BUYER_A,
        selection: await propose(['ofr_1', 'ofr_3']),
        consent: CONSENT,
      }),
    );
    await h.db.query(`UPDATE publishers SET payee_verified_at = NULL WHERE id = 'pub_2'`);
    const v = await verifyApproval(h.db, h.deps, { ...g, actor: BUYER_A });
    expect(v.ok).toBe(true);
    // The frozen block keeps the payee it was approved with; nothing here re-reads the publisher.
    expect(g.snapshot.publishers.map((p) => p.payee_merchant_id)).toEqual(['MERCH1', 'MERCH2']);
  });
});
