// API-C (E1, E2): the webhook subscription routes, through the real route modules on a booted app, with a
// bearer key (scope events:read). POST makes a subscription and shows the signing secret once; GET lists
// your own and never shows a secret; DELETE disables one (the row stays, so its deliveries stay readable);
// GET .../deliveries shows each delivery with its attempt, status and next_at. Delivery runs in-process:
// the sink records what would have been sent. Attacks are in events.adversarial.test.ts.
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { issueKey } from '@umsbx/security';
import type { Actor, EventType, Scope } from '@umsbx/contracts';
import { bootPackApp, buyer } from '../../../../composite-support';
import { ORIGIN } from '../../../../support';
import { expectOffline } from '../../../../api-v1/offline-guard';
import { apiKeyDeps, createApiV1, type App } from '../../../../../composition.server';

vi.mock('server-only', () => ({}));
vi.mock('node:net', async (orig) =>
  (await import('../../../../api-v1/offline-guard')).netMock(await orig()),
);
vi.mock('node:dns', async (orig) =>
  (await import('../../../../api-v1/offline-guard')).dnsMock(await orig()),
);
expectOffline();

type Handler = (req: Request, call?: { params?: Record<string, string> }) => Promise<Response>;
let app: App;
let collection: { POST: Handler; GET: Handler };
let one: { DELETE: Handler };
let deliveriesRoute: { GET: Handler };
let buyerA: Actor;
let buyerB: Actor;
let harbour: Actor;
let tokens: { buyerA: string; buyerB: string; harbour: string };
let counter = 0;

const issue = async (owner: Actor, scopes: readonly Scope[]): Promise<string> => {
  const r = await issueKey(apiKeyDeps(app), { owner, key_kind: 'api_client', scopes });
  if (!r.ok) throw new Error(`issue refused: ${r.error}`);
  return r.value.token;
};

beforeAll(async () => {
  app = await bootPackApp();
  collection = (await import('./route')) as unknown as typeof collection;
  one = (await import('./[id]/route')) as unknown as typeof one;
  deliveriesRoute = (await import('./[id]/deliveries/route')) as unknown as typeof deliveriesRoute;
  buyerA = await buyer(app, 'a');
  buyerB = await buyer(app, 'b');
  harbour = {
    kind: 'publisher',
    publisher_id: (
      await app.db.query<{ id: string }>('SELECT id FROM publishers WHERE slug = $1', [
        'harbour-ledger',
      ])
    ).rows[0]!.id,
  };
  tokens = {
    buyerA: await issue(buyerA, ['events:read']),
    buyerB: await issue(buyerB, ['events:read']),
    harbour: await issue(harbour, ['events:read']),
  };
});

const headers = (
  token: string | null,
  extra: Record<string, string> = {},
): Record<string, string> => ({
  ...(token === null ? {} : { authorization: `Bearer ${token}` }),
  ...extra,
});
const post = (
  token: string | null,
  body: unknown,
  idem: string | null = `sub-${String(++counter)}-abcdefgh`,
) =>
  collection.POST(
    new Request(`${ORIGIN}/api/v1/webhook-subscriptions`, {
      method: 'POST',
      headers: headers(token, {
        'content-type': 'application/json',
        ...(idem === null ? {} : { 'idempotency-key': idem }),
      }),
      body: JSON.stringify(body),
    }),
  );
const list = (token: string | null) =>
  collection.GET(
    new Request(`${ORIGIN}/api/v1/webhook-subscriptions`, { headers: headers(token) }),
  );
const del = (token: string | null, id: string) =>
  one.DELETE(
    new Request(`${ORIGIN}/api/v1/webhook-subscriptions/${id}`, {
      method: 'DELETE',
      headers: headers(token, { 'idempotency-key': `del-${String(++counter)}-abcdefgh` }),
    }),
    { params: { id } },
  );
const deliveries = (token: string | null, id: string) =>
  deliveriesRoute.GET(
    new Request(`${ORIGIN}/api/v1/webhook-subscriptions/${id}/deliveries`, {
      headers: headers(token),
    }),
    { params: { id } },
  );
interface Json {
  id: string;
  url: string;
  event_types: string[];
  created_at: string;
  disabled_at: string | null;
  signing_secret?: string;
  items: Record<string, unknown>[];
  next_cursor: string | null;
  error: { code: string };
  [k: string]: unknown;
}
const json = async (r: Response) => (await r.json()) as Json;
const URL_OK = 'https://hooks.example.com/um';

const append = async (type: EventType, payload: unknown): Promise<string> =>
  app.db.transaction((tx) => createApiV1(app).events.append(tx, { type, payload }));
