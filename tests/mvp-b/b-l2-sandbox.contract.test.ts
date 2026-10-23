// BU-6 (B-L2): the owner-run sandbox subset.
//
// The owner part is NOT run through this file. A vitest worker always starts with --require and
// --conditions in its execArgv, which the transport guard refuses on purpose (transport_env_override),
// so a real call could never leave from here. The owner runs `pnpm sandbox:conformance`
// (scripts/sandbox-conformance.mjs), a plain Node process that builds the same subject over the
// app's own outbound builder and runs the same steps (ownerSubset).
//
// What this file holds, all offline:
//  - the guard: without UMS_SANDBOX_TESTS=1 the owner part is skipped, the owner subject is never
//    built and no socket opens; with the flag set under vitest it fails with the reason above;
//  - a rehearsal of the same steps through the real five locks (real scoped gate, real approved
//    transport) over a fake Wire that plays the order model. Nothing reaches a network.
// Simulation tests prove the modelled cases only, not PayPal compatibility.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { makeSecret } from '@umsbx/config';
import { createDryRunStack, ownerSubset, sandboxSubject } from '@umsbx/testkit';
import type { OutboundRequest, PayPalOperation } from '@umsbx/contracts';
import type { Wire, WireRequest, WireResult } from '@umsbx/transport';
import { FAKE_ID, FAKE_SECRET, makeRig } from './unseal-support';
import type { Rig, RigOptions } from './unseal-support';

vi.mock('server-only', () => ({}));
vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

// Vitest mirrors the environment into import.meta.env; only packages/config reads process.env (S3).
const viteEnv = (import.meta as { env?: Record<string, string | undefined> }).env;
const enabled = viteEnv?.['UMS_SANDBOX_TESTS'] === '1';
const OWN = 'SBXOWNMERCH01';

// ---- the owner part: skipped unless the flag is set; never builds anything here ----

const ownerSubjectBuilt = vi.fn();
function buildOwnerSubject(): never {
  ownerSubjectBuilt();
  throw new Error(
    'the owner part does not run under vitest: its workers carry --require and --conditions, which the transport guard refuses. Run `pnpm sandbox:conformance` in your own terminal.',
  );
}

describe.skipIf(!enabled)('B-L2 owner part (UMS_SANDBOX_TESTS=1)', () => {
  it('points at the real entry and makes no call', () => {
    expect(() => buildOwnerSubject()).toThrow(/pnpm sandbox:conformance/);
  });
});

describe('B-L2 guard', () => {
  it.skipIf(enabled)(
    'without UMS_SANDBOX_TESTS=1 the owner part is skipped, the subject is never built and no socket opens',
    () => {
      expect(ownerSubjectBuilt).not.toHaveBeenCalled();
      const open = process
        .getActiveResourcesInfo()
        .filter((r) => r === 'TCPSocketWrap' || r === 'TCPConnectWrap' || r === 'TLSWrap');
      expect(open).toEqual([]);
    },
  );
});

// ---- the rehearsal through the real locks ----

const opOf = (method: string, path: string): PayPalOperation | null => {
  if (path === '/v1/oauth2/token') return 'oauth_token';
  if (method === 'POST' && path === '/v2/checkout/orders') return 'create_order';
  if (method === 'POST' && /^\/v2\/checkout\/orders\/[A-Z0-9]+\/capture$/.test(path))
    return 'capture_order';
  if (method === 'GET' && /^\/v2\/checkout\/orders\/[A-Z0-9]+$/.test(path)) return 'get_order';
  if (method === 'GET' && /^\/v2\/payments\/captures\/[A-Z0-9]+$/.test(path)) return 'get_capture';
  return null;
};

/** A Wire that plays PayPal with the order model of the testkit. It opens no socket. */
type Tamper = (operation: PayPalOperation, body: Record<string, unknown>) => void;
async function modelWire(
  rig: { clock: Parameters<typeof createDryRunStack>[0]['clock'] },
  tamper?: Tamper,
) {
  const stack = await createDryRunStack({
    clock: rig.clock,
    default_scenario: null,
    own_merchant_id: OWN,
  });
  const created: string[] = [];
  const seen: WireRequest[] = [];
  const wire: Wire = {
    async request(r: WireRequest): Promise<WireResult> {
      seen.push(r);
      const path = new URL(r.url).pathname;
      const operation = opOf(r.method, path);
      if (operation === null) return { kind: 'error', error: 'other' };
      if (operation === 'oauth_token') {
        return {
          kind: 'response',
          status: 200,
          headers: { 'content-type': 'application/json', 'paypal-debug-id': 'dbgrehearsal01' },
          body: JSON.stringify({ access_token: 'placeholder-token-abcdef', expires_in: 32400 }),
        };
      }
      const req: OutboundRequest = {
        operation,
        method: r.method as 'GET' | 'POST',
        path,
        headers: r.headers,
        body: r.body,
        order_ref: null,
        amount_minor: null,
        scenario: null,
      };
      const res = await stack.transport.send(req);
      if (res.kind !== 'response') return { kind: 'error', error: 'other' };
      if (operation === 'create_order') {
        const id = (JSON.parse(res.body) as { id?: string }).id;
        if (id !== undefined) created.push(id);
      }
      if (tamper === undefined) {
        return { kind: 'response', status: res.status, headers: res.headers, body: res.body };
      }
      const b = JSON.parse(res.body) as Record<string, unknown>;
      tamper(operation, b);
      return {
        kind: 'response',
        status: res.status,
        headers: res.headers,
        body: JSON.stringify(b),
      };
    },
  };
  return { wire, stack, created, seen };
}

