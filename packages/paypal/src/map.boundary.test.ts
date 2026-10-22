// F-6 (gate MVP-A): status-code boundaries and null guards of the four response mappers, called
// directly. Synthetic bodies only, no network.
import { describe, expect, it } from 'vitest';
import { mapCreate } from './map-create';
import { mapCapture } from './map-capture';
import { mapRefund } from './map-refund';
import { latestCapture, mapCaptureRead, mapOrder, purchaseUnits, readCapture } from './map-order';
import type { Http } from './shapes';

const APPROVE = `https://${['www', 'sandbox', 'paypal', 'com'].join('.')}/checkoutnow?token=SBXORD00001`;
const NOW = new Date('2026-02-03T04:05:06Z');
const http = (
  status: number,
  body: unknown = null,
  headers: Record<string, string> = {},
): Http => ({
  status,
  headers,
  body,
});
const UNAVAILABLE = { kind: 'unavailable', retry_after_ms: null };

const createBody = (over: Record<string, unknown> = {}) => ({
  id: 'SBXORD00001',
  status: 'PAYER_ACTION_REQUIRED',
  links: [{ rel: 'payer-action', href: APPROVE }],
  ...over,
});
const cap = (over: Record<string, unknown> = {}) => ({
  id: 'SBXCAP00001',
  status: 'COMPLETED',
  amount: { currency_code: 'USD', value: '5.00' },
  create_time: '2026-01-01T00:00:00Z',
  ...over,
});
const unit = (over: Record<string, unknown> = {}) => ({
  reference_id: 'unit-1',
  amount: { currency_code: 'USD', value: '5.00' },
  payee: { merchant_id: 'SBXMERCHANT01' },
  payments: { captures: [cap()] },
  ...over,
});
const orderBody = (over: Record<string, unknown> = {}) => ({
  id: 'SBXORD00001',
  status: 'COMPLETED',
  purchase_units: [unit()],
  ...over,
});
const refundBody = (over: Record<string, unknown> = {}) => ({
  id: 'SBXREF00001',
  status: 'COMPLETED',
  amount: { currency_code: 'USD', value: '5.00' },
  links: [{ rel: 'up', href: 'https://x.invalid/v2/payments/captures/SBXCAP00001' }],
  ...over,
});

describe('mapCreate status table', () => {
  const rows: [number, string][] = [
    [199, 'unavailable'],
    [200, 'created'],
    [201, 'created'],
    [202, 'created'],
    [203, 'unavailable'],
    [204, 'unavailable'],
    [299, 'unavailable'],
    [300, 'unavailable'],
  ];
  for (const [status, kind] of rows) {
    it(`${status} with a complete body is ${kind}`, () => {
      expect(mapCreate(http(status, createBody())).result.kind).toBe(kind);
    });
  }
  it('199 and 300 go through the error map, not the unreadable answer', () => {
    expect(mapCreate(http(404, { name: 'RESOURCE_NOT_FOUND' })).result.kind).toBe('not_found');
    expect(mapCreate(http(199)).result).toMatchObject({ kind: 'unavailable' });
    expect(mapCreate(http(300, {})).result.kind).toBe('unavailable');
    expect(mapCreate(http(409, {})).result.kind).toBe('in_progress');
  });
  it('201 and 200 with an unreadable body are unavailable, 202 is in_progress', () => {
    expect(mapCreate(http(200, null)).result).toEqual(UNAVAILABLE);
    expect(mapCreate(http(201, [])).result).toEqual(UNAVAILABLE);
    expect(mapCreate(http(202, null, { 'paypal-debug-id': 'DBG1' })).result).toEqual({
      kind: 'in_progress',
      debug_id: 'DBG1',
    });
    expect(mapCreate(http(200, createBody({ id: 'lower' }))).result).toEqual(UNAVAILABLE);
    expect(mapCreate(http(200, createBody({ status: 'NOPE' }))).result).toEqual(UNAVAILABLE);
    expect(mapCreate(http(200, createBody({ id: undefined }))).result).toEqual(UNAVAILABLE);
    expect(mapCreate(http(200, createBody({ status: undefined }))).result).toEqual(UNAVAILABLE);
    expect(mapCreate(http(202, createBody({ id: undefined }))).result.kind).toBe('in_progress');
    expect(mapCreate(http(202, createBody({ status: undefined }))).result.kind).toBe('in_progress');
  });
  it('the created result carries id, status, approve url and debug id', () => {
    expect(mapCreate(http(201, createBody(), { 'PayPal-Debug-Id': 'DBG2' })).result).toEqual({
      kind: 'created',
      provider_order_id: 'SBXORD00001',
      status: 'PAYER_ACTION_REQUIRED',
      approve_url: APPROVE,
      debug_id: 'DBG2',
    });
  });
  it('payer-action wins over approve; approve alone is used; none is MISSING; other host is HOST_NOT_ALLOWED', () => {
    const other = `${APPROVE}&second=1`;
    const both = createBody({
      links: [
        { rel: 'approve', href: other },
        { rel: 'payer-action', href: APPROVE },
      ],
    });
    expect(mapCreate(http(200, both)).result).toMatchObject({ approve_url: APPROVE });
    const approveOnly = createBody({ links: [{ rel: 'approve', href: other }] });
    expect(mapCreate(http(200, approveOnly)).result).toMatchObject({ approve_url: other });
    expect(mapCreate(http(200, createBody({ links: [] }))).result).toMatchObject({
      kind: 'rejected',
      http: 422,
      name: 'APPROVE_LINK_INVALID',
      issue: 'MISSING',
      debug_id: null,
    });
    expect(
      mapCreate(
        http(200, createBody({ links: [{ rel: 'approve', href: 'https://evil.invalid/x' }] })),
      ).result,
    ).toMatchObject({ kind: 'rejected', issue: 'HOST_NOT_ALLOWED' });
  });
});

