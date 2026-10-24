// BU-6b: the call log redactor, unit level. Every value here is invented: the ids, names and
// addresses are fake, none is a real PayPal or personal value.
// Simulation tests prove the modelled cases only, not PayPal compatibility.
import { describe, expect, it } from 'vitest';
import { redactCallBody, renderCallsJson } from './sandbox-subject';

const OWN = 'FAKEOWNMERCH7K3Q';
const OTHER = 'FAKEACCTMERCH9Z2X';
const MASK = 'MERCHANT-REDACTED';

/** A create-order answer in the shape PayPal returns it (invented values). */
const createAnswer = () => ({
  id: 'FAKEORDER5O190127T',
  status: 'CREATED',
  intent: 'CAPTURE',
  purchase_units: [
    {
      reference_id: 'unit-1',
      custom_id: 'ord_FAKE1',
      amount: { currency_code: 'USD', value: '1.00' },
      payee: { email_address: 'seller.fake@example.invalid', merchant_id: OTHER },
    },
  ],
  create_time: '2026-11-02T08:30:00Z',
  links: [
    {
      href: 'https://api.sandbox.paypal.com/v2/checkout/orders/FAKEORDER5O190127T',
      rel: 'self',
      method: 'GET',
    },
    {
      href: 'https://www.sandbox.paypal.com/checkoutnow?token=FAKEORDER5O190127T',
      rel: 'approve',
      method: 'GET',
    },
    {
      href: 'https://api.sandbox.paypal.com/v2/checkout/orders/FAKEORDER5O190127T/capture',
      rel: 'capture',
      method: 'POST',
    },
  ],
});

/** A capture answer with the payer block PayPal adds after approval (invented values). */
const captureAnswer = () => ({
  id: 'FAKEORDER5O190127T',
  status: 'COMPLETED',
  payment_source: {
    paypal: {
      email_address: 'buyer.fake@example.invalid',
      account_id: 'FAKEACCOUNTID01',
      name: { given_name: 'Pat', surname: 'Doe' },
      address: { country_code: 'DE' },
    },
  },
  purchase_units: [
    {
      reference_id: 'unit-1',
      payee: { email_address: 'seller.fake@example.invalid', merchant_id: OTHER },
      shipping: {
        name: { full_name: 'Pat Doe' },
        address: {
          address_line_1: '1 Fake Street',
          admin_area_2: 'Faketown',
          postal_code: '00000',
        },
      },
      payments: {
        captures: [
          {
            id: 'FAKECAPTURE3AB77XY',
            status: 'COMPLETED',
            amount: { currency_code: 'USD', value: '1.00' },
            links: [
              {
                href: 'https://api.sandbox.paypal.com/v2/payments/captures/FAKECAPTURE3AB77XY',
                rel: 'self',
                method: 'GET',
              },
            ],
          },
        ],
      },
    },
  ],
  payer: {
    email_address: 'buyer.fake@example.invalid',
    payer_id: 'FAKEPAYERID0001',
    name: { given_name: 'Pat', surname: 'Doe' },
    phone: { phone_number: { national_number: '5550100' } },
  },
});

const unit0 = (v: unknown) =>
  (v as { purchase_units: Record<string, Record<string, unknown>>[] }).purchase_units[0] as Record<
    string,
    Record<string, unknown>
  >;

describe('redactCallBody: merchant ids', () => {
  it('purchase_units[].payee.merchant_id keeps a fixed placeholder and the last 4 characters only', () => {
    const out = redactCallBody(createAnswer(), OWN);
    expect(unit0(out).payee?.merchant_id).toBe(`${MASK}-9Z2X`);
    expect(JSON.stringify(out)).not.toContain(OTHER);
    expect(JSON.stringify(out)).not.toContain('FAKEACCTMERCH');
  });
  it('a string equal to our own merchant id, at any key, becomes the existing placeholder', () => {
    const out = redactCallBody(
      { purchase_units: [{ payee: { merchant_id: OWN } }], note: OWN },
      OWN,
    );
    expect(JSON.stringify(out)).not.toContain(OWN);
    expect(JSON.stringify(out)).toContain('OWNMERCHANT01');
  });
  it('merchant_id and payee_merchant_id are masked at any depth, in objects and arrays', () => {
    const out = redactCallBody(
      { a: { b: [{ c: { merchant_id: OTHER } }, { payee_merchant_id: OTHER }] } },
      null,
    );
    expect(out).toEqual({
      a: { b: [{ c: { merchant_id: `${MASK}-9Z2X` } }, { payee_merchant_id: `${MASK}-9Z2X` }] },
    });
  });
  it('a merchant id under 8 characters shows no tail; from 8 characters the last 4 show', () => {
    expect(redactCallBody({ merchant_id: 'ABC1234' }, null)).toEqual({ merchant_id: MASK });
    expect(redactCallBody({ merchant_id: 'ABCD12345' }, null)).toEqual({
      merchant_id: `${MASK}-2345`,
    });
    expect(redactCallBody({ merchant_id: 'ABCDEFGH' }, null)).toEqual({
      merchant_id: `${MASK}-EFGH`,
    });
  });
  it('a non-string merchant_id is dropped, null stays null', () => {
    expect(redactCallBody({ merchant_id: 12345678 }, null)).toEqual({ merchant_id: '[redacted]' });
    expect(redactCallBody({ merchant_id: { x: OTHER } }, null)).toEqual({
      merchant_id: '[redacted]',
    });
    expect(redactCallBody({ merchant_id: null }, null)).toEqual({ merchant_id: null });
  });
});

