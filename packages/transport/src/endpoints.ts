import type { PayPalOperation } from '@umsbx/contracts';

// The one place that names the sandbox API host (scripts/check-no-live-host.mjs allows it only here).
// The base URL is a code constant: no config value can change it. There is no live value anywhere
// (architecture 7, nfr.md P15).
export const SANDBOX_API = 'https://api-m.sandbox.paypal.com' as const;

/** Host label suffix a webhook certificate URL must end with (nfr.md P1). */
export const CERT_HOST_SUFFIX = '.sandbox.paypal.com' as const;
/** Path prefix a webhook certificate URL must start with. */
export const CERT_PATH_PREFIX = '/v1/notifications/certs/' as const;

export interface PathSpec {
  method: 'GET' | 'POST';
  template: string;
  mvp: 'A' | 'B' | 'C';
}

// `{id}` is an order, capture or refund id and must match ^[A-Z0-9]{1,36}$.
// `mvp` is the first phase that calls the operation against the sandbox; MVP-A is fixtures only.
export const PATHS: Record<PayPalOperation, PathSpec> = {
  oauth_token: { method: 'POST', template: '/v1/oauth2/token', mvp: 'B' },
  create_order: { method: 'POST', template: '/v2/checkout/orders', mvp: 'B' },
  get_order: { method: 'GET', template: '/v2/checkout/orders/{id}', mvp: 'B' },
  capture_order: { method: 'POST', template: '/v2/checkout/orders/{id}/capture', mvp: 'B' },
  get_capture: { method: 'GET', template: '/v2/payments/captures/{id}', mvp: 'B' },
  refund_capture: { method: 'POST', template: '/v2/payments/captures/{id}/refund', mvp: 'C' },
  get_refund: { method: 'GET', template: '/v2/payments/refunds/{id}', mvp: 'C' },
  verify_webhook_postback: {
    method: 'POST',
    template: '/v1/notifications/verify-webhook-signature',
    mvp: 'C',
  },
  // The request path is an absolute certificate URL; the template is its allowed shape.
  fetch_webhook_cert: { method: 'GET', template: `${CERT_PATH_PREFIX}{cert}`, mvp: 'C' },
};

export const OPERATIONS = Object.keys(PATHS) as [PayPalOperation, ...PayPalOperation[]];

export const ID_PATTERN = '[A-Z0-9]{1,36}';
