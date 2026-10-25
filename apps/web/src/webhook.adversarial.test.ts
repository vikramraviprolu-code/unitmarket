// CO-3 adversarial: the public webhook route against hostile input. Raw bytes are verified before
// anything is parsed, the size cap holds while streaming, a refusal never says why, replay changes
// nothing, and no log line or audit row carries the body, the signature or the transmission id.
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../composition.server';
import { testEnv } from './support';
import {
  NOW_MS,
  bootWebhookApp,
  certUrl,
  certsFor,
  delivery,
  eventBody,
  eventBodyOfSize,
  forger,
  seedCapturingOrder,
  WEBHOOK_ID,
} from './webhook-support';
import type { Delivery, WebhookRig } from './webhook-support';

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

const events = () => rig.count('SELECT count(*) AS c FROM webhook_events');

describe('size, method, content type', () => {
  it('a body of 64 KiB plus 1 byte is 413, with or without a content-length, and nothing is stored', async () => {
    rig = await bootWebhookApp();
    const big = delivery(eventBodyOfSize({ id: 'WH-BIG' }, 65_537), { id: 'TR-BIG' });
    expect(Buffer.byteLength(big.raw_body)).toBe(65_537);
    const withLength = await rig.route.POST(
      new Request('http://localhost:3000/api/webhooks/paypal', {
        method: 'POST',
        body: big.raw_body,
        headers: { ...big.headers, 'content-length': '65537', 'x-forwarded-for': '203.0.113.1' },
      }),
    );
    expect(withLength.status).toBe(413);
    const lying = await rig.route.POST(
      new Request('http://localhost:3000/api/webhooks/paypal', {
        method: 'POST',
        body: big.raw_body,
        headers: { ...big.headers, 'content-length': '10', 'x-forwarded-for': '203.0.113.2' },
      }),
    );
    expect(lying.status).toBe(413);
    expect(await events()).toBe(0);
    expect(rig.certs?.calls).toEqual([]);
  });

  it('a signed body of exactly 64 KiB is accepted', async () => {
    rig = await bootWebhookApp();
    const edge = delivery(eventBodyOfSize({ id: 'WH-EDGE' }, 65_536), { id: 'TR-EDGE' });
    expect(Buffer.byteLength(edge.raw_body)).toBe(65_536);
    expect((await rig.post(edge)).status).toBe(200);
    expect(await events()).toBe(1);
  });

  it('GET (and any other method) is 405 and touches nothing', async () => {
    rig = await bootWebhookApp();
    const d = delivery(eventBody({ id: 'WH-GET' }), { id: 'TR-GET' });
    for (const method of ['GET', 'PUT', 'DELETE', 'PATCH']) {
      const res = await rig.post(d, { method });
      expect(res.status).toBe(405);
      expect(res.headers.get('allow')).toBe('POST');
      expect(await res.text()).toBe('{}');
    }
    expect(await events()).toBe(0);
    expect(rig.certs?.calls).toEqual([]);
  });

  it('a non-JSON content type with a valid signature still verifies: the signature decides', async () => {
    rig = await bootWebhookApp();
    const d = delivery(eventBody({ id: 'WH-CT' }), { id: 'TR-CT' });
    for (const [i, content_type] of [
      'text/plain',
      'application/x-www-form-urlencoded',
      'image/png',
      '',
    ].entries()) {
      const res = await rig.post(
        i === 0 ? d : delivery(eventBody({ id: `WH-CT-${i}` }), { id: `TR-CT-${i}` }),
        {
          content_type,
        },
      );
      expect(res.status).toBe(200);
    }
    expect(await events()).toBe(4);
  });

  it('a body that is not JSON, signed correctly, is 400 (malformed), never 200', async () => {
    rig = await bootWebhookApp();
    for (const [i, text] of ['this is not json', '{"id":', '[]', '{"id":"x"}', ''].entries()) {
      const res = await rig.post(delivery(text, { id: `TR-NJ-${i}` }), {
        content_type: 'text/plain',
      });
      expect(res.status).toBe(400);
    }
    expect(await events()).toBe(0);
  });
});

