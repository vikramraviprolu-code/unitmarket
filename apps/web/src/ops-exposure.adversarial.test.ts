// INT-CTL / CTL.6: POST /api/ops/api-exposure/[group]/off and /on. Off needs a reason code and no authenticator
// code; on needs both. `mcp%3Abuy_unit` decodes. An unknown group is 404. Buyers, sellers, a bearer key and an
// operator key are refused (R2-3); CSRF and replay as for the switches. Each change is one journal event.
import { createHash } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { API_GROUPS } from '@umsbx/contracts';
import { bootA, idemKey } from './api-v1/a-support';
import type { ARig, Handler, Sess } from './api-v1/a-support';

vi.mock('server-only', () => ({}));

let rig: ARig;
let off: { POST: Handler; routeMeta: Record<string, unknown> };
let on: { POST: Handler; routeMeta: Record<string, unknown> };
let op: Sess;
let noMfa: Sess;
const send = (
  dir: 'on' | 'off',
  s: Sess | null,
  group: string,
  body: unknown = { reason_code: 'incident' },
  idem: string | null = idemKey(),
  headers: Record<string, string> = {},
) =>
  rig.old(dir === 'off' ? off.POST : on.POST, s, {
    method: 'POST',
    url: `/api/ops/api-exposure/${group}/${dir}`,
    body,
    params: { group },
    idem,
    headers,
  });
const row = async (g: string) =>
  (
    await rig.app.db.query<{
      enabled: boolean;
      changed_by: string | null;
      reason_code: string | null;
    }>('SELECT enabled, changed_by, reason_code FROM api_exposure WHERE group_name = $1', [g])
  ).rows[0]!;
const reset = () =>
  rig.app.db.query(
    'UPDATE api_exposure SET enabled = true, changed_by = NULL, reason_code = NULL WHERE enabled = false',
  );
const errCode = async (r: Response): Promise<string> =>
  ((await r.clone().json()) as { error: { code: string } }).error.code;

beforeAll(async () => {
  rig = await bootA();
  off = (await import('./app/api/ops/api-exposure/[group]/off/route')) as never;
  on = (await import('./app/api/ops/api-exposure/[group]/on/route')) as never;
  op = await rig.session({ kind: 'operator', operator_id: 'opr_exp_mfa', mfa: true });
  noMfa = await rig.session({ kind: 'operator', operator_id: 'opr_exp_plain', mfa: false });
});
afterAll(async () => rig.app.close());
beforeEach(async () => {
  await rig.app.db.query('DELETE FROM rate_buckets');
  await reset();
});

describe('route meta', () => {
  it('both are operator POST, csrf, idempotent, high risk, 10 a minute per actor; only off is fail-safe', () => {
    for (const r of [off, on]) {
      expect(r.routeMeta).toMatchObject({
        method: 'POST',
        auth: 'operator',
        csrf: true,
        idempotent: true,
        risk: 'high',
      });
      expect(r.routeMeta['rate']).toMatchObject({ per: 'actor', limit: 10, window_ms: 60_000 });
    }
    expect(off.routeMeta['fail_safe_without_mfa']).toBe(true);
    expect(on.routeMeta['fail_safe_without_mfa']).toBeUndefined();
  });
});

