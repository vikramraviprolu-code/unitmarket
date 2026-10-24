// CO-3: the raw-body option of withRoute (docs/specs/web-webhook-route.md). A raw route hands the
// handler the exact text of the body and a few headers, parses nothing, and keeps every other check:
// method, size, rate. The invalid-delivery limiter (COST-3) is charged by refused answers only;
// a valid delivery is never limited. Real PGlite rate buckets, fake clock.
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { DEFAULT_RATES } from './rate';
import { withRoute } from './route';
import type { HttpResult, RouteMeta } from './route';
import { ORIGIN, makeRig } from './test-support';
import type { TestRig } from './test-support';

const rawMeta: RouteMeta = {
  path: '/api/webhooks/paypal',
  method: 'POST',
  auth: 'webhook',
  csrf: false,
  rate: DEFAULT_RATES.webhook_invalid,
  raw: true,
  max_body_bytes: 65_536,
  idempotent: false,
  risk: 'high',
};
const Input = z
  .object({ raw_body: z.string(), headers: z.record(z.string(), z.string()) })
  .strict();
type Answer = HttpResult<Record<string, never>>;
const OK: Answer = { status: 200, body: {} };
const REFUSED: Answer = { status: 400, code: 'rejected', message: 'The request was refused.' };

function build(answer: () => Answer = () => OK) {
  const seen: { raw_body: string; headers: Record<string, string> }[] = [];
  const handler = withRoute(rawMeta, Input, async (ctx) => {
    seen.push(ctx.input);
    return answer();
  });
  return { seen, handler };
}
const post = (body: string | Uint8Array | null, headers: Record<string, string> = {}) =>
  new Request(`${ORIGIN}/api/webhooks/paypal`, { method: 'POST', body, headers });
const send = (
  rig: TestRig,
  h: ReturnType<typeof build>['handler'],
  req: Request,
  ip = '198.51.100.1',
) => h(rig.deps)(req, { remote_addr: ip });
const buckets = async (rig: TestRig) =>
  (await rig.db.query<{ tokens: number | string }>('SELECT tokens FROM rate_buckets')).rows.map(
    (r) => Number(r.tokens),
  );

