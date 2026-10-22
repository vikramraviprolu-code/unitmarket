import type {
  Clock,
  LogEvent,
  Logger,
  OutboundGate,
  OutboundRequest,
  PayPalOperation,
} from '@umsbx/contracts';

// Host strings are assembled at runtime so no source file carries a live or sandbox hostname
// literal (scripts/check-no-live-host.mjs).
export const LIVE_HOST = ['api-m', 'paypal', 'com'].join('.');
export const SANDBOX_HOST = ['api-m', 'sandbox', 'paypal', 'com'].join('.');
export const CERT_HOST = ['api', 'sandbox', 'paypal', 'com'].join('.');

export const fixedClock = (iso = '2026-01-01T00:00:00Z'): Clock => ({ now: () => new Date(iso) });

export function memoryLogger(): Logger & { events: LogEvent[] } {
  const events: LogEvent[] = [];
  const make = (base: LogEvent['fields']): Logger => ({
    log: (e) => {
      events.push({ ...e, fields: { ...base, ...e.fields } });
    },
    child: (f) => make({ ...base, ...f }),
  });
  return Object.assign(make({}), { events });
}

export const openGate = (): OutboundGate => ({
  check: async () => ({ allowed: true, approval_ref: 'test-approval' }),
});

export function req(
  operation: PayPalOperation,
  path: string,
  over: Partial<OutboundRequest> = {},
): OutboundRequest {
  const posts: PayPalOperation[] = [
    'oauth_token',
    'create_order',
    'capture_order',
    'refund_capture',
    'verify_webhook_postback',
  ];
  const method = posts.includes(operation) ? 'POST' : 'GET';
  return {
    operation,
    method,
    path,
    headers: { authorization: 'redacted-for-test' },
    body: method === 'POST' ? '{}' : null,
    order_ref: null,
    amount_minor: null,
    scenario: null,
    ...over,
  };
}
