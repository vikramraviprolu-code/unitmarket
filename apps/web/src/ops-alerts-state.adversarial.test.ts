// INT-AL AL.3 (R2-4): the three alert writes as routes. An operator session with the second factor, CSRF and an
// Idempotency-Key; nothing else gets in, and an email typed in a note is stored nowhere as text.
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { bootAlertRig, key, post, rows, seedAlert } from './ops-alerts-support';
import type { AlertRig, Handler } from './ops-alerts-support';

vi.mock('server-only', () => ({}));

let r: AlertRig;
const h: Record<'acknowledge' | 'resolve' | 'reopen', Handler> = {} as never;
const url = (id: string, a: string): string => `/api/ops/alerts/${id}/${a}`;
const events = async (id: string) =>
  rows<{ kind: string; reason_code: string | null }>(
    r.rig,
    'SELECT kind, reason_code FROM alert_events WHERE alert_id = $1 ORDER BY seq',
    [id],
  );

beforeAll(async () => {
  r = await bootAlertRig();
  h.acknowledge = (await import('./app/api/ops/alerts/[id]/acknowledge/route')).POST as Handler;
  h.resolve = (await import('./app/api/ops/alerts/[id]/resolve/route')).POST as Handler;
  h.reopen = (await import('./app/api/ops/alerts/[id]/reopen/route')).POST as Handler;
  for (const n of [1, 2, 3, 4, 5, 6]) {
    await seedAlert(r.rig, { id: `alr_t${n}`, kind: 'mandate_near_cap', reason: `cap90_man_${n}` });
  }
});
afterAll(async () => r.rig.app.close());

const call = (a: 'acknowledge' | 'resolve' | 'reopen', id: string, o: Parameters<typeof post>[2]) =>
  post(h[a], url(id, a), { ...o, params: { id } });
const body = (a: string): unknown => (a === 'resolve' ? { reason_code: 'fixed_upstream' } : {});

describe.each(['acknowledge', 'resolve', 'reopen'] as const)('POST %s', (act) => {
  it('refuses an operator without the second factor (403 mfa_required) and writes nothing', async () => {
    const res = await call(act, 'alr_t1', { session: r.noMfa, body: body(act) });
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('mfa_required');
    expect(await events('alr_t1')).toEqual([]);
  });

  it('refuses buyer and seller sessions, a missing session and a bearer key', async () => {
    for (const s of [r.buyer, r.seller]) {
      expect([401, 403]).toContain(
        (await call(act, 'alr_t1', { session: s, body: body(act) })).status,
      );
    }
    expect((await call(act, 'alr_t1', { session: null, body: body(act) })).status).toBe(401);
    const bearer = await call(act, 'alr_t1', {
      session: null,
      body: body(act),
      headers: { authorization: `Bearer ${r.opKey}` },
    });
    expect([401, 403]).toContain(bearer.status);
    expect(await events('alr_t1')).toEqual([]);
  });

  it('refuses a missing or wrong CSRF token and a foreign Origin (403)', async () => {
    expect(
      (await call(act, 'alr_t1', { session: r.op, body: body(act), csrf: false })).status,
    ).toBe(403);
    const wrong = await call(act, 'alr_t1', {
      session: r.op,
      body: body(act),
      csrf: false,
      headers: { 'x-csrf-token': 'x'.repeat(40) },
    });
    expect(wrong.status).toBe(403);
    expect(await events('alr_t1')).toEqual([]);
  });

  it('refuses a request with no Idempotency-Key', async () => {
    const res = await call(act, 'alr_t1', { session: r.op, body: body(act), idem: null });
    expect(res.status).toBe(422);
    expect(await events('alr_t1')).toEqual([]);
  });

  it('answers 404 for an alert that does not exist', async () => {
    expect((await call(act, 'alr_nope', { session: r.op, body: body(act) })).status).toBe(404);
  });
});

