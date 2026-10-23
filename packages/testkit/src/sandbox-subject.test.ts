// BU-6: the owner-run sandbox subject, offline. Every transport here is a double: nothing opens a
// socket, nothing reads the environment, the credentials are obviously fake placeholders.
// Simulation tests prove the modelled cases only, not PayPal compatibility.
import { describe, expect, it } from 'vitest';
import { makeSecret } from '@umsbx/config';
import { buildRecordings } from '@umsbx/transport';
import type { Clock, OutboundRequest, Transport, TransportResult } from '@umsbx/contracts';
import {
  createDryRunStack,
  fakeClock,
  ownerSubset,
  renderOwnerSummary,
  sandboxSubject,
} from './index';
import type { DryRunStack } from './index';

const OWN = 'SBXOWNMERCH01';
const OTHER = 'SBXOTHERMERC2';
const LINK_LINE =
  'Open this link in a browser signed in as the sandbox Personal account, approve, then come back: ';
const creds = () => ({
  client_id: makeSecret('placeholder-client-id'),
  client_secret: makeSecret('placeholder-client-secret'),
});
const NOW = '2026-11-02T08:30:00.000Z';
const clockAt = (iso = NOW): Clock => fakeClock(iso as never);

// ---- doubles ----

const json = (status: number, body: unknown, debug = 'dbgdouble0001'): TransportResult => ({
  kind: 'response',
  status,
  headers: { 'content-type': 'application/json', 'paypal-debug-id': debug },
  body: JSON.stringify(body),
  duration_ms: 3,
});
const TOKEN = json(200, { access_token: 'placeholder-token-abcdef', expires_in: 32400 });
const orderBody = (id: string, status: string) => ({
  id,
  status,
  intent: 'CAPTURE',
  purchase_units: [
    {
      reference_id: 'unit-1',
      custom_id: 'ord_x',
      amount: { currency_code: 'USD', value: '1.00' },
      payee: { merchant_id: OWN },
    },
  ],
  create_time: NOW,
  update_time: NOW,
});

interface Scripted {
  transport: Transport;
  sent: OutboundRequest[];
}
/** A sandbox-kind transport that answers the token itself and gets_order from a status list. */
function scriptedOrders(statuses: string[], id = 'ORDER00123456'): Scripted {
  const sent: OutboundRequest[] = [];
  let reads = 0;
  const transport: Transport = {
    kind: 'sandbox',
    async send(r) {
      sent.push(r);
      if (r.operation === 'oauth_token') return TOKEN;
      if (r.operation === 'get_order') {
        const s = statuses[Math.min(reads, statuses.length - 1)] ?? 'CREATED';
        reads += 1;
        return json(200, orderBody(id, s));
      }
      return { kind: 'blocked', by: 'dry_run_miss' };
    },
  };
  return { transport, sent };
}

/** The order model of the dry-run stack behind a sandbox-kind transport that also answers the token. */
async function modelTransport(
  clock: Clock,
  rewrite?: (r: OutboundRequest, res: TransportResult) => TransportResult,
): Promise<{ transport: Transport; stack: DryRunStack; created: string[]; sent: OutboundRequest[] }> {
  const stack = await createDryRunStack({ clock, default_scenario: null });
  const created: string[] = [];
  const sent: OutboundRequest[] = [];
  const transport: Transport = {
    kind: 'sandbox',
    async send(r) {
      sent.push(r);
      if (r.operation === 'oauth_token') return TOKEN;
      const res = await stack.transport.send(r);
      if (r.operation === 'create_order' && res.kind === 'response') {
        const id = (JSON.parse(res.body) as { id?: string }).id;
        if (id !== undefined) created.push(id);
      }
      return rewrite === undefined ? res : rewrite(r, res);
    },
  };
  return { transport, stack, created, sent };
}

function subjectOver(
  transport: Transport,
  o: {
    clock?: Clock;
    own?: string | null;
    sleep?: (ms: number) => Promise<void>;
  } = {},
) {
  const lines: string[] = [];
  const subject = sandboxSubject({
    transport,
    clock: o.clock ?? clockAt(),
    credentials: creds(),
    own_merchant_id: o.own === undefined ? OWN : o.own,
    stderr: (l) => lines.push(l),
    sleep: o.sleep ?? (async () => undefined),
  });
  return { subject, lines };
}

// ---- construction ----

