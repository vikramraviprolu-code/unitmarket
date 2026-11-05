// PUB-A2 state (docs/specs/pub-a2-payee.md): through a booted offline app. A publisher asks, an
// operator with the second factor verifies by typing the id again, the page data follows, and a payee
// verified while an approval is open makes placing that order answer payee_unavailable. The pages are
// .tsx files the unit runner does not compile, so their source is read as text.
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { errorOf } from './refund-support';
import { bootPayeeWorld, postDecision, postRequest } from './payee-support';
import type { PayeeWebWorld } from './payee-support';

vi.mock('server-only', () => ({}));

const read = (rel: string): string => readFileSync(new URL(rel, import.meta.url), 'utf8');

let w: PayeeWebWorld;
beforeAll(async () => {
  w = await bootPayeeWorld();
});
afterAll(async () => {
  await w.app.close();
});
beforeEach(async () => {
  await w.app.db.query('DELETE FROM rate_buckets');
});

const OPERATOR = { kind: 'operator' as const, operator_id: 'opr_vikram', mfa: true };
const harbour = () => w.pub['harbour-ledger'];
const harbourActor = () => ({
  kind: 'publisher' as const,
  publisher_id: w.pubId['harbour-ledger'],
});
const merchantOf = async (slug: keyof PayeeWebWorld['pubId']) =>
  (
    await w.app.db.query<{ paypal_merchant_id: string | null }>(
      'SELECT paypal_merchant_id FROM publishers WHERE id = $1',
      [w.pubId[slug]],
    )
  ).rows[0]!.paypal_merchant_id;

const ask = async (merchant_id: string, note = 'We changed banks.') => {
  const res = await postRequest(w, harbour(), { merchant_id, note });
  expect(res.status).toBe(200);
  return ((await res.json()) as { request_id: string }).request_id;
};

describe('the page data', () => {
  it('a publisher sees last 4, verified time, the dry run label and an empty history', async () => {
    const v = (await w.app.engine.payee.view(harbourActor()))!;
    expect(v.environment).toBe('dryrun');
    expect(v.last4).not.toBeNull();
    expect(v.last4).toHaveLength(4);
    expect(v.verified_at).not.toBeNull();
    expect(v.history).toEqual([]);
  });

  it('buyers, operators and the system get no payee page', async () => {
    expect(await w.app.engine.payee.view(w.refund.actorA)).toBeNull();
    expect(
      await w.app.engine.payee.view({ kind: 'operator', operator_id: 'opr_x', mfa: true }),
    ).toBeNull();
    expect(await w.app.engine.payee.view({ kind: 'system' })).toBeNull();
  });
});

describe('ask, then verify', () => {
  it('a request changes nothing until an operator verifies it by typing the id again', async () => {
    const before = await merchantOf('harbour-ledger');
    const id = await ask('NEWHARBOUR001');
    expect(await merchantOf('harbour-ledger')).toBe(before);
    const v1 = (await w.app.engine.payee.view(harbourActor()))!;
    expect(v1.history[0]).toMatchObject({ request_id: id, state: 'open', requested_last4: 'R001' });

    // The operator queue shows the last 4 only.
    const open = await w.app.engine.payee.openRequests(OPERATOR);
    expect(open.ok).toBe(true);
    if (open.ok) {
      expect(open.value.environment).toBe('dryrun');
      const row = open.value.requests.find((r) => r.request_id === id)!;
      expect(row.requested_last4).toBe('R001');
      expect(JSON.stringify(open.value)).not.toContain('NEWHARBOUR001');
    }

    const wrong = await postDecision(w, w.refund.op, {
      request_id: id,
      merchant_id_retyped: 'NEWHARBOUR002',
      decision: 'verified',
      reason: 'Checked by phone.',
    });
    expect(wrong.status).toBe(422);
    expect((await errorOf(wrong)).code).toBe('id_mismatch');
    expect(await merchantOf('harbour-ledger')).toBe(before);

    const right = await postDecision(w, w.refund.op, {
      request_id: id,
      merchant_id_retyped: 'NEWHARBOUR001',
      decision: 'verified',
      reason: 'Checked by phone.',
    });
    expect(right.status).toBe(200);
    expect(await merchantOf('harbour-ledger')).toBe('NEWHARBOUR001');
    const v2 = (await w.app.engine.payee.view(harbourActor()))!;
    expect(v2.last4).toBe('R001');
    expect(v2.history[0]).toMatchObject({ request_id: id, state: 'verified' });
    const home = await w.app.engine.publisherHome(harbourActor());
    expect(home?.payee.last4).toBe('R001');

    const again = await postDecision(w, w.refund.op, {
      request_id: id,
      merchant_id_retyped: 'NEWHARBOUR001',
      decision: 'verified',
      reason: 'Twice.',
    });
    expect(again.status).toBe(409);
    expect((await errorOf(again)).code).toBe('already_decided');
  });

  it('a reject through the route changes nothing but the history', async () => {
    const before = await merchantOf('harbour-ledger');
    const id = await ask('REJECTHARBOU1');
    const res = await postDecision(w, w.refund.op, {
      request_id: id,
      merchant_id_retyped: '',
      decision: 'rejected',
      reason: 'Could not confirm it.',
    });
    expect(res.status).toBe(200);
    expect(await merchantOf('harbour-ledger')).toBe(before);
    const v = (await w.app.engine.payee.view(harbourActor()))!;
    expect(v.history[0]).toMatchObject({ request_id: id, state: 'rejected' });
  });

  it('an unknown request id is 404', async () => {
    const res = await postDecision(w, w.refund.op, {
      request_id: 'prp_unknown',
      merchant_id_retyped: 'NEWHARBOUR001',
      decision: 'verified',
      reason: 'Checked.',
    });
    expect(res.status).toBe(404);
  });
});