describe('redactCallBody: approval links', () => {
  it('links[].href keeps host, path and the parameter name, and masks the token value', () => {
    const out = redactCallBody(createAnswer(), OWN) as ReturnType<typeof createAnswer>;
    const approve = out.links.find((l) => l.rel === 'approve');
    expect(approve?.href).toBe('https://www.sandbox.paypal.com/checkoutnow?token=<redacted>');
    expect(JSON.stringify(out)).not.toMatch(/token=(?!<redacted>)/);
  });
  it('other links are left alone', () => {
    const out = redactCallBody(createAnswer(), OWN) as ReturnType<typeof createAnswer>;
    expect(out.links.map((l) => l.href).filter((h) => !h.includes('token'))).toEqual([
      'https://api.sandbox.paypal.com/v2/checkout/orders/FAKEORDER5O190127T',
      'https://api.sandbox.paypal.com/v2/checkout/orders/FAKEORDER5O190127T/capture',
    ]);
  });
  it.each([
    [
      'https://h.example.invalid/a?token=AAA111&useraction=commit',
      'https://h.example.invalid/a?token=<redacted>&useraction=commit',
    ],
    [
      'https://h.example.invalid/a?x=1&token=AAA111',
      'https://h.example.invalid/a?x=1&token=<redacted>',
    ],
    [
      'https://h.example.invalid/a?ba_token=BA-1234&x=1',
      'https://h.example.invalid/a?ba_token=<redacted>&x=1',
    ],
    [
      'https://h.example.invalid/a?TOKEN=AAA111#frag',
      'https://h.example.invalid/a?TOKEN=<redacted>#frag',
    ],
    ['https://h.example.invalid/a?token=', 'https://h.example.invalid/a?token=<redacted>'],
    [
      'https://h.example.invalid/a?tokens=keep&mytoken_x=keep',
      'https://h.example.invalid/a?tokens=keep&mytoken_x=keep',
    ],
    ['https://h.example.invalid/token=notaquery', 'https://h.example.invalid/token=notaquery'],
  ])('the token value in %s', (before, after) => {
    expect(redactCallBody({ links: [{ href: before }] }, null)).toEqual({
      links: [{ href: after }],
    });
  });
  it('a bare string body gets the same treatment', () => {
    expect(redactCallBody('see https://h.example.invalid/c?token=ZZZ999 now', null)).toBe(
      'see https://h.example.invalid/c?token=<redacted> now',
    );
  });
});

describe('redactCallBody: personal and secret keys (the exact list)', () => {
  it('drops payee_id, payer_id, account_id, email, name and address fields, phone fields', () => {
    const out = JSON.stringify(redactCallBody(captureAnswer(), OWN));
    for (const leak of [
      'buyer.fake',
      'seller.fake',
      'FAKEACCOUNTID01',
      'FAKEPAYERID0001',
      'Pat',
      'Doe',
      '1 Fake Street',
      'Faketown',
      '00000',
      '5550100',
    ])
      expect(out, leak).not.toContain(leak);
  });
  it.each([
    'payee_id',
    'payer_id',
    'account_id',
    'email_address',
    'payer_email',
    'given_name',
    'surname',
    'full_name',
    'address_line_1',
    'admin_area_1',
    'postal_code',
    'phone_number',
    'national_number',
    'access_token',
    'client_secret',
    'authorization',
  ])('the value under key %s is replaced', (k) => {
    expect(redactCallBody({ x: { [k]: 'FAKEVALUE123456' } }, null)).toEqual({
      x: { [k]: '[redacted]' },
    });
  });
  it('keeps order ids, capture ids, statuses, amounts and the debug id fields of the answer', () => {
    const out = redactCallBody(captureAnswer(), OWN) as ReturnType<typeof captureAnswer>;
    expect(out.id).toBe('FAKEORDER5O190127T');
    expect(out.status).toBe('COMPLETED');
    const cap = out.purchase_units[0]?.payments.captures[0];
    expect(cap?.id).toBe('FAKECAPTURE3AB77XY');
    expect(cap?.amount).toEqual({ currency_code: 'USD', value: '1.00' });
    expect(cap?.links[0]?.href).toBe(
      'https://api.sandbox.paypal.com/v2/payments/captures/FAKECAPTURE3AB77XY',
    );
  });
});