const PAID = (buyer_id: string, order_id = `ord_${String(++counter)}`) => ({
  order_id,
  buyer_id,
  total: { currency: 'USD', minor: 100 },
  paid_at: app.security.clock.now().toISOString(),
});
const buyerId = (a: Actor): string => (a.kind === 'buyer' ? a.buyer_id : '');
const sink = () => app.webhook_sink;

describe('create', () => {
  it('201: the subscription and its signing secret, once', async () => {
    const res = await post(tokens.buyerA, {
      url: URL_OK,
      event_types: ['order.paid', 'refund.completed'],
    });
    expect(res.status).toBe(201);
    const b = await json(res);
    expect(Object.keys(b).sort()).toEqual(
      ['created_at', 'disabled_at', 'event_types', 'id', 'signing_secret', 'url'].sort(),
    );
    expect(b.id).toMatch(/^wsb_[0-9a-z]{26}$/);
    expect(b.url).toBe(URL_OK);
    expect(b.event_types).toEqual(['order.paid', 'refund.completed']);
    expect(b.disabled_at).toBeNull();
    expect(new Date(b.created_at).toISOString()).toBe(b.created_at);
    expect(b.signing_secret).toMatch(/^whsec_[0-9a-f]{64}$/);
  });

  it('stores the secret as is (it is needed to sign), and no two subscriptions share one', async () => {
    const a = await json(await post(tokens.buyerA, { url: URL_OK, event_types: ['order.paid'] }));
    const b = await json(await post(tokens.buyerA, { url: URL_OK, event_types: ['order.paid'] }));
    expect(a.signing_secret).not.toBe(b.signing_secret);
    const rows = await app.db.query<{
      id: string;
      signing_secret: string;
      owner_kind: string;
      owner_id: string;
    }>(
      'SELECT id, signing_secret, owner_kind, owner_id FROM webhook_subscriptions WHERE id = ANY($1::text[]) ORDER BY id',
      [[a.id, b.id]],
    );
    const bySecret = new Map(rows.rows.map((r) => [r.id, r.signing_secret]));
    expect(bySecret.get(a.id)).toBe(a.signing_secret);
    expect(bySecret.get(b.id)).toBe(b.signing_secret);
    expect(rows.rows.every((r) => r.owner_kind === 'buyer' && r.owner_id === buyerId(buyerA))).toBe(
      true,
    );
  });

  it('a seller makes a subscription for sales and refunds', async () => {
    const res = await post(tokens.harbour, {
      url: URL_OK,
      event_types: ['sale.recorded', 'refund.completed'],
    });
    expect(res.status).toBe(201);
    const row = await app.db.query<{ owner_kind: string; owner_id: string }>(
      'SELECT owner_kind, owner_id FROM webhook_subscriptions WHERE id = $1',
      [(await json(res)).id],
    );
    expect(row.rows[0]).toEqual({
      owner_kind: 'publisher',
      owner_id: harbour.kind === 'publisher' ? harbour.publisher_id : '',
    });
  });

  it('a repeat with the same Idempotency-Key and body answers the same subscription, without the secret, and adds no row', async () => {
    const before = await app.db.query<{ n: string }>(
      'SELECT count(*)::text AS n FROM webhook_subscriptions',
    );
    const key = `repeat-${String(++counter)}-abcdefgh`;
    const body = { url: URL_OK, event_types: ['entitlement.granted'] };
    const first = await json(await post(tokens.buyerA, body, key));
    const again = await post(tokens.buyerA, body, key);
    expect(again.status).toBe(201);
    const second = await json(again);
    expect(second.id).toBe(first.id);
    expect(second.signing_secret).toBeUndefined();
    expect(JSON.stringify(second)).not.toContain('whsec_');
    const after = await app.db.query<{ n: string }>(
      'SELECT count(*)::text AS n FROM webhook_subscriptions',
    );
    expect(Number(after.rows[0]!.n)).toBe(Number(before.rows[0]!.n) + 1);
    // another body under the same key is a conflict
    expect((await post(tokens.buyerA, { ...body, event_types: ['order.paid'] }, key)).status).toBe(
      409,
    );
  });

  it('refuses a bad body with 422 and writes nothing', async () => {
    const before = await app.db.query<{ n: string }>(
      'SELECT count(*)::text AS n FROM webhook_subscriptions',
    );
    for (const body of [
      {},
      { url: URL_OK },
      { event_types: ['order.paid'] },
      { url: URL_OK, event_types: [] },
      { url: URL_OK, event_types: ['order.paid', 'order.paid'] },
      { url: URL_OK, event_types: ['payout.sent'] },
      { url: URL_OK, event_types: ['order.paid'], signing_secret: `whsec_${'a'.repeat(64)}` },
      { url: URL_OK, event_types: ['order.paid'], extra: true },
      { url: 5, event_types: ['order.paid'] },
    ]) {
      const res = await post(tokens.buyerA, body);
      expect(res.status, JSON.stringify(body)).toBe(422);
      expect((await json(res)).error.code).toBe('invalid_input');
    }
    const after = await app.db.query<{ n: string }>(
      'SELECT count(*)::text AS n FROM webhook_subscriptions',
    );
    expect(after.rows[0]!.n).toBe(before.rows[0]!.n);
  });

  it('needs a bearer key with events:read, and an Idempotency-Key', async () => {
    const body = { url: URL_OK, event_types: ['order.paid'] };
    expect((await post(null, body)).status).toBe(401);
    const noScope = await issue(buyerA, ['catalogue:read']);
    expect((await post(noScope, body)).status).toBe(403);
    expect((await post(tokens.buyerA, body, null)).status).toBe(400);
  });
});

