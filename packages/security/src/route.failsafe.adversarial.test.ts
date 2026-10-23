import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { withRoute } from './route';
import type { RouteMeta } from './route';
import { createSession } from './session';
import { ORIGIN, cookiePair, makeRig } from './test-support';

// BU-2: an operator without a second factor may not change anything, with one exception that a route
// must ask for by name: a route that can only reduce what the system may do (the stop button). The
// flag lifts the MFA rule for that route and nothing else.
const base: RouteMeta = {
  path: '/api/ops/stop',
  method: 'POST',
  auth: 'operator',
  csrf: true,
  rate: null,
  max_body_bytes: 1024,
  idempotent: false,
  risk: 'high',
};
const schema = z.object({ reason: z.string() }).strict();
const handler = async () => ({ status: 200 as const, body: {} });
const post = (h: Record<string, string>) =>
  new Request(`${ORIGIN}/api/ops/stop`, { method: 'POST', headers: h, body: '{"reason":"x"}' });

async function headers(kind: 'operator-nomfa' | 'operator-mfa' | 'buyer') {
  const rig = await makeRig();
  const s = await createSession(
    rig.deps,
    kind === 'buyer'
      ? { kind: 'buyer', buyer_id: 'buy_a' }
      : { kind: 'operator', operator_id: 'op_1', mfa: kind === 'operator-mfa' },
  );
  return {
    rig,
    h: { cookie: cookiePair(s.cookie), origin: ORIGIN, 'x-csrf-token': s.csrf_token },
  };
}

describe('fail_safe_without_mfa', () => {
  it('without the flag an operator without MFA is refused (unchanged)', async () => {
    const { rig, h } = await headers('operator-nomfa');
    expect((await withRoute(base, schema, handler)(rig.deps)(post(h))).status).toBe(403);
  });
  it('with the flag an operator without MFA passes; an operator with MFA still passes', async () => {
    const a = await headers('operator-nomfa');
    const route = withRoute({ ...base, fail_safe_without_mfa: true }, schema, handler);
    expect((await route(a.rig.deps)(post(a.h))).status).toBe(200);
    const b = await headers('operator-mfa');
    expect((await route(b.rig.deps)(post(b.h))).status).toBe(200);
  });
  it('the flag does not lift the role, session or CSRF rules', async () => {
    const route = withRoute({ ...base, fail_safe_without_mfa: true }, schema, handler);
    const buyer = await headers('buyer');
    expect((await route(buyer.rig.deps)(post(buyer.h))).status).toBe(403);
    const op = await headers('operator-nomfa');
    expect((await route(op.rig.deps)(post({ origin: ORIGIN }))).status).toBe(401);
    const { 'x-csrf-token': _drop, ...noCsrf } = op.h;
    expect((await route(op.rig.deps)(post(noCsrf))).status).toBe(403);
  });
  it('the flag is only valid on an operator POST route', () => {
    for (const meta of [
      { ...base, auth: 'buyer' as const },
      { ...base, auth: 'publisher' as const },
      { ...base, method: 'GET' as const, csrf: false },
    ])
      expect(() => withRoute({ ...meta, fail_safe_without_mfa: true }, schema, handler)).toThrow();
  });
});
