// INT-OPS-C mutation follow-up (N-C1): createMandate edges the store mutation run showed untested. The currency is
// three capital letters, and the longest cap is MAX_MANDATE_DAYS from now, to the millisecond.
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { IsoUtc } from '@umsbx/contracts';
import { MAX_MANDATE_DAYS, createMandate } from './index';
import { CAPS, makeHarness } from './test-fixtures';
import type { Harness } from './test-fixtures';

let h: Harness;
beforeEach(async () => {
  if (h) await h.db.close();
  h = await makeHarness();
});
afterAll(async () => {
  if (h) await h.db.close();
});

const at = (ms: number): IsoUtc => new Date(h.clock.now().getTime() + ms).toISOString() as IsoUtc;
const make = (over: Partial<typeof CAPS>) =>
  createMandate(h.db, h.deps, {
    buyer_id: 'buy_A',
    agent_key_id: 'key_A1',
    ...CAPS,
    max_count: 3,
    ...over,
  });

describe('createMandate edges', () => {
  it('the longest cap is 90 days', () => {
    expect(MAX_MANDATE_DAYS).toBe(90);
  });

  it.each(['usd', 'US', 'USDX', 'U5D', ''])(
    'currency %j is refused as invalid_currency',
    async (currency) => {
      expect(await make({ currency })).toEqual({ ok: false, error: 'invalid_currency' });
    },
  );

  it('a cap ending one millisecond past the longest is refused; one ending at it is made', async () => {
    const day = 86_400_000;
    expect(await make({ expires_at: at(MAX_MANDATE_DAYS * day + 1) })).toEqual({
      ok: false,
      error: 'invalid_expiry',
    });
    expect((await make({ expires_at: at(MAX_MANDATE_DAYS * day) })).ok).toBe(true);
  });
});
