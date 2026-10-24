// CO-3 state tests: the verdict to answer table, and the invalid-delivery limiter of the public webhook
// route (COST-3: 60 a minute per address; a valid delivery is never limited). Real app, real PGlite,
// injected certificate source, a key pair made at run time. Time is a fake Date.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_RATES } from '@umsbx/security';
import { answerFor, webhookAllowed } from './server/webhook';
import type { WebhookResponse } from './server/webhook';
import { NOW_MS, bootWebhookApp, certsFor, delivery, eventBody, forger } from './webhook-support';
import type { WebhookRig } from './webhook-support';

vi.mock('server-only', () => ({}));

let rig: WebhookRig;
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW_MS);
});
afterEach(async () => {
  await rig?.close();
  vi.useRealTimers();
});

let seq = 0;
const fresh = (over: { type?: string } = {}) => {
  seq += 1;
  return delivery(eventBody({ id: `WH-STATE-${seq}`, ...over }), { id: `TR-STATE-${seq}` });
};
const tampered = () => {
  seq += 1;
  const good = delivery(eventBody({ id: `WH-STATE-${seq}` }), { id: `TR-STATE-${seq}` });
  return { ...good, raw_body: good.raw_body.replace('Synthetic', 'Tampered') };
};
const malformed = () => ({
  headers: { 'paypal-transmission-id': 'only-one-header' },
  raw_body: '{}',
});

describe('verdict to answer table (through the route)', () => {
  it('verified 200, duplicate 200, bad_signature 400, malformed 400, unverifiable 503, disabled 503', async () => {
    rig = await bootWebhookApp();
    const d = fresh();
    expect((await rig.post(d)).status).toBe(200); // verified: stored, enqueued or no_op
    expect((await rig.post(d)).status).toBe(200); // duplicate
    expect((await rig.post(tampered())).status).toBe(400); // bad_signature
    expect(
      (await rig.post(delivery(eventBody({ id: 'WH-F' }), { key: forger.privateKey }))).status,
    ).toBe(400); // bad_signature: the forger's key
    expect((await rig.post(malformed())).status).toBe(400); // malformed
    // unverifiable: the certificate cannot be had
    await rig.close();
    rig = await bootWebhookApp({
      certs: certsFor(undefined, () => ({ kind: 'unavailable', why: 'fetch' })),
    });
    expect((await rig.post(fresh())).status).toBe(503);
    expect(await rig.count('SELECT count(*) AS c FROM webhook_events')).toBe(0);
    // disabled: the switch is off, so no certificate is fetched either
    await rig.close();
    rig = await bootWebhookApp();
    await rig.app.db.query(
      `UPDATE safety_switches SET "on" = false WHERE name = 'webhook_enabled'`,
    );
    const off = await rig.post(fresh());
    expect(off.status).toBe(503);
    expect(rig.certs?.calls).toEqual([]);
    expect(await rig.count('SELECT count(*) AS c FROM webhook_events')).toBe(0);
    expect(
      await rig.count('SELECT count(*) AS c FROM audit_log WHERE action LIKE $1', ['webhook.%']),
    ).toBe(0);
  });

  it('the engine names the outcome: enqueued/no_op, duplicate, rejected, unverifiable, disabled', async () => {
    rig = await bootWebhookApp();
    const d = fresh();
    expect((await rig.app.engine.webhook(d)).outcome).toBe('no_op'); // no order of ours named
    expect(await rig.app.engine.webhook(d)).toEqual({ http: 200, outcome: 'duplicate' });
    expect(await rig.app.engine.webhook(tampered())).toEqual({ http: 400, outcome: 'rejected' });
    expect(await rig.app.engine.webhook(malformed())).toEqual({ http: 400, outcome: 'rejected' });
    await rig.app.db.query(
      `UPDATE safety_switches SET "on" = false WHERE name = 'webhook_enabled'`,
    );
    expect(await rig.app.engine.webhook(fresh())).toEqual({ http: 503, outcome: 'disabled' });
  });

  it('every response is an empty JSON object and never says why', async () => {
    rig = await bootWebhookApp();
    for (const d of [fresh(), tampered(), malformed()]) {
      const res = await rig.post(d);
      expect(await res.text()).toBe('{}');
      expect(res.headers.get('content-type')).toContain('application/json');
    }
  });
});

describe('answerFor (the pure table)', () => {
  const table: [WebhookResponse, number, boolean][] = [
    [{ http: 200, outcome: 'enqueued' }, 200, false],
    [{ http: 200, outcome: 'no_op' }, 200, false],
    [{ http: 200, outcome: 'duplicate' }, 200, false],
    [{ http: 400, outcome: 'rejected' }, 400, false],
    [{ http: 503, outcome: 'unverifiable' }, 503, false],
    [{ http: 503, outcome: 'disabled' }, 503, true],
  ];
  it.each(table)('%j answers %i (uncharged: %s)', (r, status, uncharged) => {
    const a = answerFor(r);
    expect(a.status).toBe(status);
    if (status === 200) expect('body' in a && a.body).toEqual({});
    else {
      expect('no_rate_charge' in a && a.no_rate_charge === true).toBe(uncharged);
      // one code per class: the answer to a bad signature and to malformed is the same
      expect('code' in a && a.code).toBe(status === 400 ? 'rejected' : 'unavailable');
    }
  });
});