describe('raw bytes are what is verified', () => {
  it('a re-serialised body, one changed byte, a BOM added, CRLF swapped: all 400, nothing stored', async () => {
    rig = await bootWebhookApp();
    const raw = eventBody({ id: 'WH-RAW', summary: 'Synthetic é' });
    const good = delivery(raw, { id: 'TR-RAW' });
    const variants = [
      JSON.stringify(JSON.parse(raw)),
      raw.replace('Synthetic', 'Synthetid'),
      '﻿' + raw,
      raw.replace(/\n/g, '\r\n'),
      raw + '\n',
    ];
    for (const v of variants) expect((await rig.post({ ...good, raw_body: v })).status).toBe(400);
    expect(await events()).toBe(0);
    expect((await rig.post(good)).status).toBe(200);
  });

  it('a body with multi-byte text signed over its UTF-8 bytes verifies', async () => {
    rig = await bootWebhookApp();
    const d = delivery(eventBody({ id: 'WH-UTF', summary: '中文 é 😀' }), {
      id: 'TR-UTF',
    });
    expect((await rig.post(d)).status).toBe(200);
  });

  it('bytes that are not valid UTF-8 are 400: never repaired into something that could verify', async () => {
    rig = await bootWebhookApp();
    const d = delivery(eventBody({ id: 'WH-BAD8' }), { id: 'TR-BAD8' });
    const bytes = Buffer.concat([Buffer.from(d.raw_body.slice(0, -1)), Buffer.from([0xff, 0x7d])]);
    const res = await rig.post(d, { body: new Uint8Array(bytes) });
    expect(res.status).toBe(400);
    expect(await events()).toBe(0);
  });

  it('the verification happens before the body is parsed: a hostile JSON body with a bad signature is never parsed', async () => {
    rig = await bootWebhookApp();
    const deep = '['.repeat(20_000) + ']'.repeat(20_000);
    const proto = '{"__proto__":{"polluted":true},"id":"x"}';
    for (const [i, text] of [deep, proto].entries()) {
      const d = delivery(text, { id: `TR-HOSTILE-${i}`, key: forger.privateKey });
      expect((await rig.post(d)).status).toBe(400);
    }
    expect(({} as Record<string, unknown>)['polluted']).toBeUndefined();
    expect(await events()).toBe(0);
  });
});

describe('a refusal never says why', () => {
  it('every kind of refusal gives the same status, body and headers', async () => {
    rig = await bootWebhookApp();
    const good = delivery(eventBody({ id: 'WH-WHY' }), { id: 'TR-WHY' });
    const cases: [string, Delivery][] = [
      [
        'forger key',
        delivery(eventBody({ id: 'WH-WHY' }), { id: 'TR-WHY', key: forger.privateKey }),
      ],
      ['changed byte', { ...good, raw_body: good.raw_body.replace('Synthetic', 'Synthetid') }],
      [
        'wrong webhook id',
        delivery(eventBody({ id: 'WH-WHY' }), { id: 'TR-WHY', webhook_id: 'OTHER-' + WEBHOOK_ID }),
      ],
      [
        'sha1 algorithm',
        delivery(eventBody({ id: 'WH-WHY' }), { id: 'TR-WHY', algo: 'SHA1withRSA' }),
      ],
      [
        'cert url off the allow-list',
        delivery(eventBody({ id: 'WH-WHY' }), {
          id: 'TR-WHY',
          cert_url: 'https://example.invalid/v1/notifications/certs/X',
        }),
      ],
      [
        'stale',
        delivery(eventBody({ id: 'WH-WHY' }), { id: 'TR-WHY', time: '2026-10-01T00:00:00Z' }),
      ],
      ['missing headers', { headers: {}, raw_body: good.raw_body }],
    ];
    const seen = new Set<string>();
    for (const [i, [name, d]] of cases.entries()) {
      const res = await rig.post(d, { ip: `203.0.113.${100 + i}` });
      expect([name, res.status]).toEqual([name, 400]);
      const text = await res.text();
      expect(text).toBe('{}');
      const keep = [...res.headers.entries()]
        .filter(([k]) => !['x-request-id', 'content-security-policy'].includes(k))
        .map(([k, v]) => `${k}: ${v}`)
        .sort()
        .join('\n');
      seen.add(keep);
    }
    expect(seen.size).toBe(1);
    expect(rig.certs?.calls.length).toBeLessThanOrEqual(cases.length); // an off-list url makes no fetch
    expect(rig.certs?.calls).not.toContain('https://example.invalid/v1/notifications/certs/X');
  });

  it('the off-list certificate URL is refused with no fetch at all', async () => {
    rig = await bootWebhookApp();
    const d = delivery(eventBody({ id: 'WH-URL' }), {
      id: 'TR-URL',
      cert_url:
        'http://' + ['api', 'sandbox', 'paypal', 'com'].join('.') + '/v1/notifications/certs/X',
    });
    expect((await rig.post(d)).status).toBe(400);
    expect(rig.certs?.calls).toEqual([]);
  });
});