describe('raw body (CO-3)', () => {
  it('hands the exact text and only the paypal-* headers to the handler, and parses nothing', async () => {
    const rig = await makeRig();
    const { seen, handler } = build();
    const text = ' {"a":1} this is not json, é中\n';
    const res = await send(
      rig,
      handler,
      post(text, {
        'PayPal-Transmission-Id': 't-1',
        'paypal-cert-url': 'https://example.invalid/x',
        cookie: 'session=abc',
        authorization: 'Bearer q',
        'content-type': 'text/plain',
        'x-forwarded-for': '203.0.113.5',
      }),
    );
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('{}');
    expect(seen).toEqual([
      {
        raw_body: text,
        headers: {
          'paypal-transmission-id': 't-1',
          'paypal-cert-url': 'https://example.invalid/x',
        },
      },
    ]);
  });

  it('keeps a byte order mark: the text is the bytes that were signed', async () => {
    const rig = await makeRig();
    const { seen, handler } = build();
    const bytes = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('{"a":1}')]);
    expect((await send(rig, handler, post(bytes))).status).toBe(200);
    expect(seen[0]?.raw_body).toBe('﻿{"a":1}');
    expect(Buffer.from(seen[0]?.raw_body ?? '', 'utf8').equals(bytes)).toBe(true);
  });

  it('a body that is not valid UTF-8 is refused with 400 and never repaired', async () => {
    const rig = await makeRig();
    const { seen, handler } = build();
    for (const bytes of [
      [0x7b, 0xff, 0x7d],
      [0xc0, 0x80],
      [0xed, 0xa0, 0x80],
      [0xf4, 0x90, 0x80, 0x80],
    ]) {
      const res = await send(rig, handler, post(new Uint8Array(bytes)));
      expect(res.status).toBe(400);
      expect(await res.text()).toBe('{}');
    }
    expect(seen).toEqual([]);
  });

  it('an empty body reaches the handler as an empty string', async () => {
    const rig = await makeRig();
    const { seen, handler } = build();
    expect((await send(rig, handler, post(null))).status).toBe(200);
    expect(seen[0]?.raw_body).toBe('');
  });

  it('a body of exactly the cap is read; one byte more is 413 while streaming, handler not run', async () => {
    const rig = await makeRig();
    const { seen, handler } = build();
    expect((await send(rig, handler, post('x'.repeat(65_536)))).status).toBe(200);
    expect(seen).toHaveLength(1);
    // no content-length header at all: only the stream counts
    let chunks = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(c) {
        chunks += 1;
        c.enqueue(new Uint8Array(16_384));
        if (chunks > 100) c.close();
      },
    });
    const res = await send(
      rig,
      handler,
      new Request(`${ORIGIN}/api/webhooks/paypal`, {
        method: 'POST',
        body: stream,
        duplex: 'half',
      } as RequestInit),
    );
    expect(res.status).toBe(413);
    expect(await res.text()).toBe('{}');
    expect(seen).toHaveLength(1);
    // it stopped reading at the cap: 4 chunks reach 65536, the 5th crosses it
    expect(chunks).toBeLessThanOrEqual(6);
  });

  it('a declared length over the cap is 413 before one byte of the body is read', async () => {
    const rig = await makeRig();
    const { seen, handler } = build();
    let pulled = false;
    const stream = new ReadableStream<Uint8Array>(
      {
        pull(c) {
          pulled = true;
          c.enqueue(new Uint8Array(10));
          c.close();
        },
      },
      { highWaterMark: 0 },
    );
    const res = await send(
      rig,
      handler,
      new Request(`${ORIGIN}/api/webhooks/paypal`, {
        method: 'POST',
        body: stream,
        headers: { 'content-length': '65537' },
        duplex: 'half',
      } as RequestInit),
    );
    expect(res.status).toBe(413);
    expect(pulled).toBe(false);
    expect(seen).toEqual([]);
  });

  it('GET and PUT answer 405 with Allow: POST and an empty body; nothing is read or charged', async () => {
    const rig = await makeRig();
    const { seen, handler } = build();
    for (let i = 0; i < 100; i++) {
      for (const method of ['GET', 'PUT', 'DELETE', 'PATCH']) {
        const res = await send(
          rig,
          handler,
          new Request(`${ORIGIN}/api/webhooks/paypal`, { method }),
        );
        expect(res.status).toBe(405);
        expect(res.headers.get('allow')).toBe('POST');
        expect(await res.text()).toBe('{}');
      }
    }
    expect(seen).toEqual([]);
    expect(await buckets(rig)).toEqual([]);
  });

  it('every refusal carries an empty JSON body: no code, no message, no field name', async () => {
    const rig = await makeRig();
    const answers: Answer[] = [
      REFUSED,
      { status: 503, code: 'unavailable', message: 'Try again later.' },
      { status: 403, code: 'forbidden', message: 'No.' },
    ];
    for (const a of answers) {
      const { handler } = build(() => a);
      const res = await send(rig, handler, post('{}'), `203.0.113.${a.status}`);
      expect(res.status).toBe(a.status);
      expect(await res.text()).toBe('{}');
      expect(res.headers.get('content-type')).toContain('application/json');
    }
  });

  it('the handler answer 200 with an empty body passes through and spends nothing', async () => {
    const rig = await makeRig();
    const { handler } = build();
    for (let i = 0; i < 600; i++) {
      const res = await send(rig, handler, post(`{"n":${i}}`));
      expect(res.status).toBe(200);
    }
    expect(await buckets(rig)).toEqual([]);
  });
});

