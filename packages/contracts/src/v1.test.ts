// API-W0 (F1): /api/v1 contracts, event payloads and the OpenAPI document built from them.
import { describe, expect, it } from 'vitest';
import {
  ApiKeyIssueRequestSchema,
  ApiKeyIssuedSchema,
  ApiKeyViewSchema,
  ErrorEnvelopeSchema,
  EVENT_PAYLOAD_SCHEMAS,
  EVENT_TYPES,
  EventEnvelopeSchema,
  EventTypeSchema,
  V1_ROUTES,
  buildOpenApiV1,
  pageOf,
} from './v1';
import { IdSchema } from './primitives';
import { IdPrefixSchema } from './ports';

const T = '2026-11-04T10:00:00.000Z';
const money = { currency: 'USD', minor: 10 };

const SAMPLES: Record<string, unknown> = {
  'order.paid': { order_id: 'ord_1', buyer_id: 'buy_1', total: money, paid_at: T },
  'entitlement.granted': {
    entitlement_id: 'ent_1',
    order_id: 'ord_1',
    buyer_id: 'buy_1',
    unit_id: 'unt_1',
    granted_at: T,
  },
  'sale.recorded': {
    order_id: 'ord_1',
    unit_id: 'unt_1',
    publisher_id: 'pub_1',
    gross: money,
    recorded_at: T,
  },
  'refund.completed': {
    refund_id: 'rfr_1',
    order_id: 'ord_1',
    unit_id: 'unt_1',
    publisher_id: 'pub_1',
    amount: money,
    completed_at: T,
  },
  'mandate.exhausted': {
    mandate_id: 'man_1',
    buyer_id: 'buy_1',
    agent_key_id: 'key_1',
    reason: 'count',
    exhausted_at: T,
  },
  'settlement.completed': { pass_id: 'pass_1', checked: 12, fixed: 1, completed_at: T },
};

describe('event types and payloads', () => {
  it('has exactly the six MVP 1 events', () => {
    expect([...EVENT_TYPES].sort()).toEqual(
      [
        'entitlement.granted',
        'mandate.exhausted',
        'order.paid',
        'refund.completed',
        'sale.recorded',
        'settlement.completed',
      ].sort(),
    );
    expect(EventTypeSchema.safeParse('payout.sent').success).toBe(false);
    expect(EventTypeSchema.safeParse('ledger.settled').success).toBe(false);
  });

  it('every type has a strict payload schema that accepts its sample', () => {
    for (const t of EVENT_TYPES) {
      const schema = EVENT_PAYLOAD_SCHEMAS[t];
      expect(schema.safeParse(SAMPLES[t]).success, t).toBe(true);
      expect(
        schema.safeParse({ ...(SAMPLES[t] as object), email: 'a@example.test' }).success,
        `${t} extra`,
      ).toBe(false);
      expect(schema.safeParse({}).success, `${t} empty`).toBe(false);
    }
  });

  it('payloads hold ids, amounts and times only: no field name suggests personal data or a secret', () => {
    const banned = /email|name|address|phone|secret|token|password|username/i;
    for (const t of EVENT_TYPES) {
      for (const key of Object.keys(SAMPLES[t] as object))
        expect(key, `${t}.${key}`).not.toMatch(banned);
    }
  });

  it('money is an integer of minor units and a three-letter currency', () => {
    const p = EVENT_PAYLOAD_SCHEMAS['order.paid'];
    const base = SAMPLES['order.paid'] as Record<string, unknown>;
    expect(p.safeParse({ ...base, total: { currency: 'USD', minor: 0.5 } }).success).toBe(false);
    expect(p.safeParse({ ...base, total: { currency: 'USD', minor: -1 } }).success).toBe(false);
    expect(p.safeParse({ ...base, total: { currency: 'usd', minor: 1 } }).success).toBe(false);
  });

  it('settlement.completed is a reconciler pass over captured PayPal orders, with counts only', () => {
    const p = EVENT_PAYLOAD_SCHEMAS['settlement.completed'];
    expect(p.safeParse({ pass_id: 'pass_1', checked: -1, fixed: 0, completed_at: T }).success).toBe(
      false,
    );
    expect(
      p.safeParse({ pass_id: 'pass_1', checked: 1.5, fixed: 0, completed_at: T }).success,
    ).toBe(false);
    // never a ledger settlement: no amount or ledger field is accepted
    expect(
      p.safeParse({ ...(SAMPLES['settlement.completed'] as object), ledger_entry_id: 'led_1' })
        .success,
    ).toBe(false);
    expect(
      p.safeParse({ ...(SAMPLES['settlement.completed'] as object), net: money }).success,
    ).toBe(false);
  });

  it('mandate.exhausted names which cap ended the mandate', () => {
    const p = EVENT_PAYLOAD_SCHEMAS['mandate.exhausted'];
    const base = SAMPLES['mandate.exhausted'] as Record<string, unknown>;
    for (const reason of ['money', 'count'])
      expect(p.safeParse({ ...base, reason }).success).toBe(true);
    expect(p.safeParse({ ...base, reason: 'whim' }).success).toBe(false);
  });

  it('the envelope pairs a type with its own payload and refuses a mismatch', () => {
    const ok = {
      id: 'evt_1',
      type: 'order.paid',
      payload: SAMPLES['order.paid'],
      occurred_at: T,
    };
    expect(EventEnvelopeSchema.safeParse(ok).success).toBe(true);
    expect(EventEnvelopeSchema.safeParse({ ...ok, type: 'refund.completed' }).success).toBe(false);
    expect(EventEnvelopeSchema.safeParse({ ...ok, extra: 1 }).success).toBe(false);
    expect(EventEnvelopeSchema.safeParse({ ...ok, occurred_at: '2026-11-04 10:00' }).success).toBe(
      false,
    );
  });

  it('ids for events and keys use the new id prefixes', () => {
    expect(IdPrefixSchema.safeParse('evt').success).toBe(true);
    expect(IdPrefixSchema.safeParse('key').success).toBe(true);
    expect(IdPrefixSchema.safeParse('ord').success).toBe(true);
  });
});

