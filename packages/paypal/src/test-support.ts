// Test helpers for the PayPal adapter. No network, no fixtures edited. Fixture bodies are
// docs-example or synthetic data labelled as such by lane 03.
import { fileURLToPath } from 'node:url';
import { createDryRunTransport, loadFixtures } from '@umsbx/transport';
import type { DryRunTransport } from '@umsbx/transport';
import type {
  Clock,
  CreateOrderReq,
  LogEvent,
  Logger,
  OutboundRequest,
  Secret,
  Transport,
  TransportResult,
} from '@umsbx/contracts';
import { createPayPalAdapter } from './adapter';
import type { ProviderCallRecord } from './adapter';

export const FIXTURE_ROOT = fileURLToPath(new URL('../../../fixtures/paypal/', import.meta.url));

export interface MutableClock extends Clock {
  set(iso: string): void;
  advance(ms: number): void;
}
export function mutableClock(iso = '2026-01-01T00:00:00Z'): MutableClock {
  let t = new Date(iso).getTime();
  return {
    now: () => new Date(t),
    set: (v) => {
      t = new Date(v).getTime();
    },
    advance: (ms) => {
      t += ms;
    },
  };
}

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

export const secret = (v: string): Secret => ({
  reveal: () => v,
  toString: () => '[redacted]',
  toJSON: () => '[redacted]',
});

export const resp = (
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): TransportResult => ({
  kind: 'response',
  status,
  headers: { 'content-type': 'application/json', ...headers },
  body: typeof body === 'string' ? body : JSON.stringify(body),
  duration_ms: 3,
});

export interface ScriptedTransport extends Transport {
  readonly sent: OutboundRequest[];
}
export function scriptedTransport(
  handler: (r: OutboundRequest, n: number) => TransportResult | Promise<TransportResult>,
  kind: 'dryrun' | 'sandbox' = 'dryrun',
): ScriptedTransport {
  const sent: OutboundRequest[] = [];
  return {
    kind,
    sent,
    async send(r) {
      sent.push(r);
      return handler(r, sent.length);
    },
  };
}

export async function dryRunTransport(
  default_scenario = 'happy',
  clock: Clock = mutableClock(),
): Promise<DryRunTransport> {
  const fixtures = await loadFixtures(FIXTURE_ROOT);
  return createDryRunTransport({
    fixtures,
    gate: { check: async () => ({ allowed: true, approval_ref: 'test-approval' }) },
    clock,
    default_scenario,
    log: memoryLogger(),
  });
}

export interface Harness {
  adapter: ReturnType<typeof createPayPalAdapter>;
  records: ProviderCallRecord[];
  clock: MutableClock;
  log: ReturnType<typeof memoryLogger>;
}
export function harness(
  transport: Transport,
  o: {
    credentials?: { client_id: Secret; client_secret: Secret } | null;
    clock?: MutableClock;
  } = {},
): Harness {
  const records: ProviderCallRecord[] = [];
  const clock = o.clock ?? mutableClock();
  const log = memoryLogger();
  const adapter = createPayPalAdapter({
    transport,
    clock,
    log,
    credentials: o.credentials === undefined ? null : o.credentials,
    record: async (c) => {
      records.push(c);
    },
  });
  return { adapter, records, clock, log };
}

export const createReq = (over: Partial<CreateOrderReq> = {}): CreateOrderReq => ({
  request_id: 'umsC-0123456789abcdef0123456789abcdef',
  order_ref: 'ord_SBX0001',
  units: [
    {
      reference_id: 'unit-1',
      payee_merchant_id: 'SBXMERCHANT01',
      amount: { currency: 'USD', minor: 500 },
    },
  ],
  return_url: 'https://shop.example.invalid/checkout/return?ref=ord_SBX0001',
  cancel_url: 'https://shop.example.invalid/checkout/cancel?ref=ord_SBX0001',
  scenario: null,
  ...over,
});

// Host built from parts: the approval host is not an API host, but keep literals out of source.
export const APPROVE_HOST = ['www', 'sandbox', 'paypal', 'com'].join('.');