describe('the webhook is allowed only when it can be verified (ASM-64)', () => {
  const base = {
    switch_on: true,
    mode: 'sandbox' as const,
    webhook_id: 'SYN-WEBHOOK-ID-0001' as string | null,
    pin_set: true,
    injected_source: false,
  };
  it.each([
    ['all in place', {}, true],
    ['the switch is off', { switch_on: false }, false],
    ['no webhook id', { webhook_id: null }, false],
    ['sandbox with the certificate pin empty', { pin_set: false }, false],
    [
      'sandbox with the pin empty but a test source injected',
      { pin_set: false, injected_source: true },
      true,
    ],
    ['offline with a webhook id', { mode: 'offline' as const, pin_set: false }, true],
    ['offline without a webhook id', { mode: 'offline' as const, webhook_id: null }, false],
  ])('%s', (_n, over, expected) => {
    expect(webhookAllowed({ ...base, ...over })).toBe(expected);
  });
});

describe('invalid deliveries are limited, valid ones never (COST-3)', () => {
  it('61 invalid deliveries from one address in a minute: the 61st is 429', async () => {
    rig = await bootWebhookApp();
    for (let i = 1; i <= 60; i++)
      expect((await rig.post(tampered(), { ip: '203.0.113.77' })).status).toBe(400);
    const limited = await rig.post(tampered(), { ip: '203.0.113.77' });
    expect(limited.status).toBe(429);
    expect(await limited.text()).toBe('{}');
    // one audit row per refused delivery, none for the limited one
    expect(
      await rig.count('SELECT count(*) AS c FROM audit_log WHERE action = $1', [
        'webhook.rejected',
      ]),
    ).toBe(60);
    // another address is served; so is a valid delivery from a fresh address
    expect((await rig.post(tampered(), { ip: '203.0.113.78' })).status).toBe(400);
    expect((await rig.post(fresh(), { ip: '203.0.113.79' })).status).toBe(200);
    // a minute later the first address has its tokens back
    vi.setSystemTime(NOW_MS + 61_000);
    expect((await rig.post(fresh(), { ip: '203.0.113.77' })).status).toBe(200);
  });

  it('61 deliveries that cannot be verified (503) from one address: the 61st is 429', async () => {
    rig = await bootWebhookApp({
      certs: certsFor(undefined, () => ({ kind: 'unavailable', why: 'fetch' })),
    });
    for (let i = 1; i <= 60; i++)
      expect((await rig.post(fresh(), { ip: '203.0.113.80' })).status).toBe(503);
    expect((await rig.post(fresh(), { ip: '203.0.113.80' })).status).toBe(429);
    expect(
      await rig.count('SELECT count(*) AS c FROM audit_log WHERE action = $1', [
        'webhook.unverifiable',
      ]),
    ).toBe(60);
  });

  it('600 valid deliveries in a minute from one address: none limited', async () => {
    rig = await bootWebhookApp();
    for (let i = 0; i < 600; i++) {
      const res = await rig.post(fresh(), { ip: '203.0.113.90' });
      expect(res.status).toBe(200);
    }
    expect(await rig.count('SELECT count(*) AS c FROM webhook_events')).toBe(600);
    expect(
      await rig.count('SELECT count(*) AS c FROM rate_buckets WHERE bucket_key LIKE $1', [
        'webhook-invalid%',
      ]),
    ).toBe(0);
    // and the same delivery 600 times is 600 answers of 200
    const same = fresh();
    for (let i = 0; i < 600; i++)
      expect((await rig.post(same, { ip: '203.0.113.91' })).status).toBe(200);
  }, 120_000);

  it('the limiter rule is the COST-3 one: 60 a minute per address', () => {
    expect(DEFAULT_RATES.webhook_invalid).toEqual({
      name: 'webhook-invalid',
      per: 'ip',
      limit: 60,
      window_ms: 60_000,
    });
  });

  it('a webhook switched off is answered 503 without charging the limiter and without a certificate fetch', async () => {
    rig = await bootWebhookApp();
    await rig.app.db.query(
      `UPDATE safety_switches SET "on" = false WHERE name = 'webhook_enabled'`,
    );
    for (let i = 0; i < 100; i++)
      expect((await rig.post(fresh(), { ip: '203.0.113.95' })).status).toBe(503);
    expect(rig.certs?.calls).toEqual([]);
  });
});