describe('pagination and errors', () => {
  it('pageOf builds { items, next_cursor } and is strict', () => {
    const page = pageOf(IdSchema);
    expect(page.safeParse({ items: ['a', 'b'], next_cursor: null }).success).toBe(true);
    expect(page.safeParse({ items: [], next_cursor: 'abc' }).success).toBe(true);
    expect(page.safeParse({ items: ['a'] }).success).toBe(false);
    expect(page.safeParse({ items: [''], next_cursor: null }).success).toBe(false);
    expect(page.safeParse({ items: ['a'], next_cursor: null, total: 1 }).success).toBe(false);
  });

  it('the error envelope is the existing { error: { code, message, support_code, fields? } }', () => {
    expect(
      ErrorEnvelopeSchema.safeParse({
        error: { code: 'x', message: 'm', support_code: 'E-12345678' },
      }).success,
    ).toBe(true);
    expect(
      ErrorEnvelopeSchema.safeParse({
        error: { code: 'x', message: 'm', support_code: 'E-1', fields: ['a'] },
      }).success,
    ).toBe(true);
    expect(ErrorEnvelopeSchema.safeParse({ error: { code: 'x' } }).success).toBe(false);
    expect(ErrorEnvelopeSchema.safeParse({ code: 'x', message: 'm' }).success).toBe(false);
  });
});

describe('api key contracts', () => {
  it('an issue request names a key kind and one to ten distinct known scopes, nothing else', () => {
    const ok = { key_kind: 'agent', scopes: ['catalogue:read', 'agent:buy'] };
    expect(ApiKeyIssueRequestSchema.safeParse(ok).success).toBe(true);
    expect(ApiKeyIssueRequestSchema.safeParse({ ...ok, scopes: [] }).success).toBe(false);
    expect(ApiKeyIssueRequestSchema.safeParse({ ...ok, scopes: ['ops:write'] }).success).toBe(
      false,
    );
    expect(
      ApiKeyIssueRequestSchema.safeParse({ ...ok, scopes: ['agent:buy', 'agent:buy'] }).success,
    ).toBe(false);
    expect(ApiKeyIssueRequestSchema.safeParse({ ...ok, key_kind: 'root' }).success).toBe(false);
    expect(ApiKeyIssueRequestSchema.safeParse({ ...ok, owner_id: 'buy_2' }).success).toBe(false);
    expect(ApiKeyIssueRequestSchema.safeParse({ ...ok, agent_buyer_id: 'buy_2' }).success).toBe(
      false,
    );
  });

  it('the view never carries a hash or a secret; only the one-time issue answer carries the token', () => {
    const view = {
      id: 'key_1',
      key_kind: 'agent',
      owner_kind: 'buyer',
      scopes: ['agent:buy'],
      created_at: T,
      revoked_at: null,
      last_used_at: null,
    };
    expect(ApiKeyViewSchema.safeParse(view).success).toBe(true);
    expect(ApiKeyViewSchema.safeParse({ ...view, secret_hash: 'a'.repeat(64) }).success).toBe(
      false,
    );
    expect(ApiKeyViewSchema.safeParse({ ...view, token: 'umk_x' }).success).toBe(false);
    expect(ApiKeyIssuedSchema.safeParse({ ...view, token: 'umk_x' }).success).toBe(true);
    expect(ApiKeyIssuedSchema.safeParse(view).success).toBe(false);
  });
});

