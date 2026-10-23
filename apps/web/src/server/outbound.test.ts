// BU-2 unit tests for buildOutbound: the decisions made before anything is built (the five locks),
// with fakes only. A fake gate never yields a capability, so nothing here can build a transport or
// reach a Wire; the real gate, the real database and the built transport are in tests/mvp-b/unseal-*.
import { describe, expect, it, vi } from 'vitest';
import type { Clock, LogEvent, Logger, SwitchReader } from '@umsbx/contracts';
import { buildOutbound } from './outbound.server';
import type { OutboundDeps } from './outbound.server';

vi.mock('server-only', () => ({}));

const clock: Clock = { now: () => new Date('2026-10-23T10:00:00Z') };
const FAKE_ID = ['placeholder', 'client', 'id'].join('-');
const REQ = {
  operation: 'get_order',
  method: 'GET',
  path: '/v2/checkout/orders/ABC123',
  headers: { authorization: 'Bearer placeholder-token' },
  body: null,
  order_ref: null,
  amount_minor: null,
  scenario: null,
} as const;

function logger(): Logger & { events: LogEvent[] } {
  const events: LogEvent[] = [];
  const make = (): Logger => ({ log: (e) => void events.push(e), child: () => make() });
  return Object.assign(make(), { events });
}

function setup(
  o: {
    mode?: 'offline' | 'sandbox';
    connect?: boolean;
    credentials?: boolean;
    switch_on?: boolean;
    wire?: DepsWire;
    selfcheck?: OutboundDeps['selfcheck'];
    switches?: SwitchReader;
    scope?: string;
  } = {},
) {
  const log = logger();
  const wireCalls: unknown[] = [];
  const fakeWire = {
    async request(r: unknown) {
      wireCalls.push(r);
      return { kind: 'error' as const, error: 'other' as const };
    },
  };
  const switches: SwitchReader = o.switches ?? { isOn: async () => o.switch_on !== false };
  const gate = {
    check: async () => ({ allowed: false as const, by: 'no_approval' as const }),
    activeApproval: async () => null,
    approvalCapability: async () => null,
  };
  const deps: OutboundDeps = {
    config: {
      mode: o.mode ?? 'sandbox',
      connect: o.connect ?? true,
      outbound_approval_ref: 'ref-1',
      outbound_scope: (o.scope ?? 'mvp_b_polling') as 'mvp_b_polling',
      paypal:
        o.credentials === false
          ? null
          : ({ client_id: { reveal: () => FAKE_ID } } as unknown as NonNullable<
              OutboundDeps['config']['paypal']
            >),
    },
    db: {} as OutboundDeps['db'],
    clock,
    log,
    switches,
    wire: o.wire === undefined ? fakeWire : o.wire,
    ...(o.selfcheck === undefined ? {} : { selfcheck: o.selfcheck }),
  };
  return { out: buildOutbound(deps, { gate }), log, wireCalls, deps };
}
type DepsWire = OutboundDeps['wire'];

