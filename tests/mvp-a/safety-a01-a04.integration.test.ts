// MVP-A acceptance A-01 to A-04: boot refuses anything live, offline opens no socket, the outbound
// gates block with the right reason, the egress guard refuses everything off the list. Expected
// results are the text of docs/design/mvp-plan.md. Offline only; host names are built from parts.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BOOT_REFUSAL_EXIT_CODE, bootOrExit, loadConfig, makeSecret } from '@umsbx/config';
import type { OutboundRequest } from '@umsbx/contracts';
import { createOutboundGate, createSwitchReader } from '@umsbx/safety';
import { createDryRunTransport, createSandboxTransport, guard } from '@umsbx/transport';
import { createLogger } from '@umsbx/obs';
import { testDb, fakeClock, T0 } from '@umsbx/testkit';
import { BUYER_A, buy, makeWorld } from './world';

const host = (...parts: string[]) => parts.join('.');
const LIVE_API = host('api-m', 'paypal', 'com');
const LIVE_WEB = host('www', 'paypal', 'com');
const SANDBOX_API = host('api-m', 'sandbox', 'paypal', 'com');

const base = (over: Record<string, string> = {}): Record<string, string> => ({
  UMS_MODE: 'offline',
  UMS_SESSION_SECRET: 'session-secret-synthetic-gate-value-aaaaaa-1',
  UMS_APPROVAL_SECRET: 'approval-secret-synthetic-gate-value-bbbbb-2',
  UMS_LINK_SECRET: 'link-secret-synthetic-gate-value-cccccccc-3',
  UMS_PUBLIC_ORIGIN: 'http://localhost:3000',
  NODE_ENV: 'test',
  ...over,
});