describe('redactCallBody: shape guarantees', () => {
  it('a body with none of these fields comes back equal', () => {
    const body = {
      id: 'FAKEORDER5O190127T',
      status: 'APPROVED',
      list: [1, 'two', null, true, { k: 'v' }],
      amount: { currency_code: 'USD', value: '1.00' },
      name: 'UNPROCESSABLE_ENTITY',
      details: [{ issue: 'ORDER_NOT_APPROVED', description: 'Order is not approved yet.' }],
    };
    expect(redactCallBody(body, OWN)).toEqual(body);
  });
  it('does not change its input', () => {
    const body = createAnswer();
    const before = JSON.stringify(body);
    redactCallBody(body, OWN);
    expect(JSON.stringify(body)).toBe(before);
  });
  it('is idempotent on realistic bodies and on masks', () => {
    for (const b of [
      createAnswer(),
      captureAnswer(),
      { merchant_id: 'ABC1234' },
      { merchant_id: OWN },
    ]) {
      const once = redactCallBody(b, OWN);
      expect(redactCallBody(once, OWN)).toEqual(once);
    }
  });
  it.each([
    ['null', null],
    ['undefined', undefined],
    ['a number', 42],
    ['a boolean', false],
    ['an empty string', ''],
    ['a string', 'plain text'],
    ['an empty array', []],
    ['an array of mixed values', [1, null, 'a', [2, { merchant_id: OTHER }]]],
    ['a bigint', 10n],
    ['a symbol', Symbol('s')],
    ['a function', () => 1],
  ])('never throws on %s', (_n, v) => {
    expect(() => redactCallBody(v, OWN)).not.toThrow();
    expect(() => redactCallBody(v, null)).not.toThrow();
    expect(() => JSON.stringify(redactCallBody(v, OWN))).not.toThrow();
  });
  it('the merchant id inside an array under merchant_id is dropped, not leaked', () => {
    const out = redactCallBody({ merchant_id: [OTHER] }, null);
    expect(JSON.stringify(out)).not.toContain(OTHER);
  });
  it('never throws on deep or cyclic input, and the result holds no cycle', () => {
    const cyc: Record<string, unknown> = { merchant_id: OTHER };
    cyc.self = cyc;
    const out = redactCallBody(cyc, OWN);
    expect(() => JSON.stringify(out)).not.toThrow();
    let deep: unknown = { merchant_id: OTHER };
    for (let i = 0; i < 100; i += 1) deep = { d: deep };
    expect(() => JSON.stringify(redactCallBody(deep, OWN))).not.toThrow();
    expect(JSON.stringify(redactCallBody(deep, OWN))).not.toContain(OTHER);
  });
  it('a __proto__ key from JSON is kept as data and does not change the result prototype', () => {
    const body = JSON.parse('{"__proto__":{"merchant_id":"FAKEACCTMERCH9Z2X"},"ok":1}') as unknown;
    const out = redactCallBody(body, null) as Record<string, unknown>;
    expect(Object.getPrototypeOf(out)).toBe(Object.prototype);
    expect(Object.keys(out).sort()).toEqual(['__proto__', 'ok']);
    expect(JSON.stringify(out)).not.toContain(OTHER);
  });
  it('with no own merchant id given, nothing is treated as our own', () => {
    expect(redactCallBody({ note: OWN }, null)).toEqual({ note: OWN });
  });
});

describe('renderCallsJson', () => {
  it('is two-space JSON with one trailing newline, and an empty log is []', () => {
    expect(renderCallsJson([])).toBe('[]\n');
    const log = [
      {
        scenario: 's',
        operation: 'get_order' as const,
        request: { method: 'GET' as const, path: '/p', headers: {}, body: null },
        response: { timeout: true as const },
      },
    ];
    expect(renderCallsJson(log)).toBe(`${JSON.stringify(log, null, 2)}\n`);
  });
});