describe('mapCapture status table', () => {
  const claim = orderBody();
  const rows: [number, string][] = [
    [199, 'unavailable'],
    [200, 'claim'],
    [201, 'claim'],
    [202, 'claim'],
    [203, 'unavailable'],
    [204, 'unavailable'],
    [206, 'unavailable'],
    [207, 'claim'],
    [208, 'unavailable'],
    [299, 'unavailable'],
    [300, 'unavailable'],
  ];
  for (const [status, kind] of rows) {
    it(`${status} is ${kind}`, () => {
      expect(mapCapture(http(status, claim), 'SBXORD00001').result.kind).toBe(kind);
    });
  }
  it('statuses outside 2xx go through the error map', () => {
    expect(mapCapture(http(404, {}), 'SBXORD00001').result.kind).toBe('not_found');
    expect(mapCapture(http(409, {}), 'SBXORD00001').result.kind).toBe('in_progress');
    expect(mapCapture(http(300, {}), 'SBXORD00001').result.kind).toBe('unavailable');
    expect(mapCapture(http(199, {}), 'SBXORD00001').result.kind).toBe('unavailable');
  });
  it('the claim carries http status, units and debug id', () => {
    const r = mapCapture(http(207, claim, { 'paypal-debug-id': 'DBG3' }), 'SBXORD00001');
    expect(r.result).toMatchObject({
      kind: 'claim',
      http: 207,
      provider_order_id: 'SBXORD00001',
      debug_id: 'DBG3',
      units: [{ reference_id: 'unit-1', capture_id: 'SBXCAP00001', status: 'COMPLETED' }],
    });
    expect(r.notes).toContain('refunded_source=none');
  });
  it('a body id that is not the requested id is malformed, also on 202', () => {
    for (const s of [200, 201, 202, 207]) {
      const r = mapCapture(http(s, orderBody({ id: 'SBXOTHER001' })), 'SBXORD00001');
      expect(r.result, String(s)).toEqual(UNAVAILABLE);
      expect(r.notes).toEqual(['malformed_response']);
    }
  });
  it('a body without an id: 202 takes the requested id; 200, 201 and 207 are malformed', () => {
    const noId = orderBody({ id: undefined });
    expect(mapCapture(http(202, noId), 'SBXORD00001').result).toMatchObject({
      kind: 'claim',
      provider_order_id: 'SBXORD00001',
    });
    for (const s of [200, 201, 207]) {
      expect(mapCapture(http(s, noId), 'SBXORD00001').result, String(s)).toEqual(UNAVAILABLE);
    }
  });
  it('a 202 with a present but invalid id, or an id of the wrong type, is malformed', () => {
    expect(mapCapture(http(202, { id: 'bad id' }), 'SBXORD00001').result).toEqual(UNAVAILABLE);
    expect(mapCapture(http(202, { id: 5 }), 'SBXORD00001').result).toEqual(UNAVAILABLE);
    expect(mapCapture(http(202, { id: null }), 'SBXORD00001').result).toEqual(UNAVAILABLE);
  });
  it('a 202 with no body, an empty body or unreadable units still claims with no units', () => {
    expect(mapCapture(http(202, null), 'SBXORD00001').result).toMatchObject({
      kind: 'claim',
      units: [],
    });
    expect(mapCapture(http(202, {}), 'SBXORD00001').result).toMatchObject({ units: [] });
    expect(mapCapture(http(202, { purchase_units: 'x' }), 'SBXORD00001').result).toMatchObject({
      kind: 'claim',
      http: 202,
      units: [],
    });
  });
  it('200, 201 and 207 with unreadable units are malformed', () => {
    for (const s of [200, 201, 207]) {
      expect(mapCapture(http(s, null), 'SBXORD00001').result, String(s)).toEqual(UNAVAILABLE);
      expect(
        mapCapture(http(s, { id: 'SBXORD00001', purchase_units: 'x' }), 'SBXORD00001').result,
      ).toEqual(UNAVAILABLE);
      expect(
        mapCapture(
          http(
            s,
            orderBody({
              purchase_units: [unit({ payments: { captures: [cap({ amount: null })] } })],
            }),
          ),
          'SBXORD00001',
        ).result,
      ).toEqual(UNAVAILABLE);
      expect(
        mapCapture(
          http(s, orderBody({ purchase_units: [unit({ reference_id: '' })] })),
          'SBXORD00001',
        ).result,
      ).toEqual(UNAVAILABLE);
      expect(mapCapture(http(s, orderBody({ purchase_units: [7] })), 'SBXORD00001').result).toEqual(
        UNAVAILABLE,
      );
    }
  });
  it('a unit with no capture claims capture_id null and status null; no units at all is an empty claim', () => {
    const none = orderBody({ purchase_units: [unit({ payments: { captures: [] } })] });
    expect(mapCapture(http(200, none), 'SBXORD00001').result).toMatchObject({
      units: [{ reference_id: 'unit-1', capture_id: null, status: null }],
    });
    const noUnits = orderBody({ purchase_units: undefined });
    expect(mapCapture(http(200, noUnits), 'SBXORD00001').result).toMatchObject({
      kind: 'claim',
      units: [],
    });
  });
  it('a missing reference_id reads as default', () => {
    const b = orderBody({ purchase_units: [unit({ reference_id: undefined })] });
    expect(mapCapture(http(200, b), 'SBXORD00001').result).toMatchObject({
      units: [{ reference_id: 'default' }],
    });
  });
});