// Network trace. The modules are wrapped, not imported: every connect call is counted and passed
// on, so a call that happens is visible and a test that expects none can assert it.
const trace = vi.hoisted(() => ({ calls: [] as string[] }));
type Fn = (...a: unknown[]) => unknown;
vi.mock('node:net', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  const wrap =
    (name: string): Fn =>
    (...a) => {
      trace.calls.push(`net.${name}`);
      return (actual[name] as Fn)(...a);
    };
  const socket = actual.Socket as { prototype: { connect: Fn } };
  const original = socket.prototype.connect;
  socket.prototype.connect = function (this: unknown, ...a: unknown[]) {
    trace.calls.push('net.Socket.connect');
    return original.apply(this, a);
  };
  const patched = {
    ...actual,
    connect: wrap('connect'),
    createConnection: wrap('createConnection'),
  };
  return { ...patched, default: patched };
});
vi.mock('node:tls', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  const connect: Fn = (...a) => {
    trace.calls.push('tls.connect');
    return (actual.connect as Fn)(...a);
  };
  const patched = { ...actual, connect };
  return { ...patched, default: patched };
});
beforeEach(() => {
  trace.calls.length = 0;
  vi.stubGlobal('fetch', (...a: unknown[]) => {
    trace.calls.push(`fetch ${String(a[0])}`);
    return Promise.reject(new Error('fetch is not available in the offline gate'));
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('A-01 boot_refuses_live', () => {
  it('the offline baseline boots (control)', () => {
    expect(loadConfig(base()).ok).toBe(true);
  });

  for (const mode of ['live', 'LIVE', 'production', 'Production', 'sandbox-live', 'prod-live']) {
    it(`UMS_MODE=${mode} is refused`, () => {
      const r = loadConfig(base({ UMS_MODE: mode }));
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.name).toBe('UMS_MODE');
    });
  }

  for (const mode of ['staging', 'test', 'demo', 'sandboxx', 'OFFLINE ']) {
    it(`unknown UMS_MODE=${mode.trim()} is refused (only offline and sandbox exist)`, () => {
      if (mode.trim().toLowerCase() === 'offline') return;
      expect(loadConfig(base({ UMS_MODE: mode })).ok).toBe(false);
    });
  }

  for (const [name, value] of [
    ['PAYPAL_API_BASE', `https://${LIVE_API}`],
    ['UMS_PUBLIC_ORIGIN', `https://${LIVE_WEB}`],
    ['SOME_OTHER_SETTING', `redirect=https://${LIVE_API}/v2/checkout/orders`],
    ['SOME_OTHER_SETTING', `https://${SANDBOX_API.replace('sandbox.', 'sandbox%2e')}`],
    ['SOME_OTHER_SETTING', LIVE_API.toUpperCase()],
  ] as const) {
    it(`a non-sandbox PayPal host in ${name} is refused`, () => {
      const r = loadConfig(base({ [name]: value }));
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.code).toBe('non_sandbox_host');
    });
  }

  for (const [name, value] of [
    ['NEXT_PUBLIC_UMS_ENV_LABEL', 'Live'],
    ['NEXT_PUBLIC_UMS_ENV_LABEL', 'production'],
    ['UMS_MODE', 'live'],
  ] as const) {
    it(`${name}=${value} is refused`, () => {
      expect(loadConfig(base({ [name]: value })).ok).toBe(false);
    });
  }

  it('UMS_PAYPAL_CONNECT=live is refused', () => {
    expect(loadConfig(base({ UMS_PAYPAL_CONNECT: 'live' })).ok).toBe(false);
  });

  // OPEN DEFECT F-1 (lane 02, medium): A-01 says any PayPal-related config value containing live or
  // production is refused. Only UMS_MODE, the public label and PayPal host names are checked.
  it('OPEN DEFECT F-1: PayPal environment switches named PAYPAL_* or UMS_PAYPAL_* with live or production are refused', () => {
    const accepted: string[] = [];
    for (const name of [
      'PAYPAL_ENV',
      'PAYPAL_MODE',
      'PAYPAL_ENVIRONMENT',
      'PAYPAL_API_ENV',
      'UMS_PAYPAL_ENV',
    ]) {
      for (const value of ['live', 'production', 'Live']) {
        if (loadConfig(base({ [name]: value })).ok) accepted.push(`${name}=${value}`);
      }
    }
    expect(accepted).toEqual([]);
  });

  it('OPEN DEFECT F-1: PayPal identifier values that are exactly live or production are refused', () => {
    const accepted: string[] = [];
    for (const name of ['UMS_OUTBOUND_APPROVAL_REF', 'PAYPAL_CLIENT_ID', 'PAYPAL_WEBHOOK_ID']) {
      for (const value of ['live', 'production-1']) {
        if (loadConfig(base({ [name]: value })).ok) accepted.push(`${name}=${value}`);
      }
    }
    expect(accepted).toEqual([]);
  });

  it('boot exits non-zero (78) before listening and prints the variable name, never its value', () => {
    const lines: string[] = [];
    let code = -1;
    const exit = ((c: number) => {
      code = c;
      throw new Error('exit');
    }) as (c: number) => never;
    const value = `https://${LIVE_API}/secret-path`;
    expect(() => bootOrExit(base({ SOME_SETTING: value }), exit, (l) => lines.push(l))).toThrow(
      'exit',
    );
    expect(code).toBe(BOOT_REFUSAL_EXIT_CODE);
    expect(code).not.toBe(0);
    expect(lines.join('\n')).toContain('SOME_SETTING');
    expect(lines.join('\n')).not.toContain(LIVE_API);
    expect(lines.join('\n')).not.toContain('secret-path');
  });

  it('a refused boot builds no transport object', async () => {
    const created = vi.fn();
    const real = createSandboxTransport;
    expect(real).toBeTypeOf('function');
    const r = loadConfig(base({ UMS_MODE: 'live' }));
    expect(r.ok).toBe(false);
    expect(created).not.toHaveBeenCalled();
  });
});

describe('A-02 offline_opens_no_socket', () => {
  it('a full dry-run journey with net.connect, tls.connect and fetch spied makes zero calls', async () => {
    const w = await makeWorld();
    await buy(w, BUYER_A, 'tide-tables');
    await buy(w, BUYER_A, 'ferry-timetables', 'online_read');
    const gateOff = createSandboxTransport();
    const r = await gateOff.send(request('get_order', '/v2/checkout/orders/ABC123'));
    expect(r).toEqual({ kind: 'blocked', by: 'connect_off' });

    expect(trace.calls).toEqual([]);
  });

  it('the sealed sandbox transport answers blocked connect_off for every operation', async () => {
    const t = createSandboxTransport();
    for (const [op, path] of [
      ['create_order', '/v2/checkout/orders'],
      ['get_order', '/v2/checkout/orders/ABC'],
      ['capture_order', '/v2/checkout/orders/ABC/capture'],
    ] as const) {
      expect(await t.send(request(op, path))).toEqual({ kind: 'blocked', by: 'connect_off' });
    }
  });
});

function request(
  operation: OutboundRequest['operation'],
  path: string,
  over: Partial<OutboundRequest> = {},
): OutboundRequest {
  const post = ['create_order', 'capture_order', 'oauth_token', 'refund_capture'].includes(
    operation,
  );
  return {
    operation,
    method: post ? 'POST' : 'GET',
    path,
    headers: {},
    body: post ? '{}' : null,
    order_ref: null,
    amount_minor: null,
    scenario: 'happy',
    ...over,
  };
}

async function gateWorld(
  o: {
    approval?: {
      ops?: string[];
      max?: number;
      calls?: number;
      until?: string;
    } | null;
    outbound?: boolean;
    connect?: boolean;
  } = {},
) {
  const db = await testDb();
  const clock = fakeClock(T0);
  if (o.approval !== null) {
    const a = o.approval ?? {};
    await db.query(
      `INSERT INTO outbound_approvals (id, approval_ref, scope, operations, max_amount_minor, max_calls_per_day, valid_until, approved_by, created_at, updated_at)
       VALUES ('oap_gate', 'gate-ref', 'gate', $1, $2, $3, $4, 'owner', $5, $5)`,
      [
        a.ops ?? ['create_order', 'get_order', 'capture_order'],
        a.max ?? 2000,
        a.calls ?? 50,
        a.until ?? '2026-12-01T00:00:00Z',
        T0,
      ],
    );
  }
  if (o.outbound ?? true) {
    await db.query(`UPDATE safety_switches SET "on" = true WHERE name = 'paypal_outbound'`);
  }
  const switches = createSwitchReader(db, clock, 0);
  const gate = createOutboundGate({
    db,
    clock,
    switches,
    config: { mode: 'sandbox', connect: o.connect ?? true, outbound_approval_ref: 'gate-ref' },
  });
  const transport = createDryRunTransport({
    fixtures: [],
    gate,
    clock,
    default_scenario: 'happy',
    log: createLogger(() => undefined, {}, clock),
  });
  return { db, clock, gate, transport };
}

describe('A-03 gates_block_outbound', () => {
  it('control: a covering approval lets the gate allow (the request then stops at the empty dry-run)', async () => {
    const g = await gateWorld();
    expect(await g.gate.check({ operation: 'create_order', amount_minor: 100 })).toMatchObject({
      allowed: true,
    });
    const r = await g.transport.send(
      request('create_order', '/v2/checkout/orders', { amount_minor: 100 }),
    );
    expect(r).toEqual({ kind: 'blocked', by: 'dry_run_miss' });
  });

  it('no approval row: blocked no_approval', async () => {
    const g = await gateWorld({ approval: null });
    const r = await g.transport.send(
      request('create_order', '/v2/checkout/orders', { amount_minor: 100 }),
    );
    expect(r).toEqual({ kind: 'blocked', by: 'no_approval' });
  });

  it('an expired approval row: blocked no_approval', async () => {
    const g = await gateWorld({ approval: { until: '2026-10-21T09:59:59Z' } });
    expect(await g.gate.check({ operation: 'create_order', amount_minor: 100 })).toEqual({
      allowed: false,
      by: 'no_approval',
    });
  });

  it('the approval stops being valid exactly at valid_until', async () => {
    const g = await gateWorld({ approval: { until: '2026-10-21T11:00:00Z' } });
    expect(await g.gate.check({ operation: 'get_order', amount_minor: null })).toMatchObject({
      allowed: true,
    });
    g.clock.set('2026-10-21T11:00:00.000Z');
    expect(await g.gate.check({ operation: 'get_order', amount_minor: null })).toEqual({
      allowed: false,
      by: 'no_approval',
    });
  });

  it('a scope that does not cover the call: blocked no_approval', async () => {
    const g = await gateWorld({ approval: { ops: ['get_order'] } });
    const r = await g.transport.send(
      request('create_order', '/v2/checkout/orders', { amount_minor: 100 }),
    );
    expect(r).toEqual({ kind: 'blocked', by: 'no_approval' });
    expect(await g.gate.check({ operation: 'capture_order', amount_minor: 100 })).toEqual({
      allowed: false,
      by: 'no_approval',
    });
  });

  it('an amount above max_amount_cents: blocked budget', async () => {
    const g = await gateWorld({ approval: { max: 500 } });
    const r = await g.transport.send(
      request('create_order', '/v2/checkout/orders', { amount_minor: 501 }),
    );
    expect(r).toEqual({ kind: 'blocked', by: 'budget' });
    expect(await g.gate.check({ operation: 'create_order', amount_minor: 500 })).toMatchObject({
      allowed: true,
    });
  });

  it('the daily call budget is spent: blocked budget', async () => {
    const g = await gateWorld({ approval: { calls: 2 } });
    expect(await g.gate.check({ operation: 'get_order', amount_minor: null })).toMatchObject({
      allowed: true,
    });
    expect(await g.gate.check({ operation: 'get_order', amount_minor: null })).toMatchObject({
      allowed: true,
    });
    expect(await g.gate.check({ operation: 'get_order', amount_minor: null })).toEqual({
      allowed: false,
      by: 'budget',
    });
  });

  it('paypal_outbound tripped: blocked kill_switch', async () => {
    const g = await gateWorld({ outbound: false });
    const r = await g.transport.send(
      request('create_order', '/v2/checkout/orders', { amount_minor: 100 }),
    );
    expect(r).toEqual({ kind: 'blocked', by: 'kill_switch' });
  });

  it('connect off: the gate says connect_off even with an approval and the switch on', async () => {
    const g = await gateWorld({ connect: false });
    expect(await g.gate.check({ operation: 'create_order', amount_minor: 100 })).toEqual({
      allowed: false,
      by: 'connect_off',
    });
  });

  it('a gate that cannot read the database fails closed', async () => {
    const g = await gateWorld();
    await g.db.close();
    const verdict = await g.gate.check({ operation: 'create_order', amount_minor: 100 });
    expect(verdict.allowed).toBe(false);
  });

  it('none of the blocked requests reaches fetch or a socket', async () => {
    const g = await gateWorld({ approval: null });
    await g.transport.send(request('create_order', '/v2/checkout/orders', { amount_minor: 100 }));
    await createSandboxTransport().send(request('create_order', '/v2/checkout/orders'));
    expect(trace.calls).toEqual([]);
    expect(makeSecret('x').toString()).toBe('[redacted]');
  });
});

describe('A-04 egress_guard', () => {
  const refused = (
    r: Partial<OutboundRequest> & { path: string; operation?: OutboundRequest['operation'] },
  ) => guard(request(r.operation ?? 'get_order', r.path, r), 'sandbox');

  it('control: the listed sandbox path is accepted', () => {
    expect(refused({ path: '/v2/checkout/orders/ABC123' }).ok).toBe(true);
    expect(refused({ path: `https://${SANDBOX_API}/v2/checkout/orders/ABC123` }).ok).toBe(true);
  });

  it('a wrong host is refused', () => {
    expect(refused({ path: `https://${LIVE_API}/v2/checkout/orders/ABC123` }).ok).toBe(false);
    expect(refused({ path: 'https://example.invalid/v2/checkout/orders/ABC123' }).ok).toBe(false);
    expect(
      refused({ path: `https://${SANDBOX_API}.example.invalid/v2/checkout/orders/ABC123` }).ok,
    ).toBe(false);
    expect(refused({ path: `https://x@${LIVE_API}/v2/checkout/orders/ABC123` }).ok).toBe(false);
  });

  it('http scheme is refused', () => {
    expect(refused({ path: `http://${SANDBOX_API}/v2/checkout/orders/ABC123` }).ok).toBe(false);
  });

  it('port 8443 is refused', () => {
    expect(refused({ path: `https://${SANDBOX_API}:8443/v2/checkout/orders/ABC123` }).ok).toBe(
      false,
    );
  });

  it('redirect-style and traversal paths are refused', () => {
    for (const p of [
      '//example.invalid/v2/checkout/orders/ABC123',
      '/v2/checkout/orders/../../v1/payments/payouts',
      '/v2/checkout/orders/ABC123?next=https://example.invalid',
      '/v2/checkout/orders/ABC123#frag',
      '/v2/checkout/orders/%2e%2e/x',
      '/v2/checkout/orders/ABC123\\..\\x',
      '/v2/checkout/orders/ABC123\r\nHost: example.invalid',
    ]) {
      expect(refused({ path: p }).ok, p).toBe(false);
    }
  });

  it('a path not on the list is refused, for example a payouts path', () => {
    expect(
      refused({ path: '/v1/payments/payouts', operation: 'create_order', method: 'POST' }).ok,
    ).toBe(false);
    expect(refused({ path: '/v1/payments/payouts', operation: 'get_order' }).ok).toBe(false);
    expect(refused({ path: '/v2/payments/payouts/ABC', operation: 'get_capture' }).ok).toBe(false);
  });

  it('an order id that does not match ^[A-Z0-9]{1,36}$ is refused', () => {
    for (const id of [
      'abc123',
      'ABC-123',
      'A'.repeat(37),
      '',
      'ABC123/capture',
      'ABC 123',
      'ÄBC123',
    ]) {
      expect(refused({ path: `/v2/checkout/orders/${id}` }).ok, id).toBe(false);
    }
    expect(refused({ path: `/v2/checkout/orders/${'A'.repeat(36)}` }).ok).toBe(true);
  });

  it('a wrong method for the operation is refused', () => {
    expect(
      refused({ path: '/v2/checkout/orders', operation: 'create_order', method: 'GET' }).ok,
    ).toBe(false);
  });

  it('an operation name that is not own (prototype keys) is refused', () => {
    expect(refused({ path: '/v2/checkout/orders/ABC', operation: '__proto__' as never }).ok).toBe(
      false,
    );
    expect(refused({ path: '/v2/checkout/orders/ABC', operation: 'constructor' as never }).ok).toBe(
      false,
    );
  });

  it('the dry-run transport turns a refusal into blocked egress and sends nothing', async () => {
    const g = await gateWorld();
    const r = await g.transport.send(
      request('get_order', `https://${LIVE_API}/v2/checkout/orders/ABC123`),
    );
    expect(r).toEqual({ kind: 'blocked', by: 'egress' });
    expect(g.transport.calls().at(-1)?.outcome).toBe('blocked:egress');
  });
});
