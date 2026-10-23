// BU-2 acceptance (adversarial): hostile and broken inputs to the unseal wiring. Everything fails
// closed, nothing throws out of send(), and no test reaches a network (fake Wire, in-memory database).
import { afterEach, describe, expect, it, vi } from 'vitest';
import { makeSecret } from '@umsbx/config';
import type { CreateOrderReq } from '@umsbx/contracts';
import { DbInUseError } from '@umsbx/db';
import { createPayPalAdapter } from '@umsbx/paypal';
import { createApp } from '../../apps/web/composition.server';
import type { App } from '../../apps/web/composition.server';
import { bootOrExit } from '../../apps/web/src/server/boot';
import * as outboundModule from '../../apps/web/src/server/outbound.server';
import { buildOutbound } from '../../apps/web/src/server/outbound.server';
import {
  FAKE_ID,
  FAKE_SECRET,
  OTHER,
  OWN,
  bootOwn,
  countingWire,
  makeRig,
  req,
  sandboxEnv,
} from './unseal-support';
import type { OwnRig, Rig } from './unseal-support';

vi.mock('server-only', () => ({}));
// Every rig opens and migrates its own in-memory database: slow on a loaded machine.
vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });
vi.mock('../../apps/web/src/server/outbound.server', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../apps/web/src/server/outbound.server')>();
  return { ...actual, buildOutbound: vi.fn(actual.buildOutbound) };
});

const rigs: Rig[] = [];
const apps: App[] = [];
afterEach(async () => {
  for (const r of rigs.splice(0)) await r.close();
  for (const a of apps.splice(0)) await a.close();
  vi.mocked(outboundModule.buildOutbound).mockClear();
});

describe('test_wire and test-only options', () => {
  it('test_wire outside node_env test refuses boot', async () => {
    const { wire } = countingWire();
    for (const node_env of ['production', 'development']) {
      const env = await sandboxEnv({
        NODE_ENV: node_env,
        UMS_PUBLIC_ORIGIN: 'https://demo.example.test',
      });
      expect(() => createApp(env, { test_wire: wire }), node_env).toThrow(/test_wire/);
    }
    // inside node_env test it is accepted
    const ok = createApp(await sandboxEnv(), { test_wire: wire });
    apps.push(ok);
    expect(ok.outbound).not.toBeNull();
  });

  it('the other test-only option is refused outside node_env test too', async () => {
    const env = await sandboxEnv({
      NODE_ENV: 'production',
      UMS_PUBLIC_ORIGIN: 'https://demo.example.test',
    });
    expect(() => createApp(env, { test_domain: { reread_paid_every_ms: 1 } })).toThrow(/test_/);
  });

  it('offline mode never calls buildOutbound, with or without a test_wire, through boot, jobs and ops', async () => {
    const offline = createApp(
      await sandboxEnv({ UMS_MODE: 'offline', UMS_PAYPAL_CONNECT: 'off' }),
      {
        switch_cache_ms: 0,
      },
    );
    apps.push(offline);
    await offline.ready();
    const jobs = await offline.startJobs();
    await jobs.stop();
    expect(offline.outbound).toBeNull();
    expect(vi.mocked(outboundModule.buildOutbound)).not.toHaveBeenCalled();
    const sandbox = createApp(await sandboxEnv(), { test_wire: countingWire().wire });
    apps.push(sandbox);
    expect(vi.mocked(outboundModule.buildOutbound)).toHaveBeenCalledTimes(1);
  });

  it('composition hands buildOutbound the test wire or null, never a string', async () => {
    const { wire } = countingWire();
    const app = createApp(await sandboxEnv(), { test_wire: wire });
    apps.push(app);
    const arg = vi.mocked(outboundModule.buildOutbound).mock.calls[0]?.[0];
    expect(arg?.wire).toBe(wire);
  });
});

