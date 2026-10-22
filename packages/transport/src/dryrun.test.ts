import { describe, expect, it } from 'vitest';
import { createDryRunTransport } from './dryrun';
import type { FixtureFile } from './fixture-schema';
import type { OutboundGate, TransportResult } from '@umsbx/contracts';
import { fixedClock, memoryLogger, openGate, req } from './test-support';

const fx = (
  scenario: string,
  operation: FixtureFile['meta']['operation'],
  step: number,
  response: FixtureFile['response'],
): FixtureFile => ({
  meta: {
    source: 'synthetic',
    scenario,
    operation,
    step,
    recorded_at: null,
    origin: 'unit test',
    redactions: [],
  },
  request: {
    method: operation === 'create_order' || operation === 'capture_order' ? 'POST' : 'GET',
    path_template:
      operation === 'create_order'
        ? '/v2/checkout/orders'
        : operation === 'capture_order'
          ? '/v2/checkout/orders/{id}/capture'
          : '/v2/checkout/orders/{id}',
    headers: {},
    body: null,
  },
  response,
});
const ok = (id: string): FixtureFile['response'] => ({
  status: 200,
  headers: { 'content-type': 'application/json' },
  body: { id },
});

const FIXTURES: FixtureFile[] = [
  fx('a', 'get_order', 1, ok('A1')),
  fx('a', 'get_order', 2, ok('A2')),
  fx('b', 'get_order', 1, ok('B1')),
  fx('a', 'create_order', 1, { status: 201, headers: {}, body: { id: 'NEW' } }),
  fx('a', 'capture_order', 1, { timeout: true }),
];
const make = (gate: OutboundGate = openGate(), default_scenario = 'a') => {
  const log = memoryLogger();
  const t = createDryRunTransport({
    fixtures: FIXTURES,
    gate,
    clock: fixedClock(),
    default_scenario,
    log,
  });
  return { t, log };
};
const get = (scenario: string | null = null) =>
  req('get_order', '/v2/checkout/orders/ABC123', { scenario });
const bodyOf = (r: TransportResult) => {
  if (r.kind !== 'response') throw new Error(`expected response, got ${r.kind}`);
  return JSON.parse(r.body) as unknown;
};