describe('buildOutbound: the pre-build decision, in the order of the gate', () => {
  it('L1 (mode) and L2 (connect flag) answer connect_off', async () => {
    for (const o of [{ mode: 'offline' as const }, { connect: false }]) {
      const s = setup(o);
      expect(await s.out.transport.send(REQ)).toEqual({ kind: 'blocked', by: 'connect_off' });
      expect(s.wireCalls).toEqual([]);
    }
  });
  it('L4 (kill switch off) answers kill_switch, before the approval is looked at', async () => {
    const s = setup({ switch_on: false });
    expect(await s.out.transport.send(REQ)).toEqual({ kind: 'blocked', by: 'kill_switch' });
  });
  it('L3 (no capability from the gate) answers no_approval', async () => {
    const s = setup();
    expect(await s.out.transport.send(REQ)).toEqual({ kind: 'blocked', by: 'no_approval' });
    expect(s.log.events.some((e) => e.msg === 'outbound.transport_built')).toBe(false);
    // no capability means no build attempt at all (not an attempt that fails)
    expect(s.log.events.some((e) => e.msg === 'outbound.build_failed')).toBe(false);
  });
  it('connect_off wins over kill_switch, kill_switch over no_approval', async () => {
    const s = setup({ connect: false, switch_on: false });
    expect(await s.out.transport.send(REQ)).toEqual({ kind: 'blocked', by: 'connect_off' });
  });
  it('a switch reader that throws counts as the kill switch being off', async () => {
    const s = setup({
      switches: {
        isOn: async () => {
          throw new Error('db down');
        },
      },
    });
    expect(await s.out.transport.send(REQ)).toEqual({ kind: 'blocked', by: 'kill_switch' });
  });
  it('L5: no credentials in config, or a failed self-check of the production Wire, reads as the lock missing', async () => {
    // (the answer for a request is egress once L3 is open: tests/mvp-b/unseal-locks.state.test.ts)
    const l5 = async (o: Parameters<typeof setup>[0]) =>
      (await setup(o).out.status()).locks.l5_credentials_and_wire_ok;
    expect(await l5({ credentials: false })).toBe(false);
    // wire null selects the production Wire, which the self-check then vets
    const check = (over: Partial<ReturnType<NonNullable<OutboundDeps['selfcheck']>>>) => () => ({
      impl: 'node-https' as const,
      env_override: false,
      builtins_intact: true,
      global_fetch_changed_since_load: false,
      ...over,
    });
    expect(await l5({ wire: null, selfcheck: check({}) })).toBe(true);
    expect(await l5({ wire: null, selfcheck: check({ env_override: true }) })).toBe(false);
    expect(await l5({ wire: null, selfcheck: check({ builtins_intact: false }) })).toBe(false);
    // a changed global fetch is a report only: the production Wire never uses it
    expect(
      await l5({ wire: null, selfcheck: check({ global_fetch_changed_since_load: true }) }),
    ).toBe(true);
    expect(
      await l5({
        wire: null,
        selfcheck: () => {
          throw new Error('probe broke');
        },
      }),
    ).toBe(false);
  });
  it('a self-check that throws reads as the worst case: override present and builtins not intact', () => {
    const s = setup({
      wire: null,
      selfcheck: () => {
        throw new Error('probe broke');
      },
    });
    expect(s.out.selfcheck()).toEqual({
      impl: 'node-https',
      env_override: true,
      builtins_intact: false,
      global_fetch_changed_since_load: false,
    });
  });
  it('an injected Wire is not vetted by the production Wire self-check', async () => {
    const s = setup({
      selfcheck: () => {
        throw new Error('must not be asked');
      },
    });
    expect((await s.out.status()).locks.l5_credentials_and_wire_ok).toBe(true);
    expect(s.out.selfcheck()).toBeNull();
  });
});

describe('buildOutbound: status() and the shape of what it returns', () => {
  it('reports which lock is missing, as booleans and the scope, and carries no value', async () => {
    const s = setup({ connect: false });
    const st = await s.out.status();
    expect(st.scope).toBe('mvp_b_polling');
    expect(st.locks).toEqual({
      l1_mode_sandbox: true,
      l2_connect_on: false,
      l3_approval_active: false,
      l4_switch_on: true,
      l5_credentials_and_wire_ok: true,
    });
    expect(st.open).toBe(false);
    expect(st.blocked_by).toBe('connect_off');
    expect(st.transport_built).toBe(false);
    const text = JSON.stringify(st);
    expect(text).not.toContain(FAKE_ID);
    expect(text).not.toContain('ref-1');
    for (const v of Object.values(st.locks)) expect(typeof v).toBe('boolean');
  });
  it('status() never throws: a failing source reads as the lock being missing', async () => {
    const s = setup({
      switches: {
        isOn: async () => {
          throw new Error('x');
        },
      },
    });
    const st = await s.out.status();
    expect(st.locks.l4_switch_on).toBe(false);
    expect(st.open).toBe(false);
  });
  it('the transport is a sandbox transport', () => {
    expect(setup().out.transport.kind).toBe('sandbox');
  });
});

describe('buildOutbound: logging and argument checks', () => {
  it('logs a block once per reason change, not once per request', async () => {
    const s = setup();
    for (let i = 0; i < 5; i += 1) await s.out.transport.send(REQ);
    expect(s.log.events.filter((e) => e.msg === 'outbound.blocked')).toHaveLength(1);
    expect(s.log.events.find((e) => e.msg === 'outbound.blocked')?.fields).toMatchObject({
      by: 'no_approval',
    });
  });
  it('the wire argument is required: undefined or a non-Wire throws, only null means production', () => {
    const s = setup();
    for (const bad of [undefined, 'production', 1, {}, { request: 'no' }]) {
      expect(() => buildOutbound({ ...s.deps, wire: bad as unknown as DepsWire }, {})).toThrow(
        TypeError,
      );
    }
    expect(() => buildOutbound({ ...s.deps, wire: null }, {})).not.toThrow();
  });
  it('no log line carries the credential placeholder or the request authorization header', async () => {
    const s = setup();
    await s.out.transport.send(REQ);
    const text = JSON.stringify(s.log.events);
    expect(text).not.toContain(FAKE_ID);
    expect(text).not.toContain('placeholder-token');
  });
});
