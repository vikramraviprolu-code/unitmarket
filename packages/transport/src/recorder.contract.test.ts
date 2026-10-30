import { describe, expect, it } from 'vitest';
import { buildRecordings } from './recorder';
import { exchange } from './recorder-corpus';

// B-13: a recording built from a representative capture_before_approval error response passes the
// same live-host expectation as fixtures.contract.test.ts (same pattern, built from parts, A-26).
const LIVE = new RegExp(
  `(api-m|api|api-3t|www|svcs|ipnpb|developer)\\.${['paypal', 'com'].join('\\.')}`,
  'i',
);
const DOCS = ['developer', 'paypal', 'com'].join('.');

describe('recorder output vs the fixture live-host contract (B-13)', () => {
  it('a capture_before_approval error response holds no live or documentation host', async () => {
    const link = `https://${DOCS}/docs/api/orders/v2/#error-ORDER_NOT_APPROVED`;
    const r = await buildRecordings(
      [
        exchange({
          scenario: 'capture_before_approval',
          operation: 'capture_order',
          request: {
            method: 'POST',
            path: '/v2/checkout/orders/5O190127TN364715T/capture',
            headers: { 'Content-Type': 'application/json' },
            body: null,
          },
          response: {
            status: 422,
            headers: { 'Content-Type': 'application/json', 'PayPal-Debug-Id': 'a1b2c3d4e5f67' },
            body: {
              name: 'UNPROCESSABLE_ENTITY',
              details: [{ issue: 'ORDER_NOT_APPROVED', description: 'Payer has not approved.' }],
              message: 'The requested action could not be performed.',
              debug_id: 'a1b2c3d4e5f67',
              information_link: link,
              links: [{ href: link, rel: 'information_link' }],
            },
          },
        }),
      ],
      {
        recorded_at: '2026-10-29T09:00:00Z',
        origin: 'sandbox-recording: contract-style test, synthetic input',
      },
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    for (const f of r.files) {
      expect(f.text, f.name).not.toMatch(LIVE);
      const hosts = [...f.text.matchAll(/https?:\/\/([^/"\s?#:]+)/g)].map((m) => m[1] ?? '');
      for (const h of hosts)
        expect(h.endsWith('.sandbox.paypal.com'), `${f.name}: ${h}`).toBe(true);
    }
  });
});
