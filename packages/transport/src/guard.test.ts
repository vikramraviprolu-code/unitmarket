import { describe, expect, it } from 'vitest';
import { guard } from './guard';
import { PATHS, SANDBOX_API } from './endpoints';
import { CERT_HOST, LIVE_HOST, SANDBOX_HOST, req } from './test-support';

const full = (p: string) => `https://${SANDBOX_HOST}${p}`;
const refused = (r: ReturnType<typeof req>, kind: 'dryrun' | 'sandbox' = 'dryrun') =>
  expect(guard(r, kind)).toEqual({ ok: false, by: 'egress' });

describe('endpoints', () => {
  it('the base URL is the sandbox host', () => {
    expect(SANDBOX_API).toBe(`https://${SANDBOX_HOST}`);
  });
  it('lists every operation with its method and template', () => {
    expect(PATHS.oauth_token).toMatchObject({ method: 'POST', template: '/v1/oauth2/token' });
    expect(PATHS.create_order).toMatchObject({ method: 'POST', template: '/v2/checkout/orders' });
    expect(PATHS.get_order).toMatchObject({ method: 'GET', template: '/v2/checkout/orders/{id}' });
    expect(PATHS.capture_order).toMatchObject({
      method: 'POST',
      template: '/v2/checkout/orders/{id}/capture',
    });
    expect(PATHS.get_capture).toMatchObject({
      method: 'GET',
      template: '/v2/payments/captures/{id}',
    });
    expect(PATHS.refund_capture).toMatchObject({
      method: 'POST',
      template: '/v2/payments/captures/{id}/refund',
    });
    expect(PATHS.get_refund).toMatchObject({
      method: 'GET',
      template: '/v2/payments/refunds/{id}',
    });
    expect(PATHS.verify_webhook_postback).toMatchObject({
      method: 'POST',
      template: '/v1/notifications/verify-webhook-signature',
    });
    expect(PATHS.fetch_webhook_cert.method).toBe('GET');
    expect(Object.keys(PATHS)).toHaveLength(9);
  });
});