describe('sandboxSubject construction', () => {
  const ok = scriptedOrders(['CREATED']).transport;
  const base = {
    transport: ok,
    clock: clockAt(),
    credentials: creds(),
    own_merchant_id: OWN,
  };
  it('refuses a missing transport, clock or credentials, and a transport that is not the sandbox', () => {
    expect(() => (sandboxSubject as (o?: unknown) => unknown)()).toThrow(/transport/);
    expect(() => sandboxSubject({ ...base, transport: undefined as never })).toThrow(/transport/);
    expect(() => sandboxSubject({ ...base, clock: undefined as never })).toThrow(/clock/);
    expect(() => sandboxSubject({ ...base, credentials: undefined as never })).toThrow(
      /credentials/,
    );
    const dry: Transport = { kind: 'dryrun', send: async () => ({ kind: 'timeout' }) };
    expect(() => sandboxSubject({ ...base, transport: dry })).toThrow(/sandbox/);
  });
  it('builds nothing and sends nothing until make() is called', () => {
    const s = scriptedOrders(['CREATED']);
    subjectOver(s.transport);
    expect(s.sent).toEqual([]);
  });
  it('uses the injected clock, not a fixed one', async () => {
    const s = scriptedOrders(['CREATED']);
    const { subject } = subjectOver(s.transport, { clock: clockAt('2031-05-06T07:08:09.000Z') });
    const { port } = await subject.make();
    const o = await port.getOrder('ORDER00123456');
    expect(o.kind).toBe('order');
    if (o.kind === 'order') expect(o.read_at.startsWith('2031-05-06T07:08:09')).toBe(true);
  });
  it('orderRequest pays our own merchant id, at most 1.00 USD, and is unique per call and per run', () => {
    const s = scriptedOrders(['CREATED']);
    const a = subjectOver(s.transport, { clock: clockAt('2031-05-06T07:08:09.000Z') }).subject;
    const b = subjectOver(s.transport, { clock: clockAt('2031-05-06T09:10:11.000Z') }).subject;
    const r1 = a.orderRequest();
    const r2 = a.orderRequest();
    expect(r1.units[0]?.payee_merchant_id).toBe(OWN);
    expect(r1.units[0]?.amount).toEqual({ currency: 'USD', minor: 100 });
    expect(r1.request_id).not.toBe(r2.request_id);
    expect(b.orderRequest().request_id).not.toBe(r1.request_id);
  });
});

// ---- the approve hook ----

describe('hooks.approve', () => {
  const URL_ = 'https://www.sandbox.paypal.com/checkoutnow?token=ORDER00123456';
  it('prints the link once, exactly, and polls GET order every 3 s until APPROVED', async () => {
    const s = scriptedOrders(['CREATED', 'CREATED', 'APPROVED']);
    const sleeps: number[] = [];
    const { subject, lines } = subjectOver(s.transport, {
      sleep: async (ms) => void sleeps.push(ms),
    });
    const { hooks } = await subject.make();
    await hooks.approve('ORDER00123456', URL_);
    expect(lines).toEqual([`${LINK_LINE}${URL_}`]);
    expect(sleeps).toEqual([3000, 3000]);
    expect(s.sent.filter((r) => r.operation === 'get_order')).toHaveLength(3);
  });
  it('does not sleep or print again once approved on the first read', async () => {
    const s = scriptedOrders(['APPROVED']);
    const sleeps: number[] = [];
    const { subject, lines } = subjectOver(s.transport, {
      sleep: async (ms) => void sleeps.push(ms),
    });
    const { hooks } = await subject.make();
    await hooks.approve('ORDER00123456', URL_);
    expect(lines).toHaveLength(1);
    expect(sleeps).toEqual([]);
  });
  it('gives up after 6 minutes: 120 reads, 119 sleeps of 3 s, and says so', async () => {
    const s = scriptedOrders(['CREATED']);
    const sleeps: number[] = [];
    const { subject } = subjectOver(s.transport, { sleep: async (ms) => void sleeps.push(ms) });
    const { hooks } = await subject.make();
    await expect(hooks.approve('ORDER00123456', URL_)).rejects.toThrow(/did not approve/);
    expect(s.sent.filter((r) => r.operation === 'get_order')).toHaveLength(120);
    expect(sleeps).toHaveLength(119);
    expect(sleeps.every((m) => m === 3000)).toBe(true);
  });
  it('falls back to the link the create answer carried when the caller passes none', async () => {
    const clock = clockAt();
    const m = await modelTransport(clock);
    const { subject, lines } = subjectOver(m.transport, {
      clock,
      sleep: async () => {
        for (const id of m.created) m.stack.approve(id);
      },
    });
    const { port, hooks } = await subject.make();
    const created = await port.createOrder(subject.orderRequest());
    expect(created.kind).toBe('created');
    if (created.kind !== 'created') return;
    await hooks.approve(created.provider_order_id);
    expect(lines).toEqual([`${LINK_LINE}${created.approve_url}`]);
  });
  it('sentUrls lists only guard-accepted sandbox URLs', async () => {
    const s = scriptedOrders(['APPROVED']);
    const { subject } = subjectOver(s.transport);
    const { hooks, port } = await subject.make();
    await port.getOrder('ORDER00123456');
    expect(hooks.sentUrls().length).toBeGreaterThanOrEqual(2);
    for (const u of hooks.sentUrls()) expect(u.startsWith('https://api-m.sandbox.')).toBe(true);
  });
});