describe('the first requests', () => {
  it('two concurrent first requests build one transport', async () => {
    const r = await makeRig();
    rigs.push(r);
    const results = await Promise.all(
      Array.from({ length: 8 }, () => r.outbound.transport.send(req.getOrder())),
    );
    expect(results.every((x) => x.kind === 'response')).toBe(true);
    expect(r.log.events.filter((e) => e.msg === 'outbound.transport_built')).toHaveLength(1);
    expect(r.counting.calls).toHaveLength(8);
    expect(await r.reservations()).toBe(8);
  });

  it('a build that fails once is retried by a later request, and a failure never throws out of send()', async () => {
    const r = await makeRig();
    rigs.push(r);
    // a gate that hands out a forged capability first and nothing real afterwards
    const forged = Object.freeze({
      scope: 'mvp_b_polling',
      approval_ref: 'x',
      gate: { check: async () => ({ allowed: true, approval_ref: 'x' }) },
    });
    const bad = buildOutbound(r.deps, {
      gate: {
        check: async () => ({ allowed: true, approval_ref: 'x' }),
        activeApproval: async () => ({ scope: 'mvp_b_polling', approval_ref: 'x' }),
        approvalCapability: async () => forged as never,
      },
    });
    for (let i = 0; i < 3; i += 1) {
      await expect(bad.transport.send(req.getOrder())).resolves.toEqual({
        kind: 'blocked',
        by: 'no_approval',
      });
    }
    expect(r.counting.calls).toHaveLength(0);
  });
});

describe("capabilities that are not this registry's own", () => {
  const lookalikes: [string, (real?: unknown) => unknown][] = [
    [
      'a frozen object with the right fields (what a capability from another module registry looks like here)',
      () =>
        Object.freeze({
          scope: 'mvp_b_polling',
          approval_ref: 'x',
          gate: { check: async () => ({ allowed: true, approval_ref: 'x' }) },
        }),
    ],
    [
      'an unfrozen object literal',
      () => ({
        scope: 'mvp_b_polling',
        approval_ref: 'x',
        gate: { check: async () => ({ allowed: true }) },
      }),
    ],
    [
      'a proxy over a literal',
      () => new Proxy({ scope: 'mvp_b_polling', approval_ref: 'x', gate: {} }, {}),
    ],
    ['an empty object', () => ({})],
    ['a string', () => 'capability'],
  ];
  it.each(lookalikes)(
    'a capability minted in another module registry is refused and the call is blocked: %s',
    async (_n, make) => {
      const r = await makeRig();
      rigs.push(r);
      const out = buildOutbound(r.deps, {
        gate: {
          check: async () => ({ allowed: true, approval_ref: 'x' }),
          activeApproval: async () => ({ scope: 'mvp_b_polling', approval_ref: 'x' }),
          approvalCapability: async () => make() as never,
        },
      });
      expect(await out.transport.send(req.getOrder())).toEqual({
        kind: 'blocked',
        by: 'no_approval',
      });
      expect(r.counting.calls).toHaveLength(0);
      expect((await out.status()).transport_built).toBe(false);
      expect(r.log.events.some((e) => e.msg === 'outbound.build_failed')).toBe(true);
    },
  );
});