describe('mapRefund status table', () => {
  const rows: [number, string][] = [
    [199, 'unavailable'],
    [200, 'refund'],
    [201, 'refund'],
    [202, 'unavailable'],
    [204, 'unavailable'],
    [299, 'unavailable'],
    [300, 'unavailable'],
  ];
  for (const [status, kind] of rows) {
    it(`${status} is ${kind}`, () => {
      expect(mapRefund(http(status, refundBody())).result.kind).toBe(kind);
    });
  }
  it('statuses outside 2xx go through the error map', () => {
    expect(mapRefund(http(404, {})).result.kind).toBe('not_found');
    expect(mapRefund(http(409, {})).result.kind).toBe('in_progress');
    expect(mapRefund(http(300, {})).result.kind).toBe('unavailable');
    expect(mapRefund(http(199, {})).result.kind).toBe('unavailable');
  });
  it('the refund result carries id, status, amount, capture id and debug id', () => {
    expect(mapRefund(http(201, refundBody(), { 'paypal-debug-id': 'DBG4' })).result).toEqual({
      kind: 'refund',
      refund_id: 'SBXREF00001',
      status: 'COMPLETED',
      amount: { currency: 'USD', minor: 500 },
      capture_id: 'SBXCAP00001',
      debug_id: 'DBG4',
    });
  });
  it('every null guard answers malformed_response', () => {
    const bad: unknown[] = [
      null,
      [],
      'x',
      refundBody({ id: undefined }),
      refundBody({ id: 7 }),
      refundBody({ id: '' }),
      refundBody({ id: 'a'.repeat(65) }),
      refundBody({ id: 'bad id' }),
      refundBody({ status: 'NOPE' }),
      refundBody({ status: undefined }),
      refundBody({ amount: undefined }),
      refundBody({ amount: { currency_code: 'USD', value: '5.001' } }),
    ];
    for (const b of bad) {
      const r = mapRefund(http(200, b));
      expect(r.result, JSON.stringify(b)).toEqual(UNAVAILABLE);
      expect(r.notes).toEqual(['malformed_response']);
    }
    expect(mapRefund(http(200, refundBody({ id: 'a'.repeat(64) }))).result.kind).toBe('refund');
  });
  it('the capture id comes from the up link only, matching the captures path exactly', () => {
    const cases: [unknown, string | null][] = [
      [undefined, null],
      ['x', null],
      [[{ rel: 'self', href: 'https://x.invalid/v2/payments/captures/SBXCAP00001' }], null],
      [[{ rel: 'up', href: 5 }], null],
      [
        [null, { rel: 'up', href: 'https://x.invalid/v2/payments/captures/SBXCAP00002' }],
        'SBXCAP00002',
      ],
      [[{ rel: 'up', href: 'https://x.invalid/v2/payments/captures/lower' }], null],
      [[{ rel: 'up', href: 'https://x.invalid/v2/payments/captures/SBXCAP00001/x' }], null],
      [[{ rel: 'up', href: 'https://x.invalid/v2/payments/captures/' }], null],
      [
        [{ rel: 'up', href: `https://x.invalid/v2/payments/captures/${'A'.repeat(36)}` }],
        'A'.repeat(36),
      ],
      [[{ rel: 'up', href: `https://x.invalid/v2/payments/captures/${'A'.repeat(37)}` }], null],
      [
        [
          { rel: 'up', href: 'https://x.invalid/other' },
          { rel: 'up', href: 'https://x.invalid/v2/payments/captures/SBXCAP00003' },
        ],
        'SBXCAP00003',
      ],
    ];
    for (const [links, want] of cases) {
      const r = mapRefund(http(200, refundBody({ links })));
      expect(r.result, JSON.stringify(links)).toMatchObject({ capture_id: want });
    }
  });
});

