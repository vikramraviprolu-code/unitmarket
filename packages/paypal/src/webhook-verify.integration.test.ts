// The adapter end to end for webhooks: createPayPalAdapter -> verifyWebhook -> real certificate
// source -> Transport (a fake that records what is sent) -> hand-built certificate -> signature.
import { describe, expect, it } from 'vitest';
import type { LogEvent, Secret } from '@umsbx/contracts';
import { createPayPalAdapter } from './adapter';
import { createCertificateSource } from './webhook-cert';
import type { AdapterDeps } from './adapter';
import { memoryLogger, mutableClock } from './test-support';
import {
  HOUR,
  NOW_ISO,
  WEBHOOK_ID,
  certUrl,
  certificatePem,
  deliver,
  fakeTransport,
  forger,
  loadWebhookFixtures,
  okCertificates,
  pemResponse,
  signer,
} from './webhook-test-support';

const fixtures = loadWebhookFixtures();
const pem = () =>
  certificatePem({
    publicKey: signer.publicKey,
    notBefore: new Date('2026-01-01T00:00:00Z'),
    notAfter: new Date('2036-01-01T00:00:00Z'),
  });
const secret = (v: string): Secret => ({
  reveal: () => v,
  toString: () => '[redacted]',
  toJSON: () => '[redacted]',
});

function setup(over: Partial<AdapterDeps> = {}, answer?: Parameters<typeof fakeTransport>[0]) {
  const transport = fakeTransport(answer ?? (() => pemResponse(pem())));
  const clock = mutableClock(NOW_ISO);
  const log = memoryLogger();
  const records: unknown[] = [];
  const adapter = createPayPalAdapter({
    transport,
    clock,
    log,
    credentials: {
      client_id: secret('placeholder-id'),
      client_secret: secret('placeholder-secret'),
    },
    record: (c) => {
      records.push(c);
      return Promise.resolve();
    },
    webhook_id: WEBHOOK_ID,
    // The real certificate source with no pin: the default source now carries the learned PayPal sandbox
    // pin (D-043), which these synthetic certificates are not. The pin itself is tested in webhook-cert tests.
    certificates: createCertificateSource({ transport, clock, log, expected_pins: [] }),
    ...over,
  });
  return { adapter, transport, clock, log, records };
}

describe('adapter.verifyWebhook wired to the real certificate source', () => {
  it('every synthetic fixture verifies; the certificate is fetched once and cached', async () => {
    const { adapter, transport } = setup();
    for (const f of fixtures) {
      expect(await adapter.verifyWebhook(deliver(f))).toEqual({
        kind: 'verified',
        event: f.expect,
      });
    }
    expect(transport.calls).toHaveLength(1);
    const req = transport.calls[0];
    expect(req?.operation).toBe('fetch_webhook_cert');
    expect(req?.path).toBe(certUrl());
    expect(req?.method).toBe('GET');
  });

  it('the only outbound call is the certificate fetch: no OAuth, no postback, no credentials sent', async () => {
    const { adapter, transport } = setup();
    await adapter.verifyWebhook(deliver(fixtures[0]!));
    expect(transport.calls.map((c) => c.operation)).toEqual(['fetch_webhook_cert']);
    const sent = JSON.stringify(transport.calls);
    expect(sent).not.toContain('placeholder-secret');
    expect(sent).not.toContain('placeholder-id');
    expect(sent.toLowerCase()).not.toContain('bearer');
  });

  it('a forged delivery is bad_signature and still only one certificate fetch happened', async () => {
    const { adapter, transport } = setup();
    expect(await adapter.verifyWebhook(deliver(fixtures[0]!, { key: forger.privateKey }))).toEqual({
      kind: 'bad_signature',
      why: 'signature',
    });
    expect(transport.calls).toHaveLength(1);
  });

  it('an off-list certificate URL never reaches the transport', async () => {
    const { adapter, transport } = setup();
    const v = await adapter.verifyWebhook(
      deliver(fixtures[0]!, { cert_url: certUrl({ host: 'evil.example' }) }),
    );
    expect(v).toEqual({ kind: 'bad_signature', why: 'cert_url' });
    expect(transport.calls).toHaveLength(0);
  });

  it('webhook_id omitted or null: unverifiable, nothing sent', async () => {
    const noIdTransport = fakeTransport(() => pemResponse(pem()));
    const noId = createPayPalAdapter({
      transport: noIdTransport,
      clock: mutableClock(NOW_ISO),
      log: memoryLogger(),
      credentials: null,
      record: () => Promise.resolve(),
    });
    expect(await noId.verifyWebhook(deliver(fixtures[0]!))).toEqual({ kind: 'unverifiable' });
    expect(noIdTransport.calls).toHaveLength(0);
    const nullId = createPayPalAdapter({
      transport: fakeTransport(() => pemResponse(pem())),
      clock: mutableClock(NOW_ISO),
      log: memoryLogger(),
      credentials: null,
      record: () => Promise.resolve(),
      webhook_id: null,
    });
    expect(await nullId.verifyWebhook(deliver(fixtures[0]!))).toEqual({ kind: 'unverifiable' });
  });

  it('a transport that blocks the certificate fetch gives unverifiable (503), as with a dry-run miss', async () => {
    const { adapter } = setup({}, () => ({ kind: 'blocked', by: 'dry_run_miss' }));
    expect(await adapter.verifyWebhook(deliver(fixtures[0]!))).toEqual({ kind: 'unverifiable' });
  });

  it('an injected certificate source replaces the default one', async () => {
    const certificates = okCertificates();
    const { adapter, transport } = setup({ certificates });
    expect(await adapter.verifyWebhook(deliver(fixtures[0]!))).toMatchObject({ kind: 'verified' });
    expect(certificates.calls).toHaveLength(1);
    expect(transport.calls).toHaveLength(0);
  });

  it('the clock drives both the certificate cache and the time window', async () => {
    const { adapter, transport, clock } = setup();
    await adapter.verifyWebhook(deliver(fixtures[0]!));
    clock.advance(25 * HOUR);
    // 25 h later the delivery is still inside the 3-day window, the cached certificate has expired
    expect(await adapter.verifyWebhook(deliver(fixtures[0]!))).toMatchObject({ kind: 'verified' });
    expect(transport.calls).toHaveLength(2);
    clock.advance(72 * HOUR);
    expect(await adapter.verifyWebhook(deliver(fixtures[0]!))).toEqual({
      kind: 'bad_signature',
      why: 'stale',
    });
  });

  it('nothing is logged about the body or the signature', async () => {
    const { adapter, log } = setup();
    const d = deliver(fixtures[0]!);
    await adapter.verifyWebhook(d);
    await adapter.verifyWebhook(deliver(fixtures[0]!, { key: forger.privateKey }));
    const text = JSON.stringify(log.events satisfies LogEvent[]);
    expect(text).not.toContain(d.headers['paypal-transmission-sig'] as string);
    expect(text).not.toContain('SBXCAP');
    expect(text).not.toContain('BEGIN CERTIFICATE');
  });
});