describe('replay and flooding', () => {
  it('the same delivery from many addresses stores one event and one read-back', async () => {
    rig = await bootWebhookApp();
    const { order_id } = await seedCapturingOrder(rig.app);
    const d = delivery(eventBody({ id: 'WH-REPLAY' }), { id: 'TR-REPLAY' });
    const answers = await Promise.all(
      Array.from({ length: 20 }, (_, i) => rig.post(d, { ip: `203.0.113.${120 + i}` })),
    );
    expect(answers.map((r) => r.status)).toEqual(Array(20).fill(200));
    expect(await events()).toBe(1);
    expect(
      await rig.count(
        `SELECT count(*) AS c FROM operations WHERE order_id = $1 AND kind = 'readback'`,
        [order_id],
      ),
    ).toBe(1);
  });

  it('a certificate that cannot be had is 503 (retried), never a forgery record', async () => {
    rig = await bootWebhookApp({
      certs: certsFor(undefined, () => ({ kind: 'unavailable', why: 'fetch' })),
    });
    const res = await rig.post(delivery(eventBody({ id: 'WH-503' }), { id: 'TR-503' }));
    expect(res.status).toBe(503);
    expect(
      await rig.count('SELECT count(*) AS c FROM audit_log WHERE action = $1', [
        'webhook.rejected',
      ]),
    ).toBe(0);
    expect(
      await rig.count('SELECT count(*) AS c FROM audit_log WHERE action = $1', [
        'webhook.unverifiable',
      ]),
    ).toBe(1);
    expect(rig.certs?.trusted).toEqual([]);
  });

  it('the postback API is never used: the Wire sees nothing on any path', async () => {
    rig = await bootWebhookApp();
    await seedCapturingOrder(rig.app);
    const good = delivery(eventBody({ id: 'WH-PB' }), { id: 'TR-PB' });
    await rig.post(good);
    await rig.post({ ...good, raw_body: good.raw_body + ' ' });
    await rig.post({ headers: {}, raw_body: '{}' });
    expect(rig.wire).toEqual([]);
  });
});

describe('nothing sensitive in logs or audit rows', () => {
  it('no log line or audit row carries the body, the signature or the transmission id in clear', async () => {
    const CANARY_BODY = 'canary-body-7f3a91c2';
    const CANARY_TRANS = 'CANARY-TRANS-5d2e88b1';
    const mk = (id: string, o: Parameters<typeof delivery>[1] = {}) =>
      delivery(eventBody({ id, summary: CANARY_BODY }), { id: CANARY_TRANS + '-' + id, ...o });
    const sent: Delivery[] = [];
    let haystack = '';
    const grab = async () => {
      haystack +=
        rig.lines.join('\n') +
        JSON.stringify(
          (await rig.app.db.query('SELECT action, target, reason, detail FROM audit_log')).rows,
        );
    };
    const fire = async (d: Delivery, ip: string) => {
      sent.push(d);
      await rig.post(d, { ip });
    };

    rig = await bootWebhookApp();
    await seedCapturingOrder(rig.app);
    await fire(mk('A1'), '203.0.113.150'); // verified
    await fire(mk('A1'), '203.0.113.151'); // duplicate
    await fire(mk('A2', { key: forger.privateKey }), '203.0.113.152'); // bad signature
    await fire({ ...mk('A3'), raw_body: '{"canary":"' + CANARY_BODY + '"' }, '203.0.113.153'); // changed after signing
    await fire(
      { headers: { 'paypal-transmission-id': CANARY_TRANS + '-A4' }, raw_body: CANARY_BODY },
      '203.0.113.154',
    ); // malformed
    await fire(mk('A5', { cert_url: 'https://example.invalid/' + CANARY_BODY }), '203.0.113.155');
    await rig.app.db.query(
      `UPDATE safety_switches SET "on" = false WHERE name = 'webhook_enabled'`,
    );
    await fire(mk('A7'), '203.0.113.157'); // disabled
    await grab();
    await rig.close();

    rig = await bootWebhookApp({
      certs: certsFor(undefined, () => ({ kind: 'unavailable', why: 'fetch' })),
    });
    await fire(mk('A6'), '203.0.113.156'); // unverifiable
    await grab();

    // the certificate URL comes from a request header and names the host we would fetch from
    const secrets = new Set<string>([CANARY_BODY, CANARY_TRANS, certUrl()]);
    for (const d of sent) {
      for (const k of ['paypal-transmission-sig', 'paypal-transmission-id'])
        if ((d.headers[k] ?? '') !== '') secrets.add(d.headers[k] as string);
    }
    for (const s of secrets) expect(haystack.includes(s)).toBe(false);
    expect(haystack).toContain('webhook');
  });

  it('the route source never logs the request body', () => {
    const src = readFileSync(new URL('./server/webhook.ts', import.meta.url), 'utf8');
    expect(src).not.toMatch(/log\.log\([^)]*raw_body/s);
  });
});

describe('boot', () => {
  it('webhook_certificates outside NODE_ENV=test refuses boot', async () => {
    const env = await testEnv({ NODE_ENV: 'development' });
    expect(() => createApp(env, { webhook_certificates: certsFor() })).toThrow(/boot refused/);
    const prod = await testEnv({ NODE_ENV: 'production' });
    expect(() => createApp(prod, { webhook_certificates: certsFor() })).toThrow(/boot refused/);
  });
});
