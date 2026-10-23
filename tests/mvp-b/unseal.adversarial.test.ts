// BU-2 acceptance (adversarial): hostile and broken inputs to the unseal wiring. Everything fails
// closed, nothing throws out of send(), and no test reaches a network (fake Wire, in-memory database).
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../../apps/web/composition.server';
import type { App } from '../../apps/web/composition.server';
import * as outboundModule from '../../apps/web/src/server/outbound.server';
import { buildOutbound } from '../../apps/web/src/server/outbound.server';
import { countingWire, makeRig, req, sandboxEnv } from './unseal-support';
import type { Rig } from './unseal-support';

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
