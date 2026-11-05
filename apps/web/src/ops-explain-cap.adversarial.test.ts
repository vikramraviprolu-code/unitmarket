// INT-GA follow-up FU-1: the operator order page must not call the model on every render. The page read keeps one
// answer for each order and each set of model inputs (so a reload, or ten reloads, ask once), and a page read that
// does need the model takes a token from the same `ops_explain` bucket as the explain route (10 a minute for each
// operator). When the bucket is empty the page shows a short "paused" note and does not call the model. All model
// calls here are spies on the scripted App.model; nothing reaches a real model.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { withTraceContext } from '@umsbx/obs';
import type { Actor, TraceContext } from '@umsbx/contracts';
import { bootA } from './api-v1/a-support';
import type { ARig, Sess } from './api-v1/a-support';
import { HARBOUR_FERRY, HARBOUR_TIDE, QUAY_MARKET, runPack } from './composite-support';
import { call } from './support';
import { EXPLAIN_PAUSED } from './lib/explain-view';

vi.mock('server-only', () => ({}));
vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

const here = fileURLToPath(new URL('.', import.meta.url));
const source = (rel: string): string => readFileSync(join(here, rel), 'utf8');

const ctx: TraceContext = {
  id: 'ctx_ga_cap',
  at: '2026-11-05T10:00:00.000Z',
  channel: 'job',
  actor_kind: 'system',
  actor_id: null,
  on_behalf_of: null,
  mandate_id: null,
  mfa: false,
  req_id: null,
  ip_hash: null,
  ua_family: null,
  api_key_id: null,
  job: 'ga_cap_test',
  tool: null,
};

let rig: ARig;
let route: typeof import('./app/api/ops/orders/[ref]/explain/route');
let money: typeof import('./composition/ops-money');
let assist: typeof import('./composition/assist');
let ref = '';
let orderId = '';
let alertSeq = 0;
const op = (id: string): Actor => ({ kind: 'operator', operator_id: id, mfa: true });

// A second alert of the same kind changes what the model would be sent (alert_kinds), so it is a new "version".
const addAlert = async (): Promise<void> => {
  alertSeq += 1;
  await withTraceContext(ctx, async () => {
    await rig.app.db.query(
      `INSERT INTO alerts (id, kind, order_id, detail, created_at, updated_at)
       VALUES ($1, 'payment_unresolved', $2, '{"reason":"cap test"}'::jsonb, now(), now())`,
      [`alr_cap_${alertSeq}`, orderId],
    );
  });
};

beforeAll(async () => {
  rig = await bootA({});
  route = await import('./app/api/ops/orders/[ref]/explain/route');
  money = await import('./composition/ops-money');
  assist = await import('./composition/assist');
  const a = await runPack(rig.app, rig.buyerA, [HARBOUR_TIDE, QUAY_MARKET], ['happy']);
  ref = a.order_ref;
  orderId = a.order_id;
  await withTraceContext(ctx, async () => {
    await rig.app.db.query(`UPDATE orders SET status = 'unresolved' WHERE id = $1`, [orderId]);
  });
  await addAlert();
});
afterAll(async () => rig?.app.close());

describe('the order page asks the model once for an unchanged order', () => {
  it('ten page reads of the same order make one model call, and give the same text', async () => {
    const spy = vi.spyOn(rig.app.model, 'complete');
    const who = op('opr_cap_reload');
    const first = await money.readOrderExplain(who, ref);
    expect(first).not.toBeNull();
    expect(first).not.toMatchObject({ paused: true });
    for (let i = 0; i < 9; i++) expect(await money.readOrderExplain(who, ref)).toEqual(first);
    expect(spy).toHaveBeenCalledTimes(1);
    spy.mockRestore();
  });

  it('a second operator reading the same unchanged order is answered from the same entry', async () => {
    const spy = vi.spyOn(rig.app.model, 'complete');
    const r = await money.readOrderExplain(op('opr_cap_other'), ref);
    expect(r).not.toBeNull();
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it('a change to what the model would be sent (a new alert on the order) asks again, once', async () => {
    await addAlert();
    const spy = vi.spyOn(rig.app.model, 'complete');
    const who = op('opr_cap_changed');
    await money.readOrderExplain(who, ref);
    await money.readOrderExplain(who, ref);
    expect(spy).toHaveBeenCalledTimes(1);
    spy.mockRestore();
  });

  it('an order that is not in attention still gets null and no model call', async () => {
    const spy = vi.spyOn(rig.app.model, 'complete');
    const paid = await runPack(rig.app, rig.buyerA, [HARBOUR_FERRY], ['happy']);
    expect(await money.readOrderExplain(op('opr_cap_paid'), paid.order_ref)).toBeNull();
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });
});

describe('a page read that needs the model spends the same bucket as the route', () => {
  it('the composition uses the route rule: same name, limit and window', () => {
    expect(assist.EXPLAIN_RATE).toEqual(route.routeMeta.rate);
  });

  it('when the bucket is empty a changed order is paused, the model is not called, and a cached one still shows', async () => {
    const who = op('opr_cap_drain');
    const s: Sess = await rig.session(who);
    const get = () =>
      call(route.GET, { url: `/api/ops/orders/${ref}/explain`, session: s, params: { ref } });
    // One page read (a miss) then nine route calls use all ten tokens of this operator.
    const warm = await money.readOrderExplain(who, ref);
    expect(warm).not.toMatchObject({ paused: true });
    for (let i = 0; i < 9; i++) expect((await get()).status).toBe(200);
    expect((await get()).status).toBe(429);

    const spy = vi.spyOn(rig.app.model, 'complete');
    // Unchanged: served from the cache, no token needed.
    expect(await money.readOrderExplain(who, ref)).toEqual(warm);
    // Changed: needs the model, bucket is empty, so paused.
    await addAlert();
    const paused = await money.readOrderExplain(who, ref);
    expect(paused).toMatchObject({ paused: true });
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it('a paused read is not cached: once tokens are back the model is asked and the panel shows', async () => {
    // A different operator has a full bucket, and the order is still in its changed state.
    const spy = vi.spyOn(rig.app.model, 'complete');
    const r = await money.readOrderExplain(op('opr_cap_fresh'), ref);
    expect(r).not.toMatchObject({ paused: true });
    expect(r).not.toBeNull();
    expect(spy).toHaveBeenCalledTimes(1);
    spy.mockRestore();
  });
});

describe('the paused note and the page, read as text', () => {
  it('the paused note is plain words and says to try again', () => {
    expect(EXPLAIN_PAUSED).toMatch(/try again/i);
    expect(EXPLAIN_PAUSED).not.toMatch(/[<>]/);
  });

  it('the panel renders the note for a paused view and still has no form, fetch or raw HTML', () => {
    const panel = source('ui/ExplainPanel.tsx');
    expect(panel).toMatch(/EXPLAIN_PAUSED/);
    expect(panel).not.toMatch(/<form|method=|postJson|fetch\(|dangerouslySetInnerHTML|innerHTML/);
  });

  it('the page still gets its panel only through readOrderExplain', () => {
    const page = source('app/ops/money/orders/[ref]/page.tsx');
    expect(page).toMatch(/readOrderExplain\(/);
    expect(page).not.toMatch(/explainForOrder|\.model\b|complete\(/);
  });
});