// ---- the owner subset, end to end against the order model ----

async function runSubset(
  o: {
    own?: string | null;
    rewrite?: (r: OutboundRequest, res: TransportResult) => TransportResult;
    only?: 'payee-echo';
  } = {},
) {
  const clock = clockAt();
  const m = await modelTransport(clock, o.rewrite);
  const { subject, lines } = subjectOver(m.transport, {
    clock,
    own: o.own,
    sleep: async () => {
      for (const id of m.created) m.stack.approve(id);
    },
  });
  const run = ownerSubset(subject);
  const report = await run.runAll(o.only === undefined ? {} : { only: o.only });
  return { report, lines, subject, m, run };
}

describe('the owner subset', () => {
  it('passes against the order model: echo, replay, early capture, approve, capture, replay, reads, lost answer', async () => {
    const { report, lines, subject, m } = await runSubset();
    expect(report.cases.map((c) => [c.id, c.pass])).toEqual([
      ['payee_echo', true],
      ['create_replay', true],
      ['capture_before_approval', true],
      ['approve_capture_replay', true],
      ['read_backs', true],
      ['lost_answer', true],
    ]);
    expect(report.stopped).toBeNull();
    expect(report.payee_echo).toBe('own id');
    expect(lines.filter((l) => l.startsWith(LINK_LINE))).toHaveLength(2);
    expect(lines).toContain('payee echo: own id');
    // two orders, each well under the 20 call cap; polls are not counted
    expect(m.created).toHaveLength(2);
    expect(subject.callLog().length).toBeLessThanOrEqual(40);
    const lost = report.cases.find((c) => c.id === 'lost_answer');
    expect(lost?.detail).toMatch(/exactly one capture/);
  });
  it('the lost answer: the capture reached the service, the subject never saw the answer', async () => {
    const { subject, m } = await runSubset();
    const captures = m.sent.filter((r) => r.operation === 'capture_order');
    // order A: early (rejected), real, replay; order B: the lost one
    expect(captures).toHaveLength(4);
    const log = subject.callLog();
    expect(log.some((e) => e.scenario === 'lost_answer' && e.operation === 'capture_order')).toBe(
      true,
    );
  });
  it('no printed line holds the own merchant id or an order id in full', async () => {
    const { lines, m } = await runSubset();
    for (const l of lines) {
      expect(l).not.toContain(OWN);
      if (!l.startsWith(LINK_LINE)) for (const id of m.created) expect(l).not.toContain(id);
    }
  });
  it('only: payee-echo runs the first case alone and sends nothing after the read', async () => {
    const { report, m } = await runSubset({ only: 'payee-echo' });
    expect(report.cases.map((c) => c.id)).toEqual(['payee_echo']);
    expect(report.payee_echo).toBe('own id');
    expect(m.sent.map((r) => r.operation)).toEqual(['oauth_token', 'create_order', 'get_order']);
  });
});