const rigs: Rig[] = [];
afterEach(async () => {
  for (const r of rigs.splice(0)) await r.close();
});

async function rehearse(o: RigOptions = {}, tamper?: Tamper) {
  // The Wire is built after the rig (it shares the rig's clock), so the rig gets a forwarding Wire.
  const holder: { m?: Awaited<ReturnType<typeof modelWire>> } = {};
  const lateWire: Wire = {
    request: (r) => (holder.m as NonNullable<typeof holder.m>).wire.request(r),
  };
  const rig = await makeRig({ ...o, wire: lateWire });
  rigs.push(rig);
  holder.m = await modelWire(rig, tamper);
  const m = holder.m;
  const lines: string[] = [];
  const subject = sandboxSubject({
    transport: rig.outbound.transport,
    clock: rig.clock,
    credentials: { client_id: makeSecret(FAKE_ID), client_secret: makeSecret(FAKE_SECRET) },
    own_merchant_id: OWN,
    stderr: (l) => lines.push(l),
    sleep: async () => {
      for (const id of m.created) m.stack.approve(id);
    },
  });
  const report = await ownerSubset(subject).runAll();
  return { rig, m, subject, lines, report };
}

describe('rehearsal through the real five locks (fake Wire, order model)', () => {
  it('all five open: every step passes, every Wire call goes to the sandbox host', async () => {
    const r = await rehearse();
    expect(r.report.stopped).toBeNull();
    expect(r.report.cases.map((c) => [c.id, c.pass])).toEqual([
      ['payee_echo', true],
      ['create_replay', true],
      ['capture_before_approval', true],
      ['approve_capture_replay', true],
      ['read_backs', true],
      ['lost_answer', true],
    ]);
    expect(r.lines).toContain('payee echo: own id');
    expect(r.m.seen.length).toBeGreaterThanOrEqual(12);
    for (const w of r.m.seen)
      expect(new URL(w.url).origin).toBe('https://api-m.sandbox.paypal.com');
    expect(await r.rig.reservations()).toBeGreaterThan(0);
  });
  const locks: [string, RigOptions, string][] = [
    ['L1 mode offline', { mode: 'offline' }, 'connect_off'],
    ['L2 connect off', { connect: false }, 'connect_off'],
    ['L3 no approval row', { approval: false }, 'no_approval'],
    ['L3 approval expired', { approval: { valid_until: '2026-10-23T09:00:00Z' } }, 'no_approval'],
    ['L4 kill switch off', { switch_on: false }, 'kill_switch'],
    ['L5 no credentials', { credentials: false }, 'egress'],
  ];
  it.each(locks)(
    '%s: the suite stops at the first call with %s and 0 Wire calls',
    async (_n, o, by) => {
      const r = await rehearse(o);
      expect(r.report.stopped?.code).toBe(by);
      expect(r.m.seen).toHaveLength(0);
      expect(await r.rig.reservations()).toBe(0);
      expect(r.report.cases.every((c) => !c.pass)).toBe(true);
      expect(r.lines).toContain('payee echo: STOP');
    },
  );
});

describe('D-028 end to end through the real gate under mvp_b_polling', () => {
  it('the create goes out without a payee and the read-back echoes our own id: payee echo: own id', async () => {
    const r = await rehearse();
    const create = r.m.seen.find((w) => new URL(w.url).pathname === '/v2/checkout/orders');
    expect(create?.body).not.toBeNull();
    expect(create?.body).not.toContain('payee');
    expect(r.lines).toContain('payee echo: own id');
    expect(r.report.payee_echo).toBe('own id');
  });
  const units = (b: Record<string, unknown>) => b.purchase_units as Record<string, unknown>[];
  it.each([
    [
      'another merchant id is echoed',
      (op: PayPalOperation, b: Record<string, unknown>) => {
        if (op === 'get_order')
          (units(b)[0] as Record<string, unknown>).payee = { merchant_id: 'SBXOTHERMERC2' };
      },
    ],
    [
      'no payee is echoed',
      (op: PayPalOperation, b: Record<string, unknown>) => {
        if (op === 'get_order') delete (units(b)[0] as Record<string, unknown>).payee;
      },
    ],
  ])(
    '%s: STOP, exactly token + create + read reach the Wire, no retry, no second create',
    async (_n, tamper) => {
      const r = await rehearse({}, tamper);
      expect(r.report.payee_echo).toBe('STOP');
      expect(r.lines).toContain('payee echo: STOP');
      expect(r.lines.some((l) => l.includes(OWN) || l.includes('SBXOTHERMERC2'))).toBe(false);
      const paths = r.m.seen.map((w) => `${w.method} ${new URL(w.url).pathname}`);
      expect(paths).toEqual([
        'POST /v1/oauth2/token',
        'POST /v2/checkout/orders',
        expect.stringMatching(/^GET \/v2\/checkout\/orders\/[A-Z0-9]+$/),
      ]);
      expect(r.report.cases.slice(1).every((c) => /^not run/.test(c.detail))).toBe(true);
    },
  );
});