describe('mapOrder and mapCaptureRead status table', () => {
  const rows: [number, string][] = [
    [199, 'unavailable'],
    [200, 'order'],
    [201, 'unavailable'],
    [202, 'unavailable'],
    [204, 'unavailable'],
    [299, 'unavailable'],
    [300, 'unavailable'],
  ];
  for (const [status, kind] of rows) {
    it(`mapOrder ${status} is ${kind}`, () => {
      expect(mapOrder(http(status, orderBody()), NOW).result.kind).toBe(kind);
    });
    it(`mapCaptureRead ${status} is ${kind === 'order' ? 'capture' : kind}`, () => {
      expect(mapCaptureRead(http(status, cap()), NOW).result.kind).toBe(
        kind === 'order' ? 'capture' : kind,
      );
    });
  }
  it('statuses outside 2xx go through the error map', () => {
    for (const f of [
      (s: number) => mapOrder(http(s, {}), NOW).result.kind,
      (s: number) => mapCaptureRead(http(s, {}), NOW).result.kind,
    ]) {
      expect(f(404)).toBe('not_found');
      expect(f(409)).toBe('in_progress');
      expect(f(300)).toBe('unavailable');
      expect(f(199)).toBe('unavailable');
    }
  });
  it('the order result is complete', () => {
    const r = mapOrder(
      http(200, orderBody({ purchase_units: [unit({ custom_id: 'c-1' })] }), {
        'paypal-debug-id': 'DBG5',
      }),
      NOW,
    );
    expect(r.result).toEqual({
      kind: 'order',
      provider_order_id: 'SBXORD00001',
      status: 'COMPLETED',
      custom_id: 'c-1',
      read_at: '2026-02-03T04:05:06.000Z',
      debug_id: 'DBG5',
      units: [
        {
          reference_id: 'unit-1',
          payee_merchant_id: 'SBXMERCHANT01',
          amount: { currency: 'USD', minor: 500 },
          capture: {
            capture_id: 'SBXCAP00001',
            status: 'COMPLETED',
            status_reason: null,
            amount: { currency: 'USD', minor: 500 },
            paypal_fee_minor: null,
            refunded_minor: 0,
          },
        },
      ],
    });
    expect(r.notes).toEqual(['refunded_source=none', 'refunded_advisory=use_get_refund']);
  });
  it('every order null guard answers malformed_response', () => {
    const bad: unknown[] = [
      null,
      [],
      orderBody({ id: undefined }),
      orderBody({ id: 'lower' }),
      orderBody({ status: 'NOPE' }),
      orderBody({ status: undefined }),
      orderBody({ purchase_units: 'x' }),
      orderBody({ purchase_units: [null] }),
      orderBody({ purchase_units: [unit({ reference_id: '' })] }),
      orderBody({ purchase_units: [unit({ amount: undefined })] }),
      orderBody({ purchase_units: [unit({ payments: { captures: [cap({ id: '' })] } })] }),
    ];
    for (const b of bad) {
      const r = mapOrder(http(200, b), NOW);
      expect(r.result, JSON.stringify(b)).toEqual(UNAVAILABLE);
      expect(r.notes).toEqual(['malformed_response']);
    }
  });
  it('payee is null without a merchant id string; unit without captures has capture null', () => {
    const b = orderBody({
      purchase_units: [unit({ payee: { merchant_id: 5 }, payments: undefined })],
    });
    expect(mapOrder(http(200, b), NOW).result).toMatchObject({
      units: [{ payee_merchant_id: null, capture: null }],
    });
    expect(
      mapOrder(http(200, orderBody({ purchase_units: [unit({ payee: 'x' })] })), NOW).result,
    ).toMatchObject({ units: [{ payee_merchant_id: null }] });
  });
  it('custom_id: one shared value stays, disagreeing or missing units read as null', () => {
    const two = (a: unknown, b: unknown) =>
      orderBody({
        purchase_units: [
          unit({ reference_id: 'u1', custom_id: a }),
          unit({ reference_id: 'u2', custom_id: b }),
        ],
      });
    expect(mapOrder(http(200, two('c', 'c')), NOW).result).toMatchObject({ custom_id: 'c' });
    expect(mapOrder(http(200, two('c', 'd')), NOW).result).toMatchObject({ custom_id: null });
    expect(mapOrder(http(200, two('c', undefined)), NOW).result).toMatchObject({ custom_id: null });
    expect(mapOrder(http(200, two(undefined, undefined)), NOW).result).toMatchObject({
      custom_id: null,
    });
    expect(mapOrder(http(200, two(5, 5)), NOW).result).toMatchObject({ custom_id: null });
    expect(mapOrder(http(200, orderBody({ purchase_units: [] })), NOW).result).toMatchObject({
      custom_id: null,
      units: [],
    });
    expect(mapOrder(http(200, orderBody({ purchase_units: undefined })), NOW).result).toMatchObject(
      {
        units: [],
      },
    );
  });
  it('missing reference_id is default', () => {
    const b = orderBody({ purchase_units: [unit({ reference_id: undefined })] });
    expect(mapOrder(http(200, b), NOW).result).toMatchObject({
      units: [{ reference_id: 'default' }],
    });
  });
});

