// API-W0 (F4): two details of the idempotency record that the v1 wrapper depends on. A pending record is
// reclaimed only after exactly 300000 ms (written as a literal so a changed constant is noticed), and a
// handler may store a different answer for replay than the one it sends (replay_body).
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { withRoute, type RouteMeta } from './route';
import { BUYER_A, makeV1Rig } from './v1-support';
import { expectOffline } from './offline-guard';

vi.mock('node:net', async (orig) => (await import('./offline-guard')).netMock(await orig()));
vi.mock('node:dns', async (orig) => (await import('./offline-guard')).dnsMock(await orig()));
expectOffline();

const meta: RouteMeta = {
  path: '/api/v1/things',
  method: 'POST',
  auth: 'apikey',
  scopes: ['orders:write'],
  csrf: false,
  rate: { name: 'v1-ttl', per: 'actor', limit: 100, window_ms: 60_000 },
  max_body_bytes: 1024,
  idempotent: true,
  risk: 'low',
};
const Body = z.object({ n: z.number() }).strict();

describe('pending reservation', () => {
  it('a handler that throws keeps the key at 409 for 300000 ms, then the next attempt runs', async () => {
    const rig = await makeV1Rig();
    const k = await rig.issue(BUYER_A, 'api_client', ['orders:write']);
    let runs = 0;
    const route = withRoute(meta, Body, async () => {
      runs += 1;
      if (runs === 1) throw new Error('crash');
      return { status: 201 as const, body: { runs } };
    })(rig.deps);
    const send = () =>
      route(
        rig.bearer(k.token, {
          method: 'POST',
          url: '/api/v1/things',
          body: { n: 1 },
          headers: { 'idempotency-key': 'ttl-key-0001' },
        }),
      );
    expect((await send()).status).toBe(500);
    rig.clock.advance(300_000);
    expect((await send()).status).toBe(409);
    expect(runs).toBe(1);
    rig.clock.advance(1);
    expect((await send()).status).toBe(201);
    expect(runs).toBe(2);
  });
});

describe('replay_body', () => {
  it('sends body once and stores and replays replay_body', async () => {
    const rig = await makeV1Rig();
    const k = await rig.issue(BUYER_A, 'api_client', ['orders:write']);
    const route = withRoute(meta, Body, async () => ({
      status: 201 as const,
      body: { id: 'x1', token: 'shown-once' },
      replay_body: { id: 'x1' },
    }))(rig.deps);
    const send = () =>
      route(
        rig.bearer(k.token, {
          method: 'POST',
          url: '/api/v1/things',
          body: { n: 1 },
          headers: { 'idempotency-key': 'replay-body-0001' },
        }),
      );
    expect(await (await send()).json()).toEqual({ id: 'x1', token: 'shown-once' });
    const again = await send();
    expect(again.headers.get('idempotent-replay')).toBe('true');
    expect(await again.json()).toEqual({ id: 'x1' });
    const stored = await rig.db.query('SELECT response FROM api_idempotency');
    expect(JSON.stringify(stored.rows)).not.toContain('shown-once');
  });

  it('without replay_body the sent body is what is stored', async () => {
    const rig = await makeV1Rig();
    const k = await rig.issue(BUYER_A, 'api_client', ['orders:write']);
    const route = withRoute(meta, Body, async () => ({
      status: 201 as const,
      body: { id: 'y1' },
    }))(rig.deps);
    const send = () =>
      route(
        rig.bearer(k.token, {
          method: 'POST',
          url: '/api/v1/things',
          body: { n: 1 },
          headers: { 'idempotency-key': 'replay-body-0002' },
        }),
      );
    await send();
    expect(await (await send()).json()).toEqual({ id: 'y1' });
  });
});
