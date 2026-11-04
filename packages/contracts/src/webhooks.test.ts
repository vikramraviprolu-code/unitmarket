// API-C (E1, E2): the webhook contracts. Which owner kind may subscribe to which event, which URLs may be
// stored (no unsafe target waits for the future HTTP sender), the shapes of a subscription and a delivery
// (a view never carries the signing secret), who an event is about, and the four routes in the registry.
import { describe, expect, it } from 'vitest';
import {
  EVENT_TYPES,
  V1_ROUTES,
  WEBHOOK_DELIVERY_STATUSES,
  WEBHOOK_OWNER_EVENTS,
  WebhookDeliveryViewSchema,
  WebhookSubscriptionCreateSchema,
  WebhookSubscriptionCreatedSchema,
  WebhookSubscriptionViewSchema,
  buildOpenApiV1,
  eventAudience,
  isAllowedWebhookUrl,
} from './v1';
import { IdPrefixSchema } from './ports';

const T = '2026-11-04T10:00:00.000Z';
const SECRET = `whsec_${'ab'.repeat(32)}`;
const money = { currency: 'USD', minor: 10 };

describe('who may subscribe to what', () => {
  it('is the matrix of the spec', () => {
    expect(WEBHOOK_OWNER_EVENTS).toEqual({
      buyer: ['order.paid', 'entitlement.granted', 'refund.completed', 'mandate.exhausted'],
      publisher: ['sale.recorded', 'refund.completed'],
      operator: ['settlement.completed'],
    });
  });

  it('gives every event type to someone, and only known event types', () => {
    const all = new Set(Object.values(WEBHOOK_OWNER_EVENTS).flat());
    expect([...all].sort()).toEqual([...EVENT_TYPES].sort());
  });

  it('keeps a sale away from buyers and an order away from sellers', () => {
    expect(WEBHOOK_OWNER_EVENTS.buyer).not.toContain('sale.recorded');
    expect(WEBHOOK_OWNER_EVENTS.buyer).not.toContain('settlement.completed');
    expect(WEBHOOK_OWNER_EVENTS.publisher).not.toContain('order.paid');
    expect(WEBHOOK_OWNER_EVENTS.publisher).not.toContain('entitlement.granted');
    expect(WEBHOOK_OWNER_EVENTS.publisher).not.toContain('mandate.exhausted');
    expect(WEBHOOK_OWNER_EVENTS.operator).not.toContain('order.paid');
  });
});

describe('isAllowedWebhookUrl', () => {
  const ok = [
    'https://hooks.example.com/um',
    'https://hooks.example.com',
    'https://a.b.example.org:8443/path?x=1',
    'HTTPS://Example.COM/x',
    'https://xn--bcher-kva.example/hook',
    'https://bücher.example/hook',
    'https://example.com./hook',
  ];
  const refused = [
    ['http scheme', 'http://hooks.example.com/um'],
    ['ftp scheme', 'ftp://hooks.example.com/um'],
    ['no scheme', 'hooks.example.com/um'],
    ['scheme relative', '//hooks.example.com/um'],
    ['javascript', 'javascript:alert(1)'],
    ['empty', ''],
    ['blank', '   '],
    ['leading space', ' https://hooks.example.com/um'],
    ['trailing space', 'https://hooks.example.com/um '],
    ['space in host', 'https://hooks .example.com/um'],
    ['newline in path', 'https://hooks.example.com/um\nX-Evil: 1'],
    ['tab', 'https://hooks.example.com/\tum'],
    ['IPv4 literal', 'https://127.0.0.1/um'],
    ['IPv4 private', 'https://10.0.0.5/um'],
    ['IPv4 link local metadata', 'https://169.254.169.254/latest/meta-data'],
    ['IPv4 hex form', 'https://0x7f.1/um'],
    ['IPv4 short form', 'https://127.1/um'],
    ['IPv4 decimal form', 'https://2130706433/um'],
    ['IPv4 octal form', 'https://0177.0.0.1/um'],
    ['IPv6 loopback', 'https://[::1]/um'],
    ['IPv6 literal', 'https://[2001:db8::1]/um'],
    ['IPv4 mapped IPv6', 'https://[::ffff:127.0.0.1]/um'],
    ['localhost', 'https://localhost/um'],
    ['LOCALHOST', 'https://LOCALHOST/um'],
    ['localhost dot', 'https://localhost./um'],
    ['sub domain of localhost', 'https://hooks.localhost/um'],
    ['single label host', 'https://internal/um'],
    ['user info', 'https://user:pass@hooks.example.com/um'],
    ['user info trick', 'https://hooks.example.com@evil.example/um'],
    ['bad port', 'https://hooks.example.com:99999/um'],
    ['no host', 'https:///um'],
    ['over 2048 characters', `https://hooks.example.com/${'a'.repeat(2048)}`],
  ] as const;

  it.each(ok)('accepts %s', (url) => {
    expect(isAllowedWebhookUrl(url)).toBe(true);
  });
  it.each(refused)('refuses %s', (_why, url) => {
    expect(isAllowedWebhookUrl(url)).toBe(false);
  });
  it('accepts a URL of exactly 2048 characters and refuses one of 2049', () => {
    const base = 'https://hooks.example.com/';
    expect(isAllowedWebhookUrl(base + 'a'.repeat(2048 - base.length))).toBe(true);
    expect(isAllowedWebhookUrl(base + 'a'.repeat(2049 - base.length))).toBe(false);
  });
  it('never throws, whatever it is given', () => {
    for (const v of [
      '%',
      'https://%',
      'https://[',
      'https://[::1',
      '\u0000',
      'https://a\u0000b.example',
    ]) {
      expect(() => isAllowedWebhookUrl(v)).not.toThrow();
      expect(isAllowedWebhookUrl(v)).toBe(false);
    }
  });
});

