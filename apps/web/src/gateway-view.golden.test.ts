// INT-CTL / CTL.1: the gateway panel's words. Each lock and each BLOCKED_BY value maps to the sentence and the
// owner action of the spec table (F9, V4). No string holds a command that turns PayPal on, an env flag update or an
// approval ref, and the panel source has no form posting to approvals, env or start.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { BLOCKED_BY } from '@umsbx/contracts';
import { OWNER_ACTIONS, blockedByView, gatewayView } from './lib/gateway-view';
import type { LockView } from './lib/gate-lines';

const here = fileURLToPath(new URL('.', import.meta.url));
const code = (rel: string) =>
  readFileSync(join(here, rel), 'utf8')
    .replace(/\/\/.*$/gm, '')
    .replace(/\/\*[\s\S]*?\*\//g, '');

const ALL_OPEN: LockView = {
  l1_mode_sandbox: true,
  l2_connect_on: true,
  l3_approval_active: true,
  l4_switch_on: true,
  l5_credentials_and_wire_ok: true,
};
const CLOSED: LockView = {
  l1_mode_sandbox: false,
  l2_connect_on: false,
  l3_approval_active: false,
  l4_switch_on: false,
  l5_credentials_and_wire_ok: false,
};
const SPEC: Record<string, [string, string]> = {
  L1: ['The app runs offline (mode is not sandbox).', "Owner sets the host's mode setting `UMS_MODE`."],
  L2: ['The connect flag is off.', 'Owner only: see the owner runbook.'],
  L3: ['No active approval covers this call.', 'Owner runs `corepack pnpm safety:approve` at a terminal.'],
  L4: ['PayPal calls are switched off.', 'Use the Start button below.'],
  L5: ['Credentials or the wire self-check failed.', 'Owner checks the host secrets by name.'],
};
const BANNED = [/UMS_PAYPAL_CONNECT\s*=\s*on/i, /--update-env-vars/, /\bDL-[A-Za-z0-9-]+/, /approval_ref\s*=/i, /--set-env-vars/];

describe('each closed lock', () => {
  it('maps to the spec sentence and the fixed owner action', () => {
    const v = gatewayView({ mode: 'offline', locks: CLOSED });
    expect(v.locks.map((l) => l.lock)).toEqual(['L1', 'L2', 'L3', 'L4', 'L5']);
    for (const l of v.locks) {
      expect(l.open).toBe(false);
      expect([l.line, l.owner_action], l.lock).toEqual(SPEC[l.lock]);
    }
    expect(OWNER_ACTIONS).toEqual({
      L1: SPEC['L1']![1],
      L2: SPEC['L2']![1],
      L3: SPEC['L3']![1],
      L4: SPEC['L4']![1],
      L5: SPEC['L5']![1],
    });
  });

  it('an open lock has a line and no owner action; one closed lock shows only its own action', () => {
    const v = gatewayView({ mode: 'sandbox', locks: { ...ALL_OPEN, l3_approval_active: false } });
    for (const l of v.locks) {
      expect(l.line).toMatch(/\S/);
      expect(l.open, l.lock).toBe(l.lock !== 'L3');
      expect(l.owner_action === null, l.lock).toBe(l.lock !== 'L3');
    }
    expect(v.all_open).toBe(false);
    expect(gatewayView({ mode: 'sandbox', locks: ALL_OPEN }).all_open).toBe(true);
  });

  it('with no lock block (dry run) the panel says so and lists no lock', () => {
    const v = gatewayView({ mode: 'offline', locks: null });
    expect(v.locks).toEqual([]);
    expect(v.summary).toMatch(/offline|no PayPal contact/i);
  });
});

describe('each BLOCKED_BY value', () => {
  it('maps to a lock, a sentence and an owner action of the table', () => {
    const expected: Record<string, string> = {
      connect_off: 'L2',
      kill_switch: 'L4',
      no_approval: 'L3',
      budget: 'L3',
      egress: 'L5',
    };
    expect([...BLOCKED_BY].sort()).toEqual(Object.keys(expected).sort());
    for (const by of BLOCKED_BY) {
      const v = blockedByView(by);
      expect(v.lock, by).toBe(expected[by]);
      expect([v.line, v.owner_action], by).toEqual(SPEC[v.lock]);
    }
  });
});

describe('what the panel never says', () => {
  it('no line or action holds a connect-flag command, an env update or an approval ref', () => {
    const strings: string[] = [];
    for (const locks of [CLOSED, ALL_OPEN]) {
      const v = gatewayView({ mode: 'sandbox', locks });
      strings.push(v.summary, ...v.locks.flatMap((l) => [l.line, l.owner_action ?? '']));
    }
    for (const by of BLOCKED_BY) {
      const v = blockedByView(by);
      strings.push(v.line, v.owner_action);
    }
    strings.push(...Object.values(OWNER_ACTIONS));
    for (const s of strings) for (const b of BANNED) expect(s, `${s} vs ${b}`).not.toMatch(b);
    expect(strings.some((s) => s.length > 0)).toBe(true);
  });

  it('the panel and the view source have no form, no fetch, and no post to approvals, env or start', () => {
    for (const f of ['ui/ops/GatewayPanel.tsx', 'lib/gateway-view.ts']) {
      const src = code(f);
      expect(src, f).not.toMatch(/<form\b|\baction=|method=|fetch\(|XMLHttpRequest/);
      expect(src, f).not.toMatch(/\/api\/ops\/start|outbound_approvals|approvals|--update-env-vars|UMS_PAYPAL_CONNECT\s*=/i);
      expect(src, f).not.toMatch(/dangerouslySetInnerHTML|innerHTML/);
    }
  });
});