describe('a payee verified while an approval is open (money path)', () => {
  it('placing that order answers payee_unavailable and creates no order', async () => {
    const actor = w.refund.actorB;
    const q = await w.app.engine.quote({
      offer: { publisher_slug: 'harbour-ledger', offer_code: 'tide-tables' },
      actor,
      source: 'direct',
      option: 'online_read',
    });
    if (!q.ok || q.value.kind !== 'quote') throw new Error('no quote');
    const g = await w.app.engine.requestApproval({
      actor,
      selection: { kind: 'quote', quote_id: q.value.quote_id },
      consent: { terms: true, identity_share: false },
    });
    if (!g.ok) throw new Error(`no approval: ${g.error.code}`);

    const id = await ask('SWITCHEDPAYE1');
    const ok = await postDecision(w, w.refund.op, {
      request_id: id,
      merchant_id_retyped: 'SWITCHEDPAYE1',
      decision: 'verified',
      reason: 'Checked by phone.',
    });
    expect(ok.status).toBe(200);

    const orders = async () =>
      Number(
        (await w.app.db.query<{ c: string | number }>('SELECT count(*) AS c FROM orders')).rows[0]!
          .c,
      );
    const n = await orders();
    const placed = await w.app.engine.payments.placeOrder({
      approval_id: g.value.approval_id,
      token: g.value.token,
      actor,
    });
    expect(placed.ok).toBe(false);
    if (!placed.ok) expect(placed.error).toMatchObject({ code: 'payee_unavailable' });
    expect(await orders()).toBe(n);
  });
});

describe('the pages (source text)', () => {
  const s6 = read('./app/publisher/payout-account/page.tsx');
  const ops = read('./app/ops/payee-requests/page.tsx');

  it('S6 reads the session actor, uses the copy file and shows no whole id', () => {
    expect(s6).toContain('currentActor');
    expect(s6).toContain("actor?.kind !== 'publisher'");
    expect(s6).toContain('payee-copy');
    expect(s6).toContain('engine.payee.view');
    expect(s6).not.toMatch(/style=/);
    expect(s6).not.toMatch(/searchParams|publisher_id/);
  });

  it('S6 offers the owner note in sandbox mode and its form posts a request', () => {
    expect(s6).toContain('OWNER_ONLY_NOTE');
    expect(s6).toContain('RequestForm');
  });

  it('the operator page reads the queue without the code, and asks for the id again', () => {
    expect(ops).toContain("actor?.kind !== 'operator'");
    expect(ops).toMatch(/hasCode=\{|mfa=\{|canAct=\{/);
    expect(ops).toContain('readOpsPayeeQueue(actor)');
    expect(read('./composition/ops-sellers.ts')).toContain('payee.openRequests(');
    expect(read('./app/ops/payee-requests/DecisionForm.tsx')).toContain('OPS_FIELD_RETYPE');
    expect(ops).not.toMatch(/style=/);
  });

  it('the form components post to the two routes and send no publisher id', () => {
    const f1 = read('./app/publisher/payout-account/RequestForm.tsx');
    const f2 = read('./app/ops/payee-requests/DecisionForm.tsx');
    expect(f1).toContain('/api/publisher/payee-requests');
    expect(f2).toContain('/api/ops/payee-decisions');
    expect(f1).not.toContain('publisher_id');
    expect(f2).not.toContain('publisher_id');
    expect(f1).not.toMatch(/style=/);
    expect(f2).not.toMatch(/style=/);
  });
});
