import { describe, expect, it } from 'vitest';
import { mapError } from './errors';
import { APPROVE_HOST } from './test-support';

const err = (name: string, issue: string | null, extra: Record<string, unknown> = {}) => ({
  name,
  message: 'text that must never drive the mapping',
  debug_id: 'dbg-1',
  details: issue === null ? [] : [{ issue, description: 'ignored' }],
  links: [],
  ...extra,
});
const rejected = (http: 400 | 403 | 422, name: string, issue: string | null) => ({
  kind: 'rejected',
  http,
  name,
  issue,
  debug_id: 'dbg-1',
});

// Expected values are copied from the architecture 9.1 table, not computed from the code.
describe('error map: one test per row of architecture 9.1', () => {
  it('400 INVALID_REQUEST MALFORMED_REQUEST_JSON -> rejected', () => {
    expect(mapError(400, err('INVALID_REQUEST', 'MALFORMED_REQUEST_JSON'), {})).toEqual(
      rejected(400, 'INVALID_REQUEST', 'MALFORMED_REQUEST_JSON'),
    );
  });
  it('400 INVALID_REQUEST INVALID_PARAMETER_VALUE -> rejected', () => {
    expect(mapError(400, err('INVALID_REQUEST', 'INVALID_PARAMETER_VALUE'), {})).toEqual(
      rejected(400, 'INVALID_REQUEST', 'INVALID_PARAMETER_VALUE'),
    );
  });
  it('401 AUTHENTICATION_FAILURE -> unavailable (adapter refreshes once before this)', () => {
    expect(mapError(401, err('AUTHENTICATION_FAILURE', null), {})).toEqual({
      kind: 'unavailable',
      retry_after_ms: null,
    });
  });
  it('403 NOT_AUTHORIZED PERMISSION_DENIED -> rejected', () => {
    expect(mapError(403, err('NOT_AUTHORIZED', 'PERMISSION_DENIED'), {})).toEqual(
      rejected(403, 'NOT_AUTHORIZED', 'PERMISSION_DENIED'),
    );
  });
  it('403 NOT_AUTHORIZED PAYEE_NOT_CONSENTED -> rejected', () => {
    expect(mapError(403, err('NOT_AUTHORIZED', 'PAYEE_NOT_CONSENTED'), {})).toEqual(
      rejected(403, 'NOT_AUTHORIZED', 'PAYEE_NOT_CONSENTED'),
    );
  });
  it('404 RESOURCE_NOT_FOUND INVALID_RESOURCE_ID -> not_found', () => {
    expect(mapError(404, err('RESOURCE_NOT_FOUND', 'INVALID_RESOURCE_ID'), {})).toEqual({
      kind: 'not_found',
      debug_id: 'dbg-1',
    });
  });
  it('409 RESOURCE_CONFLICT PREVIOUS_REQUEST_IN_PROGRESS -> in_progress', () => {
    expect(mapError(409, err('RESOURCE_CONFLICT', 'PREVIOUS_REQUEST_IN_PROGRESS'), {})).toEqual({
      kind: 'in_progress',
      debug_id: 'dbg-1',
    });
  });
  it('422 ORDER_NOT_APPROVED -> rejected', () => {
    expect(mapError(422, err('UNPROCESSABLE_ENTITY', 'ORDER_NOT_APPROVED'), {})).toEqual(
      rejected(422, 'UNPROCESSABLE_ENTITY', 'ORDER_NOT_APPROVED'),
    );
  });
  it('422 ORDER_ALREADY_CAPTURED -> rejected (payments reads back)', () => {
    expect(mapError(422, err('UNPROCESSABLE_ENTITY', 'ORDER_ALREADY_CAPTURED'), {})).toEqual(
      rejected(422, 'UNPROCESSABLE_ENTITY', 'ORDER_ALREADY_CAPTURED'),
    );
  });
  it.each(['PAYER_ACTION_REQUIRED', 'INSTRUMENT_DECLINED', 'REDIRECT_PAYER_FOR_ALTERNATE_FUNDING'])(
    '422 %s -> payer_action with the payer-action link',
    (issue) => {
      const url = `https://${APPROVE_HOST}/checkoutnow?token=SBXORD1`;
      const body = err('UNPROCESSABLE_ENTITY', issue, {
        links: [
          { href: '/v2/checkout/orders/SBXORD1', rel: 'self', method: 'GET' },
          { href: url, rel: 'payer-action', method: 'GET' },
        ],
      });
      expect(mapError(422, body, {})).toEqual({
        kind: 'payer_action',
        redirect_url: url,
        debug_id: 'dbg-1',
      });
    },
  );
  it('422 INSTRUMENT_DECLINED with a redirect link -> payer_action with that link', () => {
    const url = `https://${APPROVE_HOST}/checkoutnow?token=SBXORD1`;
    const body = err('UNPROCESSABLE_ENTITY', 'INSTRUMENT_DECLINED', {
      links: [{ href: url, rel: 'redirect', method: 'GET' }],
    });
    expect(mapError(422, body, {})).toMatchObject({ kind: 'payer_action', redirect_url: url });
  });
  it('422 PAYER_ACTION_REQUIRED without a link -> payer_action with null url', () => {
    expect(mapError(422, err('UNPROCESSABLE_ENTITY', 'PAYER_ACTION_REQUIRED'), {})).toEqual({
      kind: 'payer_action',
      redirect_url: null,
      debug_id: 'dbg-1',
    });
  });
  it('422 payer action link on another host is not passed up', () => {
    const body = err('UNPROCESSABLE_ENTITY', 'PAYER_ACTION_REQUIRED', {
      links: [{ href: 'https://evil.example.invalid/x', rel: 'payer-action', method: 'GET' }],
    });
    expect(mapError(422, body, {})).toMatchObject({ kind: 'payer_action', redirect_url: null });
  });
  it('422 DUPLICATE_INVOICE_ID -> rejected', () => {
    expect(mapError(422, err('UNPROCESSABLE_ENTITY', 'DUPLICATE_INVOICE_ID'), {})).toEqual(
      rejected(422, 'UNPROCESSABLE_ENTITY', 'DUPLICATE_INVOICE_ID'),
    );
  });
  it.each([
    'TRANSACTION_REFUSED',
    'COMPLIANCE_VIOLATION',
    'PAYEE_BLOCKED_TRANSACTION',
    'DOMESTIC_TRANSACTION_REQUIRED',
    'MAX_NUMBER_OF_PAYMENT_ATTEMPTS_EXCEEDED',
  ])('422 capture %s -> rejected', (issue) => {
    expect(mapError(422, err('UNPROCESSABLE_ENTITY', issue), {})).toEqual(
      rejected(422, 'UNPROCESSABLE_ENTITY', issue),
    );
  });
  it.each([
    'MULTI_CURRENCY_ORDER',
    'DECIMAL_PRECISION',
    'INVALID_CURRENCY_CODE',
    'PAYEE_ACCOUNT_INVALID',
    'PAYEE_ACCOUNT_LOCKED_OR_CLOSED',
    'PAYEE_ACCOUNT_RESTRICTED',
    'PLATFORM_FEES_NOT_SUPPORTED',
  ])('422 create %s -> rejected', (issue) => {
    expect(mapError(422, err('UNPROCESSABLE_ENTITY', issue), {})).toEqual(
      rejected(422, 'UNPROCESSABLE_ENTITY', issue),
    );
  });
  it('429 -> unavailable with Retry-After seconds as milliseconds', () => {
    expect(mapError(429, { name: 'RATE_LIMIT_REACHED' }, { 'retry-after': '2' })).toEqual({
      kind: 'unavailable',
      retry_after_ms: 2000,
    });
    expect(mapError(429, {}, { 'Retry-After': '30' })).toEqual({
      kind: 'unavailable',
      retry_after_ms: 30000,
    });
  });
  it('429 without a usable Retry-After -> null', () => {
    for (const h of [
      {},
      { 'retry-after': 'soon' },
      { 'retry-after': '-5' },
      { 'retry-after': '1.5' },
    ]) {
      expect(mapError(429, {}, h)).toEqual({ kind: 'unavailable', retry_after_ms: null });
    }
  });
  it('5xx -> unavailable', () => {
    for (const s of [500, 502, 503, 504]) {
      expect(mapError(s, { name: 'INTERNAL_SERVER_ERROR' }, {}), String(s)).toEqual({
        kind: 'unavailable',
        retry_after_ms: null,
      });
    }
    expect(mapError(503, {}, { 'retry-after': '7' })).toEqual({
      kind: 'unavailable',
      retry_after_ms: 7000,
    });
  });
  it('takes the debug id from the paypal-debug-id header first, then the body', () => {
    expect(mapError(404, { debug_id: 'body-id' }, { 'paypal-debug-id': 'hdr-id' })).toEqual({
      kind: 'not_found',
      debug_id: 'hdr-id',
    });
    expect(mapError(404, { debug_id: 'body-id' }, {})).toEqual({
      kind: 'not_found',
      debug_id: 'body-id',
    });
    expect(mapError(404, null, {})).toEqual({ kind: 'not_found', debug_id: null });
  });
});