describe('subscription shapes', () => {
  const create = { url: 'https://hooks.example.com/um', event_types: ['order.paid'] };

  it('a create request is a url and one or more distinct known event types, nothing else', () => {
    expect(WebhookSubscriptionCreateSchema.safeParse(create).success).toBe(true);
    expect(
      WebhookSubscriptionCreateSchema.safeParse({
        ...create,
        event_types: ['order.paid', 'refund.completed'],
      }).success,
    ).toBe(true);
    const bad: unknown[] = [
      {},
      { url: create.url },
      { event_types: create.event_types },
      { ...create, event_types: [] },
      { ...create, event_types: ['order.paid', 'order.paid'] },
      { ...create, event_types: ['payout.sent'] },
      { ...create, event_types: 'order.paid' },
      { ...create, url: 'http://hooks.example.com/um' },
      { ...create, url: 'https://127.0.0.1/um' },
      { ...create, extra: 1 },
      { ...create, signing_secret: SECRET },
      { ...create, event_types: [...EVENT_TYPES, 'order.paid'] },
    ];
    for (const b of bad) {
      expect(WebhookSubscriptionCreateSchema.safeParse(b).success, JSON.stringify(b)).toBe(false);
    }
  });

  const view = {
    id: 'wsb_1',
    url: 'https://hooks.example.com/um',
    event_types: ['order.paid'],
    created_at: T,
    disabled_at: null,
  };

  it('a view has no secret, and refuses one if it is handed one', () => {
    expect(WebhookSubscriptionViewSchema.safeParse(view).success).toBe(true);
    expect(WebhookSubscriptionViewSchema.safeParse({ ...view, disabled_at: T }).success).toBe(true);
    expect(
      WebhookSubscriptionViewSchema.safeParse({ ...view, signing_secret: SECRET }).success,
    ).toBe(false);
    expect(Object.keys(WebhookSubscriptionViewSchema.shape).sort()).toEqual(
      ['created_at', 'disabled_at', 'event_types', 'id', 'url'].sort(),
    );
  });

  it('the answer to a create is the view and the secret, whsec_ and 64 hex characters', () => {
    expect(
      WebhookSubscriptionCreatedSchema.safeParse({ ...view, signing_secret: SECRET }).success,
    ).toBe(true);
    for (const bad of [
      '',
      'whsec_',
      'whsec_zz',
      SECRET.slice(0, -1),
      `${SECRET}0`,
      'ab'.repeat(32),
    ]) {
      expect(
        WebhookSubscriptionCreatedSchema.safeParse({ ...view, signing_secret: bad }).success,
        bad,
      ).toBe(false);
    }
    expect(WebhookSubscriptionCreatedSchema.safeParse(view).success).toBe(false);
  });
});

describe('delivery shape', () => {
  const row = {
    id: 'wdl_1',
    event_id: 'evt_1',
    event_type: 'order.paid',
    attempt: 2,
    status: 'failed',
    next_at: T,
    last_error: 'http_5xx',
    created_at: T,
    updated_at: T,
  };
  it('lists the four statuses of the spec and nothing else', () => {
    expect([...WEBHOOK_DELIVERY_STATUSES]).toEqual(['pending', 'delivered', 'failed', 'dead']);
  });
  it('accepts a delivery row and refuses a secret, a url, a body or an unknown status', () => {
    expect(WebhookDeliveryViewSchema.safeParse(row).success).toBe(true);
    expect(
      WebhookDeliveryViewSchema.safeParse({
        ...row,
        status: 'delivered',
        next_at: null,
        last_error: null,
      }).success,
    ).toBe(true);
    const bad: unknown[] = [
      { ...row, status: 'sent' },
      { ...row, attempt: -1 },
      { ...row, attempt: 1.5 },
      { ...row, last_error: 'ECONNRESET to https://hooks.example.com' },
      { ...row, signing_secret: SECRET },
      { ...row, body: '{}' },
      { ...row, url: 'https://hooks.example.com/um' },
    ];
    for (const b of bad) {
      expect(WebhookDeliveryViewSchema.safeParse(b).success, JSON.stringify(b)).toBe(false);
    }
  });
});