describe('broken sources fail closed', () => {
  it('a database that throws while the approval is read: blocked, no Wire call, no throw', async () => {
    const r = await makeRig();
    rigs.push(r);
    const broken = buildOutbound({
      ...r.deps,
      db: {
        dialect: 'pglite',
        query: async () => {
          throw new Error('db gone');
        },
        exec: async () => {
          throw new Error('db gone');
        },
        transaction: async () => {
          throw new Error('db gone');
        },
      },
    });
    const res = await broken.transport.send(req.getOrder());
    expect(res.kind).toBe('blocked');
    expect(r.counting.calls).toHaveLength(0);
    const st = await broken.status();
    expect(st.open).toBe(false);
  });

  it('a Wire that throws or answers rubbish never crashes send() and never opens a second path', async () => {
    const r = await makeRig({
      answer: () => {
        throw new Error('wire exploded');
      },
    });
    rigs.push(r);
    const res = await r.outbound.transport.send(req.getOrder());
    expect(res.kind).toBe('network_error');
    const r2 = await makeRig({
      answer: () => ({ kind: 'response', status: 99999, headers: {}, body: 1 as never }),
    });
    rigs.push(r2);
    expect((await r2.outbound.transport.send(req.getOrder())).kind).toBe('network_error');
  });

  it('status() leaks no credential, no approval ref and no URL', async () => {
    const r = await makeRig();
    rigs.push(r);
    await r.outbound.transport.send(req.getOrder());
    const text = JSON.stringify(await r.outbound.status());
    for (const bad of ['placeholder', 'DL-2026', 'https://', 'Bearer'])
      expect(text).not.toContain(bad);
  });

  it('with the production Wire selected and an override present, nothing is built and no socket is made', async () => {
    const r = await makeRig({
      wire: null,
      selfcheck: () => ({
        impl: 'node-https',
        env_override: true,
        builtins_intact: true,
        global_fetch_changed_since_load: true,
      }),
    });
    rigs.push(r);
    expect(await r.outbound.transport.send(req.getOrder())).toEqual({
      kind: 'blocked',
      by: 'egress',
    });
    expect(r.log.events.some((e) => e.msg === 'outbound.transport_built')).toBe(false);
    expect(r.outbound.selfcheck()?.env_override).toBe(true);
  });

  it('a hostile request (extra field, wrong method) is refused by the schema before anything else', async () => {
    const r = await makeRig();
    rigs.push(r);
    const hostile = { ...req.getOrder(), extra: 'x' } as never;
    expect(await r.outbound.transport.send(hostile)).toEqual({ kind: 'blocked', by: 'egress' });
    expect(r.counting.calls).toHaveLength(0);
  });
});

describe('boot failure with the real DbInUseError (ASM-73, CO-9)', () => {
  it('one stderr line carrying the literal message, then exit 78; the Stop button it names exists', async () => {
    const written: string[] = [];
    const exits: number[] = [];
    await bootOrExit({
      start: async () => {
        throw new DbInUseError(4242);
      },
      exit: (c) => void exits.push(c),
      write: (l) => void written.push(l),
      exitCode: async () => 78,
    });
    expect(exits).toEqual([78]);
    const text = written.join('');
    expect(text.split('\n').filter((l) => l !== '')).toHaveLength(1);
    expect(text).toContain('DbInUseError');
    expect(text).toContain(
      'The UnitMarket app (pid 4242) holds this database. Stop it first, or use the ops page Stop button.',
    );
  });
});