describe('OpenAPI 3.1 document', () => {
  const doc = buildOpenApiV1() as {
    openapi: string;
    info: { title: string; version: string };
    paths: Record<
      string,
      Record<string, { security?: unknown[]; responses: Record<string, unknown> }>
    >;
    components: { securitySchemes: Record<string, unknown> };
  };

  it('is OpenAPI 3.1 with a title, a version and both security schemes', () => {
    expect(doc.openapi).toBe('3.1.0');
    expect(doc.info.title.length).toBeGreaterThan(0);
    expect(doc.info.version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(Object.keys(doc.components.securitySchemes).sort()).toEqual([
      'bearerKey',
      'sessionCookie',
    ]);
  });

  it('has one path item per registered route and one operation per method', () => {
    const fromRegistry = new Set(V1_ROUTES.map((r) => `${r.method.toLowerCase()} ${r.path}`));
    const fromDoc = new Set<string>();
    for (const [p, ops] of Object.entries(doc.paths))
      for (const m of Object.keys(ops)) fromDoc.add(`${m} ${p}`);
    expect(fromDoc).toEqual(fromRegistry);
    expect(fromDoc.has('post /api/v1/api-keys')).toBe(true);
    expect(fromDoc.has('get /api/v1/api-keys')).toBe(true);
    expect(fromDoc.has('delete /api/v1/api-keys/{id}')).toBe(true);
  });

  it('every path lives under /api/v1 and no operation uses a bearer key for the api-keys routes', () => {
    for (const p of Object.keys(doc.paths)) expect(p.startsWith('/api/v1/')).toBe(true);
    for (const m of ['post', 'get'])
      expect(JSON.stringify(doc.paths['/api/v1/api-keys']![m]!.security)).not.toContain(
        'bearerKey',
      );
  });

  it('every operation documents the error envelope for 401 or 403 and states Idempotency-Key on non-GET', () => {
    for (const r of V1_ROUTES) {
      const op = doc.paths[r.path]![r.method.toLowerCase()]! as {
        responses: Record<string, unknown>;
        parameters?: { name: string }[];
      };
      expect(
        Object.keys(op.responses).some((c) => c === '401' || c === '403'),
        r.path,
      ).toBe(true);
      const hasIdem = (op.parameters ?? []).some((p) => p.name === 'Idempotency-Key');
      expect(hasIdem, `${r.method} ${r.path}`).toBe(r.method !== 'GET');
    }
  });

  it('names no host, no live address and no credential value', () => {
    const text = JSON.stringify(doc);
    expect(text).not.toMatch(/https?:\/\//);
    // Allowed (API-A): the path of the inbound webhook, and the Engine's own field and switch names
    // paypal_fee_minor and paypal_outbound. INT-TR1 adds the journal actor kind "paypal" (an enum member of
    // the timeline entry, which UI0's TimelineActorKind mirrors). No host, no value.
    expect(
      text
        .replaceAll('/api/webhooks/paypal', '')
        .replaceAll('"paypal"', '')
        .replace(/paypal_(fee_minor|outbound)/g, ''),
    ).not.toMatch(/paypal/i);
    expect(text).not.toMatch(/umk_[0-9a-z]{26}_/);
  });

  it('is deterministic: two builds are byte-identical', () => {
    expect(JSON.stringify(buildOpenApiV1())).toBe(JSON.stringify(buildOpenApiV1()));
  });
});
