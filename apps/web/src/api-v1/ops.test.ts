// API-A: the operator functions refuse any owner kind but an operator key, even if a scope check let it
// through, and the status answer follows the health check. Plain stubs: no database, no network.
import { describe, expect, it, vi } from 'vitest';
import type { Actor, Principal } from '@umsbx/contracts';
import type { App } from '../../composition.server';
import { orderDetail, overview, reconciler, status, switches } from './ops';

vi.mock('server-only', () => ({}));

const operator: Actor = { kind: 'operator', operator_id: 'opr_t', mfa: false };
const buyer: Actor = { kind: 'buyer', buyer_id: 'buy_t' } as Actor;
const opKey: Principal = {
  kind: 'api_client',
  key_id: 'key_t',
  owner: { kind: 'operator', operator_id: 'opr_t' },
} as Principal;
const agentKey: Principal = { kind: 'agent', key_id: 'key_a', buyer_id: 'buy_t' } as Principal;

const snap = {
  environment: 'dryrun',
  switches: { paypal_outbound: true },
  orders: [],
  operations: [],
  alerts: [],
  invariants: [],
  jobs: { last_pass_at: null, due: 0 },
  kill_switch: { outbound_on: true, changed_at: 't' },
  gate: { mode: 'dryrun', connect: false, approval_ref_set: false, outbound: null },
};
const app = (over: Record<string, unknown> = {}): App =>
  ({
    engine: {
      opsSnapshot: async (a: Actor) => (a.kind === 'operator' ? snap : null),
      health: async () => ({ ok: true, environment: 'dryrun', maintenance: false }),
      ...over,
    },
    db: { query: async () => ({ rows: [] }) },
  }) as unknown as App;

const ok = { actor: operator, principal: opKey };
const wrong = [
  { actor: buyer, principal: opKey },
  { actor: operator, principal: agentKey },
  { actor: operator, principal: null },
];

describe('operator functions', () => {
  it.each([
    ['overview', overview],
    ['reconciler', reconciler],
    ['switches', switches],
  ] as const)('%s: operator key 200, any other caller 403', async (_n, fn) => {
    expect((await fn(app(), ok)).status).toBe(200);
    for (const c of wrong) expect((await fn(app(), c)).status).toBe(403);
  });
  it('order detail: wrong caller is 403 before any read, a missing order is 404', async () => {
    let reads = 0;
    const a = {
      ...app(),
      db: {
        query: async () => {
          reads++;
          return { rows: [] };
        },
      },
    } as unknown as App;
    for (const c of wrong) expect((await orderDetail(a, c, 'ord_x')).status).toBe(403);
    expect(reads).toBe(0);
    expect((await orderDetail(a, ok, 'ord_x')).status).toBe(404);
  });
  it('switches: the lock block is null on the dry-run transport and shown otherwise', async () => {
    const dry = (await switches(app(), ok)) as {
      body: { gate: { locks: unknown; open: unknown } };
    };
    expect(dry.body.gate.locks).toBeNull();
    expect(dry.body.gate.open).toBeNull();
    const locks = { l1_mode_sandbox: false };
    const wired = app({
      opsSnapshot: async () => ({
        ...snap,
        gate: { ...snap.gate, outbound: { locks, open: false, blocked_by: 'connect_off' } },
      }),
    });
    const r = (await switches(wired, ok)) as {
      body: { gate: { locks: unknown; open: unknown; blocked_by: unknown } };
    };
    expect(r.body.gate).toMatchObject({ locks, open: false, blocked_by: 'connect_off' });
  });
});

describe('status', () => {
  it('healthy: 200 with the environment, and the maintenance flag only when set', async () => {
    expect(await status(app())).toEqual({ status: 200, body: { ok: true, environment: 'dryrun' } });
    const m = app({ health: async () => ({ ok: true, environment: 'dryrun', maintenance: true }) });
    expect(await status(m)).toEqual({
      status: 200,
      body: { ok: true, environment: 'dryrun', maintenance: true },
    });
  });
  it('unhealthy: 503 unhealthy', async () => {
    const r = await status(app({ health: async () => ({ ok: false, environment: 'dryrun' }) }));
    expect(r).toEqual({
      status: 503,
      code: 'unhealthy',
      message: 'The service is not ready.',
    });
  });
});