describe('readCapture null guards and fields', () => {
  it('rejects non-records, bad ids, bad status, missing or bad amount', () => {
    for (const c of [
      null,
      [],
      'x',
      cap({ id: undefined }),
      cap({ id: 5 }),
      cap({ id: '' }),
      cap({ id: 'a'.repeat(65) }),
      cap({ status: 'REVERSED' }),
      cap({ status: undefined }),
      cap({ amount: undefined }),
      cap({ amount: { currency_code: 'USD' } }),
      cap({ amount: { currency_code: 5, value: '1.00' } }),
      cap({ amount: { currency_code: 'USD', value: 5 } }),
      cap({ amount: { currency_code: 'USD', value: '1.234' } }),
    ]) {
      expect(readCapture(c), JSON.stringify(c)).toBeNull();
    }
    expect(readCapture(cap({ id: 'a'.repeat(64) }))).not.toBeNull();
    expect(readCapture(cap({ id: 'a' }))).not.toBeNull();
  });
  it('fee: read, absent, unreadable, other currency', () => {
    const fee = (v: unknown) => cap({ seller_receivable_breakdown: { paypal_fee: v } });
    expect(readCapture(fee({ currency_code: 'USD', value: '0.45' }))?.part.paypal_fee_minor).toBe(
      45,
    );
    expect(readCapture(cap({ seller_receivable_breakdown: {} }))?.part.paypal_fee_minor).toBeNull();
    expect(
      readCapture(cap({ seller_receivable_breakdown: 'x' }))?.part.paypal_fee_minor,
    ).toBeNull();
    expect(readCapture(fee({ currency_code: 'USD', value: 'x' }))).toBeNull();
    expect(readCapture(fee(null))).toBeNull();
    const other = readCapture(fee({ currency_code: 'EUR', value: '0.45' }));
    expect(other?.part.paypal_fee_minor).toBeNull();
    expect(other?.notes).toContain('fee_currency_mismatch');
    expect(readCapture(fee({ currency_code: 'USD', value: '0.45' }))?.notes).not.toContain(
      'fee_currency_mismatch',
    );
  });
  it('refunded total: breakdown first, then capture, else zero; unreadable is null', () => {
    const m = (v: string) => ({ currency_code: 'USD', value: v });
    const both = readCapture(
      cap({
        seller_receivable_breakdown: { total_refunded_amount: m('1.00') },
        total_refunded_amount: m('2.00'),
      }),
    );
    expect(both?.part.refunded_minor).toBe(100);
    expect(both?.notes).toContain('refunded_source=seller_receivable_breakdown');
    const fromCap = readCapture(cap({ total_refunded_amount: m('2.00') }));
    expect(fromCap?.part.refunded_minor).toBe(200);
    expect(fromCap?.notes).toContain('refunded_source=capture');
    expect(readCapture(cap())?.part.refunded_minor).toBe(0);
    expect(
      readCapture(cap({ seller_receivable_breakdown: { total_refunded_amount: 'x' } })),
    ).toBeNull();
    expect(readCapture(cap({ total_refunded_amount: 'x' }))).toBeNull();
    expect(
      readCapture(cap({ seller_receivable_breakdown: { total_refunded_amount: null } })),
    ).toBeNull();
  });
  it('status reason: a string only', () => {
    expect(readCapture(cap({ status_details: { reason: 'ECHECK' } }))?.part.status_reason).toBe(
      'ECHECK',
    );
    expect(readCapture(cap({ status_details: { reason: 5 } }))?.part.status_reason).toBeNull();
    expect(readCapture(cap({ status_details: 'x' }))?.part.status_reason).toBeNull();
    expect(readCapture(cap())?.part.status_reason).toBeNull();
  });
});

