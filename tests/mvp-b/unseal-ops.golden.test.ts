// BU-2 acceptance (golden): the gate block of /ops, for each lock state, is the text in
// tests/mvp-b/golden/unseal-ops-gate.txt. The block is built by one pure function (gateLines) that the
// page renders line by line, so this text is what the operator reads. The last test checks the real
// opsSnapshot of a sandbox app against the same function.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { gateLines } from '../../apps/web/src/lib/gate-lines';
import type { OpsGate } from '../../apps/web/src/lib/gate-lines';
import { createApp, installApp } from '../../apps/web/composition.server';
import type { App } from '../../apps/web/composition.server';
import { countingWire } from './unseal-support';
import { REF, insertApproval, sandboxEnv, setOutboundSwitch } from './unseal-support';

vi.mock('server-only', () => ({}));
// Every rig opens and migrates its own in-memory database: slow on a loaded machine.
vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

const OK = {
  impl: 'node-https',
  env_override: false,
  builtins_intact: true,
  global_fetch_changed_since_load: false,
} as const;
const locks = (o: Partial<NonNullable<OpsGate['outbound']>['locks']> = {}) => ({
  l1_mode_sandbox: true,
  l2_connect_on: true,
  l3_approval_active: true,
  l4_switch_on: true,
  l5_credentials_and_wire_ok: true,
  ...o,
});
const sandbox = (
  o: Partial<NonNullable<OpsGate['outbound']>> & {
    selfcheck?: OpsGate['selfcheck'];
    connect?: boolean;
  } = {},
): OpsGate => {
  const l = o.locks ?? locks();
  const open = Object.values(l).every(Boolean);
  const blocked_by =
    o.blocked_by !== undefined
      ? o.blocked_by
      : open
        ? null
        : !l.l1_mode_sandbox || !l.l2_connect_on
          ? 'connect_off'
          : !l.l4_switch_on
            ? 'kill_switch'
            : !l.l3_approval_active
              ? 'no_approval'
              : 'egress';
  return {
    mode: 'sandbox',
    connect: o.connect ?? l.l2_connect_on,
    approval_ref_set: true,
    transport: 'unused for sandbox',
    outbound: {
      scope: 'mvp_b_polling',
      wire_kind: o.wire_kind ?? 'injected',
      locks: l,
      open,
      blocked_by,
      transport_built: o.transport_built ?? open,
    },
    selfcheck: o.selfcheck ?? null,
  };
};

const STATES: [string, OpsGate][] = [
  [
    'offline',
    {
      mode: 'offline',
      connect: false,
      approval_ref_set: false,
      transport: 'dry-run fixtures',
      outbound: null,
      selfcheck: null,
    },
  ],
  [
    'sandbox, all five locks open, transport built',
    sandbox({ selfcheck: OK, wire_kind: 'production' }),
  ],
  [
    'sandbox, all open, nothing sent yet',
    sandbox({ transport_built: false, selfcheck: OK, wire_kind: 'production' }),
  ],
  [
    'sandbox, L2 connect flag off',
    sandbox({ locks: locks({ l2_connect_on: false }), selfcheck: OK, wire_kind: 'production' }),
  ],
  [
    'sandbox, L3 no active approval',
    sandbox({
      locks: locks({ l3_approval_active: false }),
      selfcheck: OK,
      wire_kind: 'production',
    }),
  ],
  [
    'sandbox, L4 kill switch off',
    sandbox({ locks: locks({ l4_switch_on: false }), selfcheck: OK, wire_kind: 'production' }),
  ],
  [
    'sandbox, L5 environment override',
    sandbox({
      locks: locks({ l5_credentials_and_wire_ok: false }),
      selfcheck: { ...OK, env_override: true },
      wire_kind: 'production',
    }),
  ],
];

const text = (): string =>
  STATES.map(([name, g]) => `## ${name}\n${gateLines(g).join('\n')}\n`).join('\n');

describe('the /ops gate block', () => {
  it('matches the golden text for each lock state', () => {
    const golden = readFileSync(join(import.meta.dirname, 'golden/unseal-ops-gate.txt'), 'utf8');
    expect(text()).toBe(golden);
  });

  it('shows no value: no reference, no credential, no URL', () => {
    const t = text();
    for (const bad of ['DL-', 'placeholder', 'https://', 'Bearer', 'secret'])
      expect(t).not.toContain(bad);
  });
});

describe('the real snapshot', () => {
  let app: App | null = null;
  afterEach(async () => {
    await app?.close();
    app = null;
  });

  it('opsSnapshot of a sandbox app carries the lock state and renders through gateLines', async () => {
    app = createApp(await sandboxEnv(), { switch_cache_ms: 0, test_wire: countingWire().wire });
    installApp(app);
    await app.ready();
    const op = { kind: 'operator', operator_id: 'opr_demo', mfa: false } as const;
    // fresh database: no approval row, switch off (seeded off): L3 and L4 missing, the rest open
    const snap = await app.engine.opsSnapshot(op);
    expect(snap?.gate.outbound?.locks).toEqual(
      locks({ l3_approval_active: false, l4_switch_on: false }),
    );
    expect(snap?.gate.outbound?.blocked_by).toBe('kill_switch');
    // the transport line never says dry run in sandbox mode
    expect(snap?.gate.transport).not.toMatch(/dry/i);
    expect(snap?.gate.transport).toMatch(/sandbox/);
    expect(gateLines(snap!.gate).join('\n')).toContain('PayPal calls: blocked (kill_switch)');
    // Far-future expiry: this test runs the app on the real clock.
    await insertApproval(app.db, { ref: REF, valid_until: '2999-01-01T00:00:00Z' });
    await setOutboundSwitch(app.db, true);
    const open = await app.engine.opsSnapshot(op);
    expect(open?.gate.outbound?.open).toBe(true);
    expect(gateLines(open!.gate).join('\n')).toContain('PayPal calls: allowed by the five locks');
  });

  it('an offline app has no lock block', async () => {
    app = createApp(await sandboxEnv({ UMS_MODE: 'offline', UMS_PAYPAL_CONNECT: 'off' }), {
      switch_cache_ms: 0,
    });
    installApp(app);
    await app.ready();
    const snap = await app.engine.opsSnapshot({
      kind: 'operator',
      operator_id: 'opr_demo',
      mfa: false,
    });
    expect(snap?.gate.outbound).toBeNull();
    expect(snap?.gate.transport).toBe('dry-run fixtures');
    expect(gateLines(snap!.gate)[0]).toBe('Mode: offline');
  });
});
