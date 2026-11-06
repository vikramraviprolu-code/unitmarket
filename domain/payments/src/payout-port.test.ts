// POB-M1: the only PayoutPort of this lane is the dry run. Deterministic ids, no network, idempotent by key.
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PayoutSendRequest } from '@umsbx/contracts';
import { createDryRunPayoutPort, payoutKey } from './index';

const req = (over: Partial<PayoutSendRequest> = {}): PayoutSendRequest => ({
  payout_id: 'pay_abc',
  idempotency_key: 'umsP-pay_abc',
  publisher_id: 'pub_1',
  payee_merchant_id: 'MERCH1',
  amount: { currency: 'USD', minor: 360 },
  environment: 'dryrun',
  ...over,
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe('payoutKey', () => {
  it('is umsP- and the payout id', () => {
    expect(payoutKey('pay_abc')).toBe('umsP-pay_abc');
  });
  it('stays inside the 108 characters of a request id', () => {
    expect(() => payoutKey('x'.repeat(200))).toThrow(RangeError);
    expect(() => payoutKey('')).toThrow(RangeError);
  });
});

describe('createDryRunPayoutPort', () => {
  it('answers with an id made from the key, the same every time', async () => {
    const port = createDryRunPayoutPort();
    const a = await port.send(req());
    const b = await port.send(req());
    expect(a).toEqual({
      kind: 'accepted',
      provider_ref: 'DRYRUN-umsP-pay_abc',
      status: 'confirmed',
    });
    expect(b).toEqual(a);
    const other = createDryRunPayoutPort();
    expect(await other.send(req())).toEqual(a);
  });
  it('a repeat of a key is not a second send', async () => {
    const port = createDryRunPayoutPort();
    await port.send(req());
    await port.send(req());
    await port.send(req({ payout_id: 'pay_def', idempotency_key: 'umsP-pay_def' }));
    expect(port.sent.map((s) => s.idempotency_key)).toEqual(['umsP-pay_abc', 'umsP-pay_def']);
  });
  it('opens no socket: fetch is never touched', async () => {
    const fetchSpy = vi.fn(() => Promise.reject(new Error('network')));
    vi.stubGlobal('fetch', fetchSpy);
    await createDryRunPayoutPort().send(req());
    expect(fetchSpy).not.toHaveBeenCalled();
  });
  it('refuses a request that is not a dry run, so a sandbox payout is never pretended', async () => {
    const r = await createDryRunPayoutPort().send(req({ environment: 'sandbox' }));
    expect(r).toEqual({ kind: 'rejected', reason: 'dry_run_only' });
  });
  it('refuses an amount that is not a whole positive number, a bad currency and a key that is not the payout key', async () => {
    const port = createDryRunPayoutPort();
    for (const bad of [
      req({ amount: { currency: 'USD', minor: 0 } }),
      req({ amount: { currency: 'USD', minor: -5 } }),
      req({ amount: { currency: 'USD', minor: 1.5 } }),
      req({ amount: { currency: 'usd', minor: 5 } }),
      req({ idempotency_key: 'umsP-other' }),
      req({ payee_merchant_id: '' }),
    ]) {
      expect(await port.send(bad)).toEqual({ kind: 'rejected', reason: 'invalid_request' });
    }
    expect(port.sent).toEqual([]);
  });
});