describe('latestCapture and purchaseUnits', () => {
  it('latest by create_time, then id; non-records skipped; none is undefined', () => {
    const of = (captures: unknown) => latestCapture({ payments: { captures } });
    const a = cap({ id: 'A', create_time: '2026-01-01T00:00:00Z' });
    const b = cap({ id: 'B', create_time: '2026-01-02T00:00:00Z' });
    expect(of([b, a])).toBe(b);
    expect(of([a, b])).toBe(b);
    const c1 = cap({ id: 'C1', create_time: '2026-01-01T00:00:00Z' });
    const c2 = cap({ id: 'C2', create_time: '2026-01-01T00:00:00Z' });
    expect(of([c2, c1])).toBe(c2);
    expect(of([c1, c2])).toBe(c2);
    expect(of([null, 'x', a])).toBe(a);
    const dated = cap({ id: 'D', create_time: '2026-01-01T00:00:00Z' });
    const undated = cap({ id: 'Z', create_time: 'not a date' });
    expect(of([undated, dated])).toBe(dated);
    expect(of([dated, undated])).toBe(dated);
    const noId1 = { create_time: '2026-01-01T00:00:00Z' };
    expect(of([noId1])).toBe(noId1);
    expect(of([])).toBeUndefined();
    expect(of('x')).toBeUndefined();
    expect(latestCapture({})).toBeUndefined();
    expect(latestCapture({ payments: 'x' })).toBeUndefined();
    expect(latestCapture({ payments: [] })).toBeUndefined();
  });
  it('purchaseUnits', () => {
    expect(purchaseUnits(null)).toBeNull();
    expect(purchaseUnits([])).toBeNull();
    expect(purchaseUnits({})).toEqual([]);
    expect(purchaseUnits({ purchase_units: 'x' })).toBeNull();
    expect(purchaseUnits({ purchase_units: [1] })).toBeNull();
    expect(purchaseUnits({ purchase_units: [] })).toEqual([]);
    expect(purchaseUnits({ purchase_units: [{ a: 1 }] })).toEqual([{ a: 1 }]);
  });
});