describe('guard', () => {
  it('allows every listed operation on a relative path and returns the sandbox URL', () => {
    const cases: [Parameters<typeof req>[0], string][] = [
      ['oauth_token', '/v1/oauth2/token'],
      ['create_order', '/v2/checkout/orders'],
      ['get_order', '/v2/checkout/orders/5O190127TN364715T'],
      ['capture_order', '/v2/checkout/orders/5O190127TN364715T/capture'],
      ['get_capture', '/v2/payments/captures/3C679366HH908993F'],
      ['refund_capture', '/v2/payments/captures/3C679366HH908993F/refund'],
      ['get_refund', '/v2/payments/refunds/1JU08902781691411'],
      ['verify_webhook_postback', '/v1/notifications/verify-webhook-signature'],
    ];
    for (const [op, p] of cases) {
      const r = req(op, p, op === 'verify_webhook_postback' ? { method: 'POST' } : {});
      for (const kind of ['dryrun', 'sandbox'] as const) {
        const g = guard(r, kind);
        expect(g.ok).toBe(true);
        if (g.ok) expect(g.url.href).toBe(full(p));
      }
    }
  });

  it('allows an absolute URL on the sandbox host', () => {
    expect(guard(req('get_order', full('/v2/checkout/orders/ABC123')), 'dryrun').ok).toBe(true);
  });

  it('guard refuses live host, http, port 8443, redirect target, unknown path, lowercase order id, query string, wrong method', () => {
    // live host
    refused(req('get_order', `https://${LIVE_HOST}/v2/checkout/orders/ABC123`));
    // plain http
    refused(req('get_order', `http://${SANDBOX_HOST}/v2/checkout/orders/ABC123`));
    // port 8443
    refused(req('get_order', `https://${SANDBOX_HOST}:8443/v2/checkout/orders/ABC123`));
    // redirect target: another host, or userinfo trick that makes the sandbox name a user
    refused(req('get_order', 'https://evil.example/v2/checkout/orders/ABC123'));
    refused(req('get_order', `https://${SANDBOX_HOST}@evil.example/v2/checkout/orders/ABC123`));
    refused(req('get_order', `//evil.example/v2/checkout/orders/ABC123`));
    refused(req('get_order', `@evil.example/v2/checkout/orders/ABC123`));
    // unknown path (a payouts path), traversal, trailing slash, encoded id
    refused(req('create_order', '/v1/payments/payouts'));
    refused(req('get_order', '/v2/checkout/orders/ABC123/../../payouts'));
    refused(req('get_order', '/v2/checkout/orders/ABC123/'));
    refused(req('get_order', '/v2/checkout/orders/ABC%31'));
    refused(req('capture_order', '/v2/checkout/orders/ABC123/authorize'));
    // lowercase order id, empty id, 37-char id
    refused(req('get_order', '/v2/checkout/orders/abc123'));
    refused(req('get_order', '/v2/checkout/orders/'));
    refused(req('get_order', `/v2/checkout/orders/${'A'.repeat(37)}`));
    expect(guard(req('get_order', `/v2/checkout/orders/${'A'.repeat(36)}`), 'dryrun').ok).toBe(
      true,
    );
    // capture and refund ids follow the same rule
    refused(req('get_capture', '/v2/payments/captures/lower1'));
    refused(req('refund_capture', '/v2/payments/captures/lower1/refund'));
    refused(req('get_refund', '/v2/payments/refunds/lower1'));
    // query string and fragment
    refused(req('get_order', '/v2/checkout/orders/ABC123?fields=all'));
    refused(req('get_order', '/v2/checkout/orders/ABC123#x'));
    refused(req('oauth_token', '/v1/oauth2/token?grant_type=client_credentials'));
    // wrong method for the operation, and operation/path mismatch
    refused(req('get_order', '/v2/checkout/orders/ABC123', { method: 'POST' }));
    refused(req('create_order', '/v2/checkout/orders', { method: 'GET' }));
    refused(req('get_order', '/v2/checkout/orders'));
    refused(req('create_order', '/v2/checkout/orders/ABC123'));
  });

  it('refuses the same things in sandbox mode', () => {
    refused(req('get_order', `https://${LIVE_HOST}/v2/checkout/orders/ABC123`), 'sandbox');
    refused(req('get_order', '/v2/checkout/orders/abc123'), 'sandbox');
  });

  it('refuses a host that merely contains the sandbox name', () => {
    refused(req('get_order', `https://${SANDBOX_HOST}.evil.example/v2/checkout/orders/ABC123`));
    refused(req('get_order', `https://x${SANDBOX_HOST}/v2/checkout/orders/ABC123`));
    refused(req('get_order', `https://${SANDBOX_HOST}./v2/checkout/orders/ABC123`));
  });

  it('cert host rule allows a sandbox cert path and refuses others', () => {
    const cert = (u: string) => req('fetch_webhook_cert', u, { method: 'GET', body: null });
    const ok = `https://${CERT_HOST}/v1/notifications/certs/CERT-360caa42-fca2a594-1d93a270`;
    const g = guard(cert(ok), 'dryrun');
    expect(g.ok).toBe(true);
    if (g.ok) expect(g.url.hostname).toBe(CERT_HOST);
    expect(guard(cert(ok), 'sandbox').ok).toBe(true);
    // the exact API host also ends with the sandbox suffix, so it is allowed for certs only
    expect(guard(cert(`https://${SANDBOX_HOST}/v1/notifications/certs/CERT-1`), 'dryrun').ok).toBe(
      true,
    );
    // refused: live host, other host, suffix trick, http, port, wrong path prefix, query, userinfo
    refused(cert(`https://${LIVE_HOST}/v1/notifications/certs/CERT-1`));
    refused(cert(`https://www.${['paypal', 'com'].join('.')}/v1/notifications/certs/CERT-1`));
    refused(cert('https://evil.example/v1/notifications/certs/CERT-1'));
    refused(cert(`https://${CERT_HOST}.evil.example/v1/notifications/certs/CERT-1`));
    refused(cert(`https://evil.example/${CERT_HOST}/v1/notifications/certs/CERT-1`));
    refused(
      cert(`https://evilsandbox.${['paypal', 'com'].join('.')}/v1/notifications/certs/CERT-1`),
    );
    refused(cert(`http://${CERT_HOST}/v1/notifications/certs/CERT-1`));
    refused(cert(`https://${CERT_HOST}:8443/v1/notifications/certs/CERT-1`));
    refused(cert(`https://${CERT_HOST}/v1/other/certs/CERT-1`));
    refused(cert(`https://${CERT_HOST}/v1/notifications/certs/`));
    refused(cert(`https://${CERT_HOST}/v1/notifications/certs/CERT-1?x=1`));
    refused(cert(`https://${CERT_HOST}/v1/notifications/certs/../../secret`));
    refused(cert(`https://u:p@${CERT_HOST}/v1/notifications/certs/CERT-1`));
    refused(cert('/v1/notifications/certs/CERT-1'));
    refused(req('fetch_webhook_cert', ok, { method: 'POST' }));
  });

  it('the cert host rule does not widen any other operation', () => {
    refused(req('get_order', `https://${CERT_HOST}/v2/checkout/orders/ABC123`));
    refused(req('get_order', `https://${CERT_HOST}/v1/notifications/certs/CERT-1`));
  });

  // Review A (L1)
  it('L1: inherited property names as an operation are refused, not thrown on', () => {
    for (const op of ['__proto__', 'constructor', 'toString', 'hasOwnProperty', 'valueOf']) {
      // method left undefined too: undefined === PATHS[op].method for an inherited name
      const r = {
        ...req('get_order', '/v2/checkout/orders/ABC123'),
        operation: op,
        method: undefined,
      };
      expect(() => guard(r as never, 'dryrun'), op).not.toThrow();
      refused(r as never);
      refused(r as never, 'sandbox');
    }
  });
  it('L1: a certificate file name made only of dots is refused', () => {
    const cert = (u: string) => req('fetch_webhook_cert', u, { method: 'GET', body: null });
    for (const name of ['...', '..', '.', '....', '.hidden', '-x', '_x']) {
      refused(cert(`https://${CERT_HOST}/v1/notifications/certs/${name}`));
    }
    expect(guard(cert(`https://${CERT_HOST}/v1/notifications/certs/CERT-1.pem`), 'dryrun').ok).toBe(
      true,
    );
  });
});