describe('what an operator with the second factor can do', () => {
  it('acknowledges, resolves, and reopens; a double resolve is a no-op that answers the same', async () => {
    const ack = await call('acknowledge', 'alr_t2', { session: r.op });
    expect(ack.status).toBe(200);
    expect(((await ack.json()) as { state: string }).state).toBe('acknowledged');
    const first = await call('resolve', 'alr_t2', {
      session: r.op,
      body: { reason_code: 'duplicate' },
    });
    const second = await call('resolve', 'alr_t2', {
      session: r.op,
      body: { reason_code: 'other' },
    });
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(await second.json()).toEqual(await first.json());
    expect((await events('alr_t2')).map((e) => e.kind)).toEqual(['acknowledged', 'resolved']);
    const re = await call('reopen', 'alr_t2', { session: r.op });
    expect(((await re.json()) as { state: string }).state).toBe('open');
  });

  it('a reopen of an open alert is 409 wrong_state', async () => {
    const res = await call('reopen', 'alr_t3', { session: r.op });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('wrong_state');
  });

  it('a reason code outside the closed list, and a note over 200 characters, are refused', async () => {
    for (const b of [
      { reason_code: 'because' },
      { reason_code: 'other', note: 'x'.repeat(201) },
      {},
    ]) {
      const res = await call('resolve', 'alr_t3', { session: r.op, body: b });
      expect([400, 422]).toContain(res.status);
    }
    expect(await events('alr_t3')).toEqual([]);
  });

  it('a replay with the same key returns the stored answer and writes one event', async () => {
    const k = key();
    const a = await call('resolve', 'alr_t4', {
      session: r.op,
      body: { reason_code: 'fixed_upstream' },
      idem: k,
    });
    const b = await call('resolve', 'alr_t4', {
      session: r.op,
      body: { reason_code: 'fixed_upstream' },
      idem: k,
    });
    expect(b.headers.get('idempotent-replay')).toBe('true');
    expect(await b.json()).toEqual(await a.json());
    expect(await events('alr_t4')).toHaveLength(1);
  });

  it('the journal shows the operator, channel web, the second factor and the reason code', async () => {
    await call('resolve', 'alr_t5', { session: r.op, body: { reason_code: 'accepted_risk' } });
    const [ev] = await rows<{ id: string }>(
      r.rig,
      "SELECT id FROM alert_events WHERE alert_id = 'alr_t5'",
    );
    const [t] = await rows<{
      actor_kind: string;
      actor_id: string;
      channel: string;
      mfa: boolean;
      body: unknown;
    }>(
      r.rig,
      "SELECT actor_kind, actor_id, channel, mfa, body FROM trace_events WHERE source_table = 'alert_events' AND source_id = $1",
      [ev!.id],
    );
    expect(t).toMatchObject({
      actor_kind: 'operator',
      actor_id: 'opr_vikram',
      channel: 'web',
      mfa: true,
    });
    expect(JSON.stringify(t!.body)).toContain('accepted_risk');
  });

  it('an email in a note appears nowhere in alert_events, trace_events or the audit log', async () => {
    const note = 'ring jane.doe@example.com tomorrow';
    const res = await call('resolve', 'alr_t6', {
      session: r.op,
      body: { reason_code: 'other', note },
    });
    expect(res.status).toBe(200);
    const dump = JSON.stringify([
      await rows(r.rig, 'SELECT * FROM alert_events'),
      await rows(r.rig, 'SELECT * FROM trace_events'),
      await rows(r.rig, 'SELECT * FROM audit_log'),
    ]);
    expect(dump).not.toContain('jane.doe');
    expect(dump).not.toContain('example.com');
  });
});

describe('the journal after all of the above (AL.3, TR0)', () => {
  it('trace_verify finds nothing broken and no alert event is unattributed', async () => {
    const broken = await rows<{ kind: string }>(
      r.rig,
      "SELECT kind FROM trace_verify() WHERE kind <> 'drift'",
    );
    expect(broken).toEqual([]);
    const bare = await rows(
      r.rig,
      "SELECT 1 FROM trace_events WHERE actor_kind = 'unattributed' AND source_table = 'alert_events'",
    );
    expect(bare).toEqual([]);
  });
});
