// OPS-WRAP-1: the order page Summary names each capture "Capture 1", "Capture 2" (a short label) and puts the
// unit id and amount beside the capture id, in the wide value column, so no label spills over a value.
import { describe, expect, it } from 'vitest';
import { orderPageView } from './ops-order-view';
import type { OrderPageInput } from './ops-order-view';

const input = (mfa: boolean): OrderPageInput => ({
  order: {
    order_ref: 'ord_4vhv14pz7gwewb1hshsddd3et3',
    status: 'paid',
    total_minor: 350,
    currency: 'USD',
    environment: 'sandbox',
    created_at: '2026-11-02T21:40:00.000Z',
    buyer_name: 'Ruth',
  },
  units: [
    {
      id: 'unt_12p5zhevtqr2s10eed9snz276y',
      amount_minor: 250,
      status: 'captured',
      capture_id: '5TST000000000003C',
    },
    {
      id: 'unt_1br5esvh2d8yyzznxs7a5rn4ga',
      amount_minor: 100,
      status: 'captured',
      capture_id: '5TST000000000004D',
    },
    { id: 'unt_nocapture00000000000000000', amount_minor: 0, status: 'pending', capture_id: null },
  ],
  provider_orders: [
    { provider_order_id: '5TST000000000001A' },
    { provider_order_id: '5TST000000000002B' },
  ],
  entries: [],
  truncated: false,
  words: {},
  alerts: [],
  mfa,
});

describe('OPS-WRAP-1: capture rows on the order page Summary', () => {
  it('labels are short; the unit and amount sit beside the capture id', () => {
    const v = orderPageView(input(true));
    expect(v.provider_ids).toEqual([
      { label: 'PayPal order 1', value: '5TST000000000001A', note: null },
      { label: 'PayPal order 2', value: '5TST000000000002B', note: null },
      {
        label: 'Capture 1',
        value: '5TST000000000003C',
        note: 'unit unt_12p5zhevtqr2s10eed9snz276y, $2.50',
      },
      {
        label: 'Capture 2',
        value: '5TST000000000004D',
        note: 'unit unt_1br5esvh2d8yyzznxs7a5rn4ga, $1.00',
      },
    ]);
    for (const p of v.provider_ids) expect(p.label.length).toBeLessThanOrEqual(16);
  });
  it('without the second factor the capture id stays masked; the unit id is not identity and stays', () => {
    const v = orderPageView(input(false));
    expect(v.provider_ids[2]).toEqual({
      label: 'Capture 1',
      value: '…332E',
      note: 'unit unt_12p5zhevtqr2s10eed9snz276y, $2.50',
    });
  });
});