describe('dry-run transport', () => {
  it('is labelled dryrun', () => {
    expect(make().t.kind).toBe('dryrun');
  });

  it('dry-run answers by scenario and step', async () => {
    const { t } = make();
    expect(bodyOf(await t.send(get()))).toEqual({ id: 'A1' }); // default scenario, step 1
    expect(bodyOf(await t.send(get()))).toEqual({ id: 'A2' }); // step 2
    expect(bodyOf(await t.send(get('b')))).toEqual({ id: 'B1' }); // own counter per scenario
    // the create_order counter is independent from get_order
    const c = await t.send(req('create_order', '/v2/checkout/orders', { scenario: 'a' }));
    expect(c).toMatchObject({ kind: 'response', status: 201, body: '{"id":"NEW"}' });
  });

  it('returns the fixture headers, status and a duration from the injected clock', async () => {
    const { t } = make();
    const r = await t.send(get());
    expect(r).toEqual({
      kind: 'response',
      status: 200,
      headers: { 'content-type': 'application/json' },
      body: '{"id":"A1"}',
      duration_ms: 0,
    });
  });

  it('a timeout fixture answers { kind: timeout }', async () => {
    const { t } = make();
    const r = await t.send(req('capture_order', '/v2/checkout/orders/ABC123/capture'));
    expect(r).toEqual({ kind: 'timeout' });
  });

  it('request scenario overrides the default; default is used when null', async () => {
    const { t } = make(openGate(), 'b');
    expect(bodyOf(await t.send(get()))).toEqual({ id: 'B1' });
    expect(bodyOf(await t.send(get('a')))).toEqual({ id: 'A1' });
  });

  it('unmatched request is dry_run_miss', async () => {
    const { t } = make();
    await t.send(get());
    await t.send(get());
    // a third call has no step 3
    expect(await t.send(get())).toEqual({ kind: 'blocked', by: 'dry_run_miss' });
    // unknown scenario, and an operation the scenario has no fixture for
    expect(await t.send(get('nope'))).toEqual({ kind: 'blocked', by: 'dry_run_miss' });
    expect(await t.send(req('get_capture', '/v2/payments/captures/ABC123'))).toEqual({
      kind: 'blocked',
      by: 'dry_run_miss',
    });
  });

  it('gate verdicts kill_switch, no_approval, budget are returned as blocked', async () => {
    for (const by of ['kill_switch', 'no_approval', 'budget'] as const) {
      const { t } = make({ check: async () => ({ allowed: false, by }) });
      expect(await t.send(get())).toEqual({ kind: 'blocked', by });
    }
  });

  it('a blocked call does not consume a step', async () => {
    let open = false;
    const gate: OutboundGate = {
      check: async () =>
        open ? { allowed: true, approval_ref: 'x' } : { allowed: false, by: 'kill_switch' },
    };
    const { t } = make(gate);
    expect(await t.send(get())).toEqual({ kind: 'blocked', by: 'kill_switch' });
    open = true;
    expect(bodyOf(await t.send(get()))).toEqual({ id: 'A1' });
  });

  it('connect_off from the gate is ignored by the dry-run transport only', async () => {
    const { t } = make({ check: async () => ({ allowed: false, by: 'connect_off' }) });
    expect(bodyOf(await t.send(get()))).toEqual({ id: 'A1' });
  });

  it('consults the gate on every call with operation and amount', async () => {
    const seen: unknown[] = [];
    const { t } = make({
      check: async (c) => {
        seen.push(c);
        return { allowed: true, approval_ref: 'x' };
      },
    });
    await t.send(get());
    await t.send(req('create_order', '/v2/checkout/orders', { amount_minor: 500 }));
    await t.send(get('nope')); // a miss still consults the gate
    expect(seen).toEqual([
      { operation: 'get_order', amount_minor: null },
      { operation: 'create_order', amount_minor: 500 },
      { operation: 'get_order', amount_minor: null },
    ]);
  });

  it('every request passes the egress guard first; a refused request never reaches the gate', async () => {
    let gateCalls = 0;
    const { t } = make({
      check: async () => {
        gateCalls += 1;
        return { allowed: true, approval_ref: 'x' };
      },
    });
    const bad = req('get_order', '/v2/checkout/orders/lower');
    expect(await t.send(bad)).toEqual({ kind: 'blocked', by: 'egress' });
    expect(await t.send(req('get_order', 'https://evil.example/x'))).toEqual({
      kind: 'blocked',
      by: 'egress',
    });
    expect(gateCalls).toBe(0);
  });

  it('calls() keeps parsed POST bodies, redacts the authorization header, and records the outcome', async () => {
    const { t } = make();
    await t.send(
      req('create_order', '/v2/checkout/orders', {
        scenario: 'a',
        body: JSON.stringify({ intent: 'CAPTURE' }),
        headers: { authorization: 'secret-value', 'content-type': 'application/json' },
      }),
    );
    await t.send(req('get_order', '/v2/checkout/orders/lower'));
    const calls = t.calls();
    expect(calls).toHaveLength(2);
    expect(calls[0]).toMatchObject({
      operation: 'create_order',
      scenario: 'a',
      step: 1,
      body: { intent: 'CAPTURE' },
      outcome: 'response',
    });
    expect(calls[0]?.headers['authorization']).toBe('[redacted]');
    expect(calls[0]?.headers['content-type']).toBe('application/json');
    expect(JSON.stringify(calls)).not.toContain('secret-value');
    expect(calls[1]).toMatchObject({ outcome: 'blocked:egress', step: null });
  });

  it('calls() keeps an unparseable body as raw text and returns a copy', async () => {
    const { t } = make();
    await t.send(req('create_order', '/v2/checkout/orders', { scenario: 'a', body: 'not json' }));
    const calls = t.calls();
    expect(calls[0]?.body).toBe('not json');
    (calls as unknown[]).length = 0;
    expect(t.calls()).toHaveLength(1);
  });

  it('logs each call without bodies or headers', async () => {
    const { t, log } = make();
    await t.send(
      req('create_order', '/v2/checkout/orders', {
        scenario: 'a',
        body: '{"k":"body-marker"}',
        headers: { authorization: 'secret-value' },
      }),
    );
    expect(log.events.length).toBeGreaterThan(0);
    const text = JSON.stringify(log.events);
    expect(text).not.toContain('secret-value');
    expect(text).not.toContain('body-marker');
    expect(log.events[0]?.fields).toMatchObject({ operation: 'create_order', scenario: 'a' });
  });
});