describe('list', () => {
  it('lists your own subscriptions, newest first, and never shows a secret', async () => {
    const mine = await json(
      await post(tokens.buyerB, { url: URL_OK, event_types: ['order.paid'] }),
    );
    const res = await list(tokens.buyerB);
    expect(res.status).toBe(200);
    const text = await res.clone().text();
    expect(text).not.toContain('whsec_');
    expect(text).not.toContain('signing_secret');
    const b = await json(res);
    expect(b.next_cursor).toBeNull();
    expect(b.items.map((i) => i['id'])).toContain(mine.id);
    for (const item of b.items) {
      expect(Object.keys(item).sort()).toEqual([
        'created_at',
        'disabled_at',
        'event_types',
        'id',
        'url',
      ]);
    }
    const created = b.items.map((i) => String(i['created_at']));
    expect(created).toEqual([...created].sort().reverse());
  });

  it('shows only your own: a seller sees no buyer subscription and the other way round', async () => {
    const sellers = await json(await list(tokens.harbour));
    const buyers = await json(await list(tokens.buyerA));
    const sellerIds = new Set(sellers.items.map((i) => i['id']));
    for (const item of buyers.items) expect(sellerIds.has(item['id'])).toBe(false);
    for (const item of sellers.items) {
      expect(
        (item['event_types'] as string[]).every((t) =>
          ['sale.recorded', 'refund.completed'].includes(t),
        ),
      ).toBe(true);
    }
  });

  it('shows a disabled subscription with its disabled_at', async () => {
    const s = await json(await post(tokens.buyerB, { url: URL_OK, event_types: ['order.paid'] }));
    await del(tokens.buyerB, s.id);
    const found = (await json(await list(tokens.buyerB))).items.find((i) => i['id'] === s.id);
    expect(found).toBeDefined();
    expect(typeof found!['disabled_at']).toBe('string');
  });

  it('needs a bearer key with events:read', async () => {
    expect((await list(null)).status).toBe(401);
    expect((await list(await issue(buyerA, ['orders:read']))).status).toBe(403);
  });
});

describe('delete', () => {
  it('disables the subscription: 200 with disabled_at, the row stays', async () => {
    const s = await json(await post(tokens.buyerA, { url: URL_OK, event_types: ['order.paid'] }));
    const res = await del(tokens.buyerA, s.id);
    expect(res.status).toBe(200);
    const b = await json(res);
    expect(b.id).toBe(s.id);
    expect(typeof b.disabled_at).toBe('string');
    expect(b.signing_secret).toBeUndefined();
    const row = await app.db.query<{ disabled_at: Date | null }>(
      'SELECT disabled_at FROM webhook_subscriptions WHERE id = $1',
      [s.id],
    );
    expect(row.rows).toHaveLength(1);
    expect(new Date(row.rows[0]!.disabled_at as Date).toISOString()).toBe(b.disabled_at);
  });

  it('deleting twice is still 200 and keeps the first time', async () => {
    const s = await json(await post(tokens.buyerA, { url: URL_OK, event_types: ['order.paid'] }));
    const first = await json(await del(tokens.buyerA, s.id));
    const second = await del(tokens.buyerA, s.id);
    expect(second.status).toBe(200);
    expect((await json(second)).disabled_at).toBe(first.disabled_at);
  });

  it('a disabled subscription gets no event that happens afterwards', async () => {
    const s = await json(await post(tokens.buyerA, { url: URL_OK, event_types: ['order.paid'] }));
    await del(tokens.buyerA, s.id);
    sink().clear();
    await append('order.paid', PAID(buyerId(buyerA)));
    await app.deliverWebhooks({ max_items: 100 });
    expect(sink().records.filter((r) => r.url === URL_OK && r.body.includes(s.id))).toEqual([]);
    const d = await json(await deliveries(tokens.buyerA, s.id));
    expect(d.items).toEqual([]);
  });

  it('an unknown id is 404', async () => {
    const res = await del(tokens.buyerA, 'wsb_00000000000000000000000000');
    expect(res.status).toBe(404);
    expect((await json(res)).error.code).toBe('not_found');
  });
});

