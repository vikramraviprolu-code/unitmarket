// API-C (E3 to E6) golden: the shape of every event payload. Real events come from the real engine over
// the dry-run model (a purchase writes order.paid, entitlement.granted and sale.recorded; a refund writes
// refund.completed); the rest are fixed samples. Each is checked against the v1 schema and against the
// golden key list below, and none holds an email, a name, an address or a secret. A change to the key
// lists is a change to what sellers and agents are sent.
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  EVENT_PAYLOAD_SCHEMAS,
  EVENT_TYPES,
  EventEnvelopeSchema,
  type EventType,
} from '@umsbx/contracts';
import { bootRefundWorld, buy, postRefund, type RefundWorld } from '../refund-support';

vi.mock('server-only', () => ({}));

const GOLDEN_KEYS: Record<EventType, string[]> = {
  'order.paid': ['buyer_id', 'order_id', 'paid_at', 'total'],
  'entitlement.granted': ['buyer_id', 'entitlement_id', 'granted_at', 'order_id', 'unit_id'],
  'sale.recorded': ['gross', 'order_id', 'publisher_id', 'recorded_at', 'unit_id'],
  'refund.completed': [
    'amount',
    'completed_at',
    'order_id',
    'publisher_id',
    'refund_id',
    'unit_id',
  ],
  'mandate.exhausted': ['agent_key_id', 'buyer_id', 'exhausted_at', 'mandate_id', 'reason'],
  'settlement.completed': ['checked', 'completed_at', 'fixed', 'pass_id'],
};

const FORBIDDEN_KEY = /email|name|address|phone|street|postcode|token|secret|password|iban|card/i;
const EMAIL = /[^\s"]+@[^\s"]+\.[a-z]{2,}/i;

interface Row {
  id: string;
  type: EventType;
  payload: Record<string, unknown>;
  occurred_at: string | Date;
}

const walk = (v: unknown, path: string, out: string[]): string[] => {
  if (v !== null && typeof v === 'object') {
    for (const [k, inner] of Object.entries(v)) {
      out.push(`${path}.${k}`);
      walk(inner, `${path}.${k}`, out);
    }
  }
  return out;
};

let w: RefundWorld;
let real: Row[] = [];
beforeAll(async () => {
  w = await bootRefundWorld();
  const a = await buy(w, { offer: 'knot-notebook', option: 'online_read' });
  await postRefund(w, w.op, {
    unit_id: a.unit_id,
    amount_minor: 100,
    reason: 'Golden partial refund',
  });
  real = (
    await w.app.db.query<Row>('SELECT id, type, payload, occurred_at FROM event_outbox ORDER BY id')
  ).rows;
});
afterAll(async () => {
  await w.app.close();
});

const SAMPLES: Record<EventType, unknown> = {
  'order.paid': {
    order_id: 'ord_0001',
    buyer_id: 'byr_0001',
    total: { currency: 'USD', minor: 450 },
    paid_at: '2026-11-04T10:00:00.000Z',
  },
  'entitlement.granted': {
    entitlement_id: 'ent_0001',
    order_id: 'ord_0001',
    buyer_id: 'byr_0001',
    unit_id: 'unt_0001',
    granted_at: '2026-11-04T10:00:00.000Z',
  },
  'sale.recorded': {
    order_id: 'ord_0001',
    unit_id: 'unt_0001',
    publisher_id: 'pub_0001',
    gross: { currency: 'USD', minor: 450 },
    recorded_at: '2026-11-04T10:00:00.000Z',
  },
  'refund.completed': {
    refund_id: 'rfd_0001',
    order_id: 'ord_0001',
    unit_id: 'unt_0001',
    publisher_id: 'pub_0001',
    amount: { currency: 'USD', minor: 100 },
    completed_at: '2026-11-04T10:00:00.000Z',
  },
  'mandate.exhausted': {
    mandate_id: 'mnd_0001',
    buyer_id: 'byr_0001',
    agent_key_id: 'key_0001',
    reason: 'money',
    exhausted_at: '2026-11-04T10:00:00.000Z',
  },
  'settlement.completed': {
    pass_id: 'pas_0001',
    checked: 3,
    fixed: 1,
    completed_at: '2026-11-04T10:00:00.000Z',
  },
};