// ---- BU-7 (D-028): the omission is for our own merchant id and nothing else ----
describe('BU-7 own payee (D-028)', () => {
  let rig: OwnRig | null = null;
  const small: Rig[] = [];
  afterEach(async () => {
    if (rig !== null) await rig.close();
    rig = null;
    for (const r of small.splice(0)) await r.close();
  });
  const tokenOrEmpty = (r: { url: string }) =>
    new URL(r.url).pathname === '/v1/oauth2/token'
      ? {
          kind: 'response' as const,
          status: 200,
          headers: { 'content-type': 'application/json', 'paypal-debug-id': 'dbgbu70001' },
          body: JSON.stringify({
            access_token: ['bu7', 'tok', 'placeholder'].join('-'),
            token_type: 'Bearer',
            expires_in: 3600,
          }),
        }
      : {
          kind: 'response' as const,
          status: 200,
          headers: { 'content-type': 'application/json', 'paypal-debug-id': 'dbgbu70002' },
          body: '{}',
        };

  // An entitlement row exists from placement, locked. Access is any row that is not locked or whose
  // money is not pending.
  const NO_ACCESS = `SELECT count(*) AS c FROM entitlements WHERE access_state <> 'locked' OR money_state NOT IN ('pending', 'unknown')`;

  const stripPayee = (units: Record<string, unknown>[]) =>
    units.map((u) => {
      const copy = { ...u };
      delete copy['payee'];
      return copy;
    });

  async function checkoutAndReturn(r: OwnRig, scenario: string | null = 'happy') {
    const order = await r.placeOrder();
    const co = await r.app.engine.payments.beginCheckout({
      order_id: order.order_id,
      actor: r.actor,
    });
    expect(co.ok).toBe(true);
    expect(r.model.approve(await r.providerOrderId(order.order_id), scenario)).toBe(true);
    await r.app.engine.payments.onBuyerReturn({ order_ref: order.order_ref, actor: r.actor });
    return order;
  }

  describe('another payee under mvp_b_polling stays blocked before the gate', () => {
    it('a publisher whose payee is not our own id: create is refused, nothing but the token call reaches the Wire', async () => {
      rig = await bootOwn({ publisher_payee: OTHER });
      const order = await rig.placeOrder();
      const co = await rig.app.engine.payments.beginCheckout({
        order_id: order.order_id,
        actor: rig.actor,
      });
      expect(co.ok).toBe(false);
      expect(rig.ops()).not.toContain('create_order');
      expect(rig.played.every((p) => !(p.body ?? '').includes('purchase_units'))).toBe(true);
      expect(rig.lines.some((l) => l.includes('payee_not_allowed'))).toBe(true);
      // the gate was never asked for a create: reservations equal the calls that went out
      expect(
        await rig.count(`SELECT count(*) AS c FROM audit_log WHERE action = 'gate.reserve'`),
      ).toBe(rig.played.length);
    }, 60_000);

    it('own id unset: even a payee that is our real id is never left out, so the create is refused', async () => {
      rig = await bootOwn({ own: null, publisher_payee: OWN });
      const order = await rig.placeOrder();
      const co = await rig.app.engine.payments.beginCheckout({
        order_id: order.order_id,
        actor: rig.actor,
      });
      expect(co.ok).toBe(false);
      expect(rig.ops()).not.toContain('create_order');
      expect(rig.lines.some((l) => l.includes('payee_not_allowed'))).toBe(true);
    }, 60_000);

    it('the same id in another case is another payee: refused', async () => {
      rig = await bootOwn({ publisher_payee: OWN.toLowerCase() });
      const order = await rig.placeOrder();
      const co = await rig.app.engine.payments.beginCheckout({
        order_id: order.order_id,
        actor: rig.actor,
      });
      expect(co.ok).toBe(false);
      expect(rig.ops()).not.toContain('create_order');
    }, 60_000);

    it('a body that names our own id as payee is still refused by the scope (the transport does not know the own id)', async () => {
      const r = await makeRig();
      small.push(r);
      const base = req.createOrder();
      const body = JSON.parse(base.body ?? '{}') as { purchase_units: Record<string, unknown>[] };
      body.purchase_units[0]!['payee'] = { merchant_id: OWN };
      const res = await r.outbound.transport.send({ ...base, body: JSON.stringify(body) });
      expect(res).toEqual({ kind: 'blocked', by: 'egress' });
      expect(r.log.events.filter((e) => e.msg === 'sandbox.send').at(-1)?.fields['reason']).toBe(
        'payee_not_allowed',
      );
      expect(r.counting.calls).toHaveLength(0);
      expect(await r.reservations()).toBe(0);
    });

    it('own id copied into another publisher unit: that unit keeps its payee and the order is refused before the gate', async () => {
      const r = await makeRig({ answer: tokenOrEmpty });
      small.push(r);
      const adapter = createPayPalAdapter({
        transport: r.outbound.transport,
        clock: r.clock,
        log: r.log,
        credentials: { client_id: makeSecret(FAKE_ID), client_secret: makeSecret(FAKE_SECRET) },
        record: async () => undefined,
        own_merchant_id: OWN,
      });
      const order: CreateOrderReq = {
        request_id: 'umsC-bu7-0123456789abcdef0123456789abcdef',
        order_ref: 'ord_BU7ADV1',
        units: [
          {
            reference_id: 'unit-1',
            payee_merchant_id: OWN,
            amount: { currency: 'USD', minor: 100 },
          },
          {
            reference_id: 'unit-2',
            payee_merchant_id: OTHER,
            amount: { currency: 'USD', minor: 100 },
          },
        ],
        return_url: 'https://shop.example.invalid/checkout/return?ref=ord_BU7ADV1',
        cancel_url: 'https://shop.example.invalid/checkout/cancel?ref=ord_BU7ADV1',
        scenario: null,
      };
      const res = await adapter.createOrder(order);
      expect(res.kind).toBe('blocked');
      const orderCalls = r.counting.calls.filter((c) => c.url.includes('/v2/checkout/orders'));
      expect(orderCalls).toHaveLength(0);
      expect(r.counting.calls.every((c) => !(c.body ?? '').includes(OTHER))).toBe(true);
      expect(r.log.events.filter((e) => e.msg === 'sandbox.send').at(-1)?.fields['reason']).toBe(
        'payee_not_allowed',
      );
    });
  });

  describe('a read-back that does not echo our own id freezes the order', () => {
    const frozenFlow = async (r: OwnRig, scenario: string | null) => {
      const order = await checkoutAndReturn(r, scenario);
      expect(await r.statusRow(order.order_ref)).toBe('frozen');
      expect(await r.count(NO_ACCESS)).toBe(0);
      // let the job loop run: no second create, no second capture, still frozen
      const jobs = await r.app.startJobs();
      await new Promise((resolve) => setTimeout(resolve, 600));
      await jobs.stop();
      expect(r.ops().filter((o) => o === 'create_order')).toHaveLength(1);
      // the buyer-return read of the order already compares the payee: no capture is ever sent
      expect(r.ops().filter((o) => o === 'get_order').length).toBeGreaterThanOrEqual(1);
      expect(r.ops().filter((o) => o === 'capture_order')).toHaveLength(0);
      expect(await r.statusRow(order.order_ref)).toBe('frozen');
      expect(await r.count(NO_ACCESS)).toBe(0);
      expect(
        await r.count(
          "SELECT count(*) AS c FROM ledger_entries l JOIN order_units u ON u.id = l.unit_id WHERE u.order_id = $1 AND l.kind = 'sale'",
          [order.order_id],
        ),
      ).toBe(0);
      const creates = r.played.filter((p) => p.operation === 'create_order');
      expect(creates.every((p) => p.body === creates[0]?.body)).toBe(true);
    };

    it('PayPal echoes no payee: mismatch, frozen, one create, no capture, no access', async () => {
      rig = await bootOwn({ tamper: stripPayee });
      await frozenFlow(rig, 'happy');
    }, 90_000);

    it('PayPal echoes another merchant id: mismatch, frozen, one create, no capture, no access', async () => {
      rig = await bootOwn();
      await frozenFlow(rig, 'mismatch_payee');
    }, 90_000);

    it('the order model has no own id and echoes nothing for the omitted payee: frozen (a wrong setup is caught)', async () => {
      rig = await bootOwn({ model_payee: null });
      await frozenFlow(rig, 'happy');
    }, 90_000);

    it('the create body that went out never named a payee, and the same bytes would be resent on a retry', async () => {
      rig = await bootOwn({ tamper: stripPayee });
      await checkoutAndReturn(rig, 'happy');
      const create = rig.played.find((p) => p.operation === 'create_order');
      expect(create?.body).toBeTruthy();
      expect(create?.body).not.toContain('payee');
      expect(create?.body).not.toContain(OWN);
    }, 60_000);
  });
});