describe('who an event is about', () => {
  it('reads the owner out of the payload of each type', () => {
    expect(
      eventAudience('order.paid', {
        order_id: 'ord_1',
        buyer_id: 'buy_1',
        total: money,
        paid_at: T,
      }),
    ).toEqual({ buyer_id: 'buy_1', publisher_id: null, order_id: 'ord_1', operators: false });
    expect(
      eventAudience('entitlement.granted', {
        entitlement_id: 'ent_1',
        order_id: 'ord_1',
        buyer_id: 'buy_2',
        unit_id: 'unt_1',
        granted_at: T,
      }),
    ).toEqual({ buyer_id: 'buy_2', publisher_id: null, order_id: 'ord_1', operators: false });
    expect(
      eventAudience('sale.recorded', {
        order_id: 'ord_1',
        unit_id: 'unt_1',
        publisher_id: 'pub_1',
        gross: money,
        recorded_at: T,
      }),
    ).toEqual({ buyer_id: null, publisher_id: 'pub_1', order_id: 'ord_1', operators: false });
    expect(
      eventAudience('refund.completed', {
        refund_id: 'ref_1',
        order_id: 'ord_1',
        unit_id: 'unt_1',
        publisher_id: 'pub_1',
        amount: money,
        completed_at: T,
      }),
    ).toEqual({ buyer_id: null, publisher_id: 'pub_1', order_id: 'ord_1', operators: false });
    expect(
      eventAudience('mandate.exhausted', {
        mandate_id: 'man_1',
        buyer_id: 'buy_3',
        agent_key_id: 'key_1',
        reason: 'money',
        exhausted_at: T,
      }),
    ).toEqual({ buyer_id: 'buy_3', publisher_id: null, order_id: null, operators: false });
    expect(
      eventAudience('settlement.completed', {
        pass_id: 'pas_1',
        checked: 3,
        fixed: 1,
        completed_at: T,
      }),
    ).toEqual({ buyer_id: null, publisher_id: null, order_id: null, operators: true });
  });

  it('is nobody when the payload is not the payload of the type', () => {
    expect(eventAudience('order.paid', { order_id: 'ord_1' })).toEqual({
      buyer_id: null,
      publisher_id: null,
      order_id: null,
      operators: false,
    });
    expect(eventAudience('sale.recorded', null)).toEqual({
      buyer_id: null,
      publisher_id: null,
      order_id: null,
      operators: false,
    });
  });
});

describe('ids and routes', () => {
  it('has id prefixes for subscriptions, deliveries and reconciler passes', () => {
    for (const p of ['wsb', 'wdl', 'pas']) {
      expect(IdPrefixSchema.safeParse(p).success, p).toBe(true);
    }
  });

  it('registers the four routes, bearer key with events:read', () => {
    const find = (m: string, p: string) => V1_ROUTES.find((r) => r.method === m && r.path === p);
    const post = find('POST', '/api/v1/webhook-subscriptions');
    const list = find('GET', '/api/v1/webhook-subscriptions');
    const del = find('DELETE', '/api/v1/webhook-subscriptions/{id}');
    const deliveries = find('GET', '/api/v1/webhook-subscriptions/{id}/deliveries');
    for (const r of [post, list, del, deliveries]) {
      expect(r, 'route registered').toBeDefined();
      expect(r!.auth).toBe('apikey');
      expect(r!.scopes).toEqual(['events:read']);
    }
    expect(post!.success.status).toBe(201);
    expect(post!.input).toMatchObject({ in: 'body' });
    expect(post!.errors).toEqual(expect.arrayContaining([400, 422]));
    expect(del!.errors).toEqual(expect.arrayContaining([404]));
    expect(deliveries!.errors).toEqual(expect.arrayContaining([404]));
  });

  it('shows up in the OpenAPI document, and the list never promises a secret', () => {
    const doc = buildOpenApiV1() as {
      paths: Record<string, Record<string, { responses: Record<string, unknown> }>>;
    };
    expect(Object.keys(doc.paths)).toEqual(
      expect.arrayContaining([
        '/api/v1/webhook-subscriptions',
        '/api/v1/webhook-subscriptions/{id}',
        '/api/v1/webhook-subscriptions/{id}/deliveries',
      ]),
    );
    const listBody = JSON.stringify(
      doc.paths['/api/v1/webhook-subscriptions']!['get']!.responses['200'],
    );
    expect(listBody).not.toContain('signing_secret');
    const createBody = JSON.stringify(
      doc.paths['/api/v1/webhook-subscriptions']!['post']!.responses['201'],
    );
    expect(createBody).toContain('signing_secret');
  });
});