describe('sample payloads', () => {
  for (const type of EVENT_TYPES) {
    it(`${type}: the schema accepts the sample and its keys are the golden list`, () => {
      const parsed = EVENT_PAYLOAD_SCHEMAS[type].safeParse(SAMPLES[type]);
      expect(parsed.success).toBe(true);
      expect(Object.keys(SAMPLES[type] as object).sort()).toEqual(GOLDEN_KEYS[type]);
    });
  }
});

describe('real events from the engine', () => {
  it('a purchase and a refund wrote all four buyer and seller events', () => {
    expect(new Set(real.map((r) => r.type))).toEqual(
      new Set(['order.paid', 'entitlement.granted', 'sale.recorded', 'refund.completed']),
    );
  });

  it('each payload matches its schema and the golden key list, wrapped in the envelope', () => {
    expect(real.length).toBeGreaterThanOrEqual(4);
    for (const r of real) {
      expect(Object.keys(r.payload).sort(), r.type).toEqual(GOLDEN_KEYS[r.type]);
      const env = EventEnvelopeSchema.safeParse({
        id: r.id,
        type: r.type,
        payload: r.payload,
        occurred_at: new Date(r.occurred_at).toISOString(),
      });
      expect(env.success, r.type).toBe(true);
    }
  });

  it('the ids in one purchase agree across its events', () => {
    const by = (t: EventType) => real.find((r) => r.type === t)!.payload;
    const paid = by('order.paid');
    const ent = by('entitlement.granted');
    const sale = by('sale.recorded');
    const refund = by('refund.completed');
    expect(ent['order_id']).toBe(paid['order_id']);
    expect(sale['order_id']).toBe(paid['order_id']);
    expect(refund['order_id']).toBe(paid['order_id']);
    expect(ent['buyer_id']).toBe(paid['buyer_id']);
    expect(ent['unit_id']).toBe(sale['unit_id']);
    expect(refund['unit_id']).toBe(sale['unit_id']);
    expect(refund['publisher_id']).toBe(sale['publisher_id']);
  });

  it('money is a currency and whole minor units: the refund is 100 of the sale', () => {
    const sale = real.find((r) => r.type === 'sale.recorded')!.payload['gross'] as {
      currency: string;
      minor: number;
    };
    const refund = real.find((r) => r.type === 'refund.completed')!.payload['amount'] as {
      currency: string;
      minor: number;
    };
    expect(sale.currency).toBe(refund.currency);
    expect(Number.isInteger(sale.minor)).toBe(true);
    expect(refund.minor).toBe(100);
    expect(refund.minor).toBeLessThan(sale.minor);
  });
});

describe('no personal data', () => {
  it('no key in any real or sample payload names an email, a person, an address, a card or a secret', () => {
    const payloads = [...real.map((r) => r.payload), ...Object.values(SAMPLES)];
    for (const p of payloads) {
      for (const path of walk(p, 'payload', [])) {
        expect(path.split('.').pop()!, path).not.toMatch(FORBIDDEN_KEY);
      }
    }
  });

  it('no value looks like an email address or a secret', () => {
    for (const p of [...real.map((r) => r.payload), ...Object.values(SAMPLES)]) {
      const text = JSON.stringify(p);
      expect(text).not.toMatch(EMAIL);
      expect(text).not.toContain('whsec_');
      expect(text).not.toContain('umk_');
    }
  });

  it('the schemas are strict: an extra field is refused', () => {
    for (const type of EVENT_TYPES) {
      const extra = { ...(SAMPLES[type] as object), email: 'a@b.example' };
      expect(EVENT_PAYLOAD_SCHEMAS[type].safeParse(extra).success, type).toBe(false);
    }
  });
});