describe('off', () => {
  it('works without the authenticator code for every group, writes enabled=false, the reason code and the operator', async () => {
    for (const g of API_GROUPS) {
      const res = await send('off', noMfa, encodeURIComponent(g), {
        reason_code: 'partner_request',
      });
      expect(res.status, g).toBe(200);
      expect(await row(g), g).toEqual({
        enabled: false,
        changed_by: 'operator:opr_exp_plain',
        reason_code: 'partner_request',
      });
      await rig.app.db.query('DELETE FROM rate_buckets');
    }
  });

  it('mcp%3Abuy_unit decodes to mcp:buy_unit, and so does the plain form', async () => {
    expect((await send('off', noMfa, 'mcp%3Abuy_unit')).status).toBe(200);
    expect((await row('mcp:buy_unit')).enabled).toBe(false);
    await reset();
    expect((await send('off', noMfa, 'mcp:buy_unit')).status).toBe(200);
    expect((await row('mcp:buy_unit')).enabled).toBe(false);
  });

  it('an unknown or malformed group is 404 and no row changes', async () => {
    for (const g of [
      'payments',
      'ORDERS',
      'orders%00',
      '%E0%A4%A',
      'mcp%3Aadmin',
      '..%2Forders',
      'mcp:',
      '',
    ])
      expect((await send('off', noMfa, g)).status, g).toBe(404);
    expect(
      (await rig.app.db.query('SELECT 1 FROM api_exposure WHERE enabled = false')).rows,
    ).toEqual([]);
  });

  it('without a reason code, or with one outside the list, is 400; a body that says "on" is 422', async () => {
    for (const body of [{}, { reason_code: '' }, { reason_code: 'because' }])
      expect((await send('off', noMfa, 'orders', body)).status, JSON.stringify(body)).toBe(400);
    expect(
      (await send('off', noMfa, 'orders', { reason_code: 'incident', enabled: true })).status,
    ).toBe(422);
    expect((await row('orders')).enabled).toBe(true);
  });

  it('is journaled once, on the web channel, with the operator and a hashed changer (CTL.6)', async () => {
    const q = () =>
      rig.app.db.query<{
        channel: string;
        actor_kind: string;
        actor_id: string | null;
        chain_key: string;
        event_type: string;
        body: {
          cols: Record<string, [unknown, unknown]>;
          hashed: Record<string, [unknown, string]>;
        };
      }>(
        "SELECT channel, actor_kind, actor_id, chain_key, event_type, body FROM trace_events WHERE source_table = 'api_exposure' AND source_id = 'seller' ORDER BY seq",
      );
    const before = (await q()).rows.length;
    await send('off', noMfa, 'seller', { reason_code: 'incident' });
    const rows = (await q()).rows;
    expect(rows).toHaveLength(before + 1);
    const last = rows.at(-1)!;
    expect(last).toMatchObject({
      channel: 'web',
      actor_kind: 'operator',
      actor_id: 'opr_exp_plain',
      chain_key: 'plat',
      event_type: 'api_exposure.updated',
    });
    expect(last.body.cols['enabled']).toEqual([true, false]);
    expect(last.body.hashed['changed_by']![1]).toBe(
      createHash('sha256').update('operator:opr_exp_plain').digest('hex'),
    );
  });

  it('turning off a group that is already off still answers 200 and keeps it off', async () => {
    await send('off', noMfa, 'library');
    await rig.app.db.query('DELETE FROM rate_buckets');
    expect((await send('off', noMfa, 'library')).status).toBe(200);
    expect((await row('library')).enabled).toBe(false);
  });
});

describe('on', () => {
  it('without the authenticator code is 403 mfa_required', async () => {
    await send('off', noMfa, 'orders');
    const res = await send('on', noMfa, 'orders');
    expect(res.status).toBe(403);
    expect(await errCode(res)).toBe('mfa_required');
    expect((await row('orders')).enabled).toBe(false);
  });

  it('with the code and a reason code turns the group on and records both', async () => {
    await send('off', noMfa, 'orders');
    const res = await send('on', op, 'orders', { reason_code: 'maintenance' });
    expect(res.status).toBe(200);
    expect(await row('orders')).toEqual({
      enabled: true,
      changed_by: 'operator:opr_exp_mfa',
      reason_code: 'maintenance',
    });
  });

  it('needs a reason code (400), and mcp%3Abuy_unit decodes', async () => {
    await send('off', noMfa, 'mcp%3Abuy_unit');
    expect((await send('on', op, 'mcp%3Abuy_unit', {})).status).toBe(400);
    expect((await row('mcp:buy_unit')).enabled).toBe(false);
    expect((await send('on', op, 'mcp%3Abuy_unit')).status).toBe(200);
    expect((await row('mcp:buy_unit')).enabled).toBe(true);
  });

  it('an unknown group is 404', async () => {
    expect((await send('on', op, 'payments')).status).toBe(404);
  });
});

describe('who may call, CSRF and replay (CTL.3 rules, R2-3)', () => {
  it('buyer, seller, no session, a bearer key and an operator key are refused on both routes', async () => {
    const buyer = await rig.session(rig.buyerA);
    const seller = await rig.session(rig.harbour);
    const keys = [
      await rig.key(rig.buyerA, ['orders:read']),
      await rig.key(rig.operator, ['ops:read']),
    ];
    for (const dir of ['off', 'on'] as const) {
      for (const s of [buyer, seller])
        expect([401, 403], dir).toContain((await send(dir, s, 'orders')).status);
      expect((await send(dir, null, 'orders')).status, dir).toBe(401);
      for (const k of keys) {
        const res = await send(dir, null, 'orders', undefined, idemKey(), {
          authorization: `Bearer ${k}`,
        });
        expect([401, 403], dir).toContain(res.status);
      }
    }
    expect((await row('orders')).enabled).toBe(true);
  });

  it('a missing or wrong CSRF token is 403 on both routes', async () => {
    expect((await send('off', { ...noMfa, csrf: 'wrong' }, 'orders')).status).toBe(403);
    expect((await send('on', { ...op, csrf: '' }, 'orders')).status).toBe(403);
    expect((await row('orders')).enabled).toBe(true);
  });

  it('a missing Idempotency-Key is 422, and a replay returns the stored answer without a second change', async () => {
    expect((await send('off', noMfa, 'orders', undefined, null)).status).toBe(422);
    const k = idemKey();
    const a = await send('off', noMfa, 'orders', undefined, k);
    await rig.app.db.query("UPDATE api_exposure SET enabled = true WHERE group_name = 'orders'");
    const b = await send('off', noMfa, 'orders', undefined, k);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(b.headers.get('idempotent-replay')).toBe('true');
    expect((await row('orders')).enabled).toBe(true);
  });
});
