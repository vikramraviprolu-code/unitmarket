import net from 'node:net';
import tls from 'node:tls';
import http from 'node:http';
import https from 'node:https';
import dns from 'node:dns';
import { vi } from 'vitest';
import { mintApprovalCapability } from './approval';
import type { ApprovalCapability } from './approval';
import type { ScopedGate, Wire, WireRequest, WireResult } from './wire';
import type {
  Clock,
  LogEvent,
  Logger,
  OutboundGate,
  OutboundRequest,
  PayPalOperation,
} from '@umsbx/contracts';

// Host strings are assembled at runtime so no source file carries a live or sandbox hostname
// literal (scripts/check-no-live-host.mjs).
export const LIVE_HOST = ['api-m', 'paypal', 'com'].join('.');
export const LIVE_WWW = ['www', 'paypal', 'com'].join('.');
export const SANDBOX_HOST = ['api-m', 'sandbox', 'paypal', 'com'].join('.');
export const CERT_HOST = ['api', 'sandbox', 'paypal', 'com'].join('.');

export const fixedClock = (iso = '2026-01-01T00:00:00Z'): Clock => ({ now: () => new Date(iso) });

export function memoryLogger(): Logger & { events: LogEvent[] } {
  const events: LogEvent[] = [];
  const make = (base: LogEvent['fields']): Logger => ({
    log: (e) => {
      events.push({ ...e, fields: { ...base, ...e.fields } });
    },
    child: (f) => make({ ...base, ...f }),
  });
  return Object.assign(make({}), { events });
}

export const openGate = (): OutboundGate => ({
  check: async () => ({ allowed: true, approval_ref: 'test-approval' }),
});

export function req(
  operation: PayPalOperation,
  path: string,
  over: Partial<OutboundRequest> = {},
): OutboundRequest {
  const posts: PayPalOperation[] = [
    'oauth_token',
    'create_order',
    'capture_order',
    'refund_capture',
    'verify_webhook_postback',
  ];
  const method = posts.includes(operation) ? 'POST' : 'GET';
  return {
    operation,
    method,
    path,
    headers: { authorization: 'redacted-for-test' },
    body: method === 'POST' ? '{}' : null,
    order_ref: null,
    amount_minor: null,
    scenario: null,
    ...over,
  };
}

// ---- B-L1: fake Wire, scoped gate and network spies (no real network anywhere) ----

export interface FakeWire extends Wire {
  readonly requests: WireRequest[];
}
export function fakeWire(
  handler: (r: WireRequest, n: number) => WireResult | Promise<WireResult> = () => ({
    kind: 'response',
    status: 200,
    headers: { 'content-type': 'application/json' },
    body: '{}',
  }),
): FakeWire {
  const requests: WireRequest[] = [];
  return {
    requests,
    async request(r) {
      requests.push(structuredClone(r));
      return handler(r, requests.length);
    },
  };
}

export interface FakeGate extends ScopedGate {
  readonly checks: {
    operation: PayPalOperation;
    amount_minor: number | null;
    scope?: string;
    approval_ref?: string;
  }[];
}

/**
 * Test-only: mint a capability from a fake gate's own report. Production code gets one only from
 * `@umsbx/safety` createScopedGate. Throws when the gate reports no approval.
 */
export async function approvalFrom(gate: ScopedGate, scope?: string): Promise<ApprovalCapability> {
  const a = await gate.activeApproval();
  if (a === null) throw new Error('fake gate has no approval');
  return mintApprovalCapability({
    scope: scope ?? a.scope,
    approval_ref: a.approval_ref,
    gate,
  });
}
export function scopedGate(
  o: {
    scope?: string | null;
    verdict?: () => unknown;
  } = {},
): FakeGate {
  const checks: FakeGate['checks'] = [];
  const scope = o.scope === undefined ? 'mvp_b_polling' : o.scope;
  return {
    checks,
    activeApproval: async () => (scope === null ? null : { scope, approval_ref: 'appr-test' }),
    check: async (c) => {
      checks.push({
        operation: c.operation,
        amount_minor: c.amount_minor,
        ...(c.scope === undefined ? {} : { scope: c.scope }),
        ...(c.approval_ref === undefined ? {} : { approval_ref: c.approval_ref }),
      });
      return (o.verdict ? o.verdict() : { allowed: true, approval_ref: 'appr-test' }) as Awaited<
        ReturnType<OutboundGate['check']>
      >;
    },
  };
}

/** Spies on every way Node can open a connection or resolve a name. Call `assertZero()` last. */
export function netSpies() {
  const spies = {
    'net.connect': vi.spyOn(net, 'connect'),
    'net.createConnection': vi.spyOn(net, 'createConnection'),
    'net.Socket.connect': vi.spyOn(net.Socket.prototype, 'connect'),
    'tls.connect': vi.spyOn(tls, 'connect'),
    'http.request': vi.spyOn(http, 'request'),
    'http.get': vi.spyOn(http, 'get'),
    'https.request': vi.spyOn(https, 'request'),
    'https.get': vi.spyOn(https, 'get'),
    'dns.lookup': vi.spyOn(dns, 'lookup'),
    'dns.resolve': vi.spyOn(dns, 'resolve'),
    'dns.promises.lookup': vi.spyOn(dns.promises, 'lookup'),
    'global fetch': vi.spyOn(globalThis, 'fetch'),
  };
  return {
    spies,
    counts: () =>
      Object.fromEntries(Object.entries(spies).map(([k, s]) => [k, s.mock.calls.length])),
    assertZero(): void {
      const bad = Object.entries(spies)
        .filter(([, s]) => s.mock.calls.length > 0)
        .map(([k]) => k);
      if (bad.length > 0) throw new Error(`network use detected: ${bad.join(', ')}`);
    },
  };
}