describe('invalid-delivery limiter (COST-3: 60 a minute per address)', () => {
  it('the 61st refused delivery from one address is 429 and never reaches the handler; another address is served', async () => {
    const rig = await makeRig();
    const { seen, handler } = build(() => REFUSED);
    for (let i = 1; i <= 60; i++)
      expect((await send(rig, handler, post(`b${i}`), '203.0.113.9')).status).toBe(400);
    expect(seen).toHaveLength(60);
    const limited = await send(rig, handler, post('b61'), '203.0.113.9');
    expect(limited.status).toBe(429);
    expect(await limited.text()).toBe('{}');
    expect(Number(limited.headers.get('retry-after'))).toBeGreaterThanOrEqual(1);
    expect(seen).toHaveLength(60);
    expect((await send(rig, handler, post('other'), '203.0.113.10')).status).toBe(400);
    // one token comes back every second (60 a minute)
    rig.clock.advance(1_000);
    expect((await send(rig, handler, post('again'), '203.0.113.9')).status).toBe(400);
    expect((await send(rig, handler, post('again2'), '203.0.113.9')).status).toBe(429);
  });

  it('an exhausted address is refused before its body is read', async () => {
    const rig = await makeRig();
    const { handler } = build(() => REFUSED);
    for (let i = 0; i < 60; i++) await send(rig, handler, post('x'), '203.0.113.20');
    let pulled = false;
    const stream = new ReadableStream<Uint8Array>(
      {
        pull(c) {
          pulled = true;
          c.enqueue(new Uint8Array(10));
          c.close();
        },
      },
      { highWaterMark: 0 },
    );
    const res = await send(
      rig,
      handler,
      new Request(`${ORIGIN}/api/webhooks/paypal`, {
        method: 'POST',
        body: stream,
        duplex: 'half',
      } as RequestInit),
      '203.0.113.20',
    );
    expect(res.status).toBe(429);
    expect(pulled).toBe(false);
  });

  it('a valid delivery spends no token, a refused one spends exactly one', async () => {
    const rig = await makeRig();
    let next: Answer = OK;
    const { handler } = build(() => next);
    for (let i = 0; i < 5; i++) await send(rig, handler, post('ok'));
    expect(await buckets(rig)).toEqual([]);
    next = REFUSED;
    for (let i = 0; i < 3; i++) await send(rig, handler, post('no'));
    expect(await buckets(rig)).toEqual([57]);
    next = OK;
    await send(rig, handler, post('ok'));
    expect(await buckets(rig)).toEqual([57]);
  });

  it('a 503 from the handler is charged like a 400 (a refused delivery writes an audit row)', async () => {
    const rig = await makeRig();
    const { handler } = build(() => ({
      status: 503,
      code: 'unavailable',
      message: 'Try again later.',
    }));
    for (let i = 1; i <= 60; i++)
      expect((await send(rig, handler, post(`u${i}`), '203.0.113.30')).status).toBe(503);
    expect((await send(rig, handler, post('u61'), '203.0.113.30')).status).toBe(429);
  });

  it('a 503 marked no_rate_charge (the webhook is switched off) is not charged', async () => {
    const rig = await makeRig();
    const { handler } = build(() => ({
      status: 503,
      code: 'unavailable',
      message: 'Try again later.',
      no_rate_charge: true,
    }));
    for (let i = 0; i < 150; i++)
      expect((await send(rig, handler, post(`d${i}`), '203.0.113.31')).status).toBe(503);
    expect(await buckets(rig)).toEqual([]);
  });

  it('refusals before the handler are charged too: bad encoding, a declared length over the cap, an oversized stream', async () => {
    const rig = await makeRig();
    const { seen, handler } = build();
    const badBytes = () => post(new Uint8Array([0xff, 0xfe]));
    const declared = () =>
      new Request(`${ORIGIN}/api/webhooks/paypal`, {
        method: 'POST',
        body: 'x',
        headers: { 'content-length': '70000' },
      });
    const oversized = () => post('x'.repeat(70_000));
    const makers = [badBytes, declared, oversized];
    const statuses: number[] = [];
    for (let i = 0; i < 60; i++) {
      const maker = makers[i % 3] as () => Request;
      statuses.push((await send(rig, handler, maker(), '203.0.113.40')).status);
    }
    expect(statuses.filter((s) => s === 400 || s === 413)).toHaveLength(60);
    expect(await buckets(rig)).toEqual([0]);
    expect((await send(rig, handler, post('fine'), '203.0.113.40')).status).toBe(429);
    expect(seen).toEqual([]);
  });

  it('the address comes from the trusted proxy count, not from a header the client picks', async () => {
    const rig = await makeRig({ trusted_proxies: 1 });
    const { handler } = build(() => REFUSED);
    // with one trusted proxy the right-most X-Forwarded-For entry is the client; earlier entries are forged
    for (let i = 1; i <= 60; i++) {
      const res = await handler(rig.deps)(
        post('x', { 'x-forwarded-for': `10.0.0.${i}, 203.0.113.50` }),
      );
      expect(res.status).toBe(400);
    }
    const res = await handler(rig.deps)(post('x', { 'x-forwarded-for': '10.9.9.9, 203.0.113.50' }));
    expect(res.status).toBe(429);
    const other = await handler(rig.deps)(
      post('x', { 'x-forwarded-for': '10.9.9.9, 203.0.113.51' }),
    );
    expect(other.status).toBe(400);
  });
});