describe('deliveries', () => {
  it('lists each delivery with its attempt, status, next_at and error code', async () => {
    const s = await json(
      await post(tokens.buyerA, {
        url: 'https://hooks.example.com/ok',
        event_types: ['order.paid'],
      }),
    );
    sink().clear();
    const evt = await append('order.paid', PAID(buyerId(buyerA)));
    await app.deliverWebhooks({ max_items: 100 });
    const res = await deliveries(tokens.buyerA, s.id);
    expect(res.status).toBe(200);
    const b = await json(res);
    expect(b.next_cursor).toBeNull();
    expect(b.items).toHaveLength(1);
    expect(Object.keys(b.items[0]!).sort()).toEqual(
      [
        'attempt',
        'created_at',
        'event_id',
        'event_type',
        'id',
        'last_error',
        'next_at',
        'status',
        'updated_at',
      ].sort(),
    );
    expect(b.items[0]).toMatchObject({
      event_id: evt,
      event_type: 'order.paid',
      attempt: 1,
      status: 'delivered',
      next_at: null,
      last_error: null,
    });
    expect(JSON.stringify(b)).not.toContain('whsec_');
  });

  it('shows a failed try with its next time and a code, never the receiver’s answer', async () => {
    const s = await json(
      await post(tokens.buyerA, {
        url: 'https://hooks.example.com/slow',
        event_types: ['order.paid'],
      }),
    );
    sink().clear();
    // other subscriptions of this buyer get the same event, and the pass sends in no fixed order among
    // them: every send fails, so this subscription's does too
    sink().script(
      ...Array.from({ length: 50 }, () => ({ ok: false as const, error: 'http_5xx' as const })),
    );
    const before = app.security.clock.now().getTime();
    await append('order.paid', PAID(buyerId(buyerA)));
    await app.deliverWebhooks({ max_items: 100 });
    const only = (await json(await deliveries(tokens.buyerA, s.id))).items[0]!;
    expect(only).toMatchObject({ attempt: 1, status: 'failed', last_error: 'http_5xx' });
    const next = Date.parse(String(only['next_at']));
    expect(next).toBeGreaterThanOrEqual(before + 60_000);
    expect(next).toBeLessThan(app.security.clock.now().getTime() + 60_000 + 5_000);
  });

  it('shows only the deliveries of that subscription', async () => {
    const one1 = await json(
      await post(tokens.buyerA, {
        url: 'https://hooks.example.com/one',
        event_types: ['order.paid'],
      }),
    );
    const two = await json(
      await post(tokens.buyerA, {
        url: 'https://hooks.example.com/two',
        event_types: ['entitlement.granted'],
      }),
    );
    await append('order.paid', PAID(buyerId(buyerA)));
    await app.deliverWebhooks({ max_items: 100 });
    expect((await json(await deliveries(tokens.buyerA, one1.id))).items).toHaveLength(1);
    expect((await json(await deliveries(tokens.buyerA, two.id))).items).toHaveLength(0);
  });

  it('a seller sees its own sale delivered, signed, to the sink', async () => {
    const s = await json(
      await post(tokens.harbour, {
        url: 'https://seller.example.com/hook',
        event_types: ['sale.recorded'],
      }),
    );
    sink().clear();
    await append('sale.recorded', {
      order_id: 'ord_seller_1',
      unit_id: 'unt_seller_1',
      publisher_id: harbour.kind === 'publisher' ? harbour.publisher_id : '',
      gross: { currency: 'USD', minor: 40 },
      recorded_at: app.security.clock.now().toISOString(),
    });
    await app.deliverWebhooks({ max_items: 100 });
    const got = sink().records.filter((r) => r.url === 'https://seller.example.com/hook');
    expect(got).toHaveLength(1);
    expect(got[0]!.headers['UnitMarket-Signature']).toMatch(/^t=\d+,v1=[0-9a-f]{64}$/);
    expect((await json(await deliveries(tokens.harbour, s.id))).items[0]).toMatchObject({
      status: 'delivered',
    });
  });
});