describe('payee echo (D-028): STOP means no further call and no retry', () => {
  const stopAfterRead = (name: string, opts: Parameters<typeof runSubset>[0]) =>
    it(name, async () => {
      const { report, lines, m } = await runSubset(opts);
      expect(report.payee_echo).toBe('STOP');
      expect(lines).toContain('payee echo: STOP');
      expect(lines.some((l) => l.includes(OWN) || l.includes(OTHER))).toBe(false);
      expect(report.cases[0]?.pass).toBe(false);
      expect(report.cases.slice(1).every((c) => !c.pass && /not run/.test(c.detail))).toBe(true);
      // one token, one create, one read; nothing else, and no second create with another body
      expect(m.sent.map((r) => r.operation)).toEqual(['oauth_token', 'create_order', 'get_order']);
    });
  const withBody = (patch: (b: Record<string, unknown>) => void) =>
    (r: OutboundRequest, res: TransportResult): TransportResult => {
      if (r.operation !== 'get_order' || res.kind !== 'response') return res;
      const b = JSON.parse(res.body) as Record<string, unknown>;
      patch(b);
      return { ...res, body: JSON.stringify(b) };
    };
  const unit = (b: Record<string, unknown>) =>
    (b.purchase_units as Record<string, unknown>[])[0] as Record<string, unknown>;
  stopAfterRead('another merchant id is echoed', {
    rewrite: withBody((b) => {
      unit(b).payee = { merchant_id: OTHER };
    }),
  });
  stopAfterRead('no payee is echoed', {
    rewrite: withBody((b) => {
      delete unit(b).payee;
    }),
  });
  stopAfterRead('the read answers with an error', {
    rewrite: (r, res) =>
      r.operation === 'get_order'
        ? json(500, { name: 'INTERNAL_SERVER_ERROR', message: 'x', debug_id: 'dbg500' })
        : res,
  });
  stopAfterRead('the echo differs only by case', {
    rewrite: withBody((b) => {
      unit(b).payee = { merchant_id: OWN.toLowerCase() };
    }),
  });
  it('an unset own merchant id stops before any call', async () => {
    const { report, lines, m } = await runSubset({ own: null });
    expect(report.payee_echo).toBe('STOP');
    expect(lines).toContain('payee echo: STOP');
    expect(m.sent).toEqual([]);
  });
});

// ---- the log and the summary ----

describe('call log and summary', () => {
  it('the call log is redacted, in the record:fixtures input format, and the recorder accepts it', async () => {
    const { subject, report } = await runSubset();
    expect(report.stopped).toBeNull();
    const log = subject.callLog();
    const text = JSON.stringify(log);
    expect(text).not.toContain('placeholder-token');
    expect(text).not.toContain('placeholder-client');
    expect(text).not.toMatch(/Basic [A-Za-z0-9+/=]{8,}/);
    expect(text).not.toMatch(/Bearer [A-Za-z0-9]/);
    for (const e of log) {
      expect(typeof e.scenario).toBe('string');
      expect(e.request.headers['authorization'] ?? '[redacted]').toBe('[redacted]');
    }
    const built = buildRecordings(log, {
      recorded_at: NOW,
      origin: 'sandbox-recording: BU-6 offline rehearsal against the order model',
    });
    expect(built.ok).toBe(true);
  });
  it('the log holds no personal data even when an order read carries a payer', async () => {
    const { subject } = await runSubset({
      rewrite: (r, res) => {
        if (r.operation !== 'get_order' || res.kind !== 'response') return res;
        const b = JSON.parse(res.body) as Record<string, unknown>;
        b.payer = {
          email_address: 'buyer.person@example.invalid',
          payer_id: 'PAYERID1234567',
          name: { given_name: 'Pat', surname: 'Doe' },
        };
        return { ...res, body: JSON.stringify(b) };
      },
    });
    const text = JSON.stringify(subject.callLog());
    expect(text).not.toContain('buyer.person');
    expect(text).not.toContain('PAYERID1234567');
    expect(text).not.toContain('"Pat"');
    expect(text).not.toContain('Doe');
  });
  it('the summary shows case, result, HTTP status, debug id, and ids cut to their last 6 characters', async () => {
    const { report, m } = await runSubset();
    const md = renderOwnerSummary(report, { date: '2026-11-02' });
    expect(md).toContain('2026-11-02');
    for (const c of report.cases) expect(md).toContain(c.title);
    expect(md).toMatch(/PASS/);
    expect(md).toMatch(/\|\s*20[01]\s*\|/);
    expect(md).toMatch(/sbxmodel\d{4}/);
    for (const id of m.created) {
      expect(md).not.toContain(id);
      expect(md).toContain(id.slice(-6));
    }
    expect(md).not.toContain(OWN);
  });
  it('a stopped run says which lock stopped it and shows FAIL', async () => {
    const sealed: Transport = { kind: 'sandbox', send: async () => ({ kind: 'blocked', by: 'no_approval' }) };
    const { subject } = subjectOver(sealed);
    const run = ownerSubset(subject);
    const report = await run.runAll();
    const md = renderOwnerSummary(report, { date: '2026-11-02' });
    expect(md).toContain('no_approval');
    expect(md).toMatch(/FAIL/);
    expect(md).not.toMatch(/PASS/);
  });
});
