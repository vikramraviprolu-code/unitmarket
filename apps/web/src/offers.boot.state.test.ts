// PUB-B: the demo price step is a convenience and must never stop the app from starting. A step that throws
// is logged as one line with the error name only (no message, no values), and the app is ready.
import { afterAll, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));
vi.mock('@umsbx/catalogue', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@umsbx/catalogue')>()),
  applyDemoPrices: vi.fn().mockRejectedValue(new Error('boom CANARY-VALUE-123')),
}));

import { bootOffersWorld } from './offers-support';
import type { OffersWebWorld } from './offers-support';

let w: OffersWebWorld | undefined;
afterAll(async () => {
  await w?.app.close();
});

describe('a throwing demo price step', () => {
  it('does not stop createApp, logs one redacted line and leaves the seed prices', async () => {
    w = await bootOffersWorld({ demo_prices: true });
    const lines = w.logs.filter((l) => l.includes('demo_prices.failed'));
    expect(lines).toHaveLength(1);
    expect(w.logs.join('\n')).not.toContain('CANARY-VALUE-123');
    const v = (await w.app.engine.offers.list(w.actor['harbour-ledger']))!;
    expect(
      v.offers.find((o) => o.offer_id === 'ofr_harbour-ledger_tide-tables')!.options[0]!
        .price_minor,
    ).toBe(40);
  });
});
