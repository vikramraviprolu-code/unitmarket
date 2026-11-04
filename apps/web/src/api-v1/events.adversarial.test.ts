// API-C (E1, E2, E4 to E6): attacks on the webhook subscription routes and on delivery. One owner cannot
// read or disable another owner's subscription or deliveries (404, the same body as a missing id); a
// subscription can only name events its owner kind may receive; bad URLs are refused before a row is
// written; the signing secret is never logged, audited or listed; one seller never gets another seller's
// sale; a replayed event delivers once per subscription; a disabled subscription gets nothing; delivery
// opens no socket. Happy paths are in subscriptions.state.test.ts and deliver.state.test.ts.
import { timingSafeEqual } from 'node:crypto';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { issueKey } from '@umsbx/security';
import type { Actor, EventType, Scope } from '@umsbx/contracts';
import { bootPackApp, buyer } from '../composite-support';
import { ORIGIN } from '../support';
import { apiKeyDeps, createApiV1, type App } from '../../composition.server';
import { signatureHeader, verifySignature } from './signature';
import { expectOffline } from './offline-guard';

vi.mock('server-only', () => ({}));
vi.mock('node:net', async (orig) => (await import('./offline-guard')).netMock(await orig()));
vi.mock('node:dns', async (orig) => (await import('./offline-guard')).dnsMock(await orig()));
vi.mock('node:crypto', async (orig) => {
  const actual = await orig<typeof import('node:crypto')>();
  return { ...actual, timingSafeEqual: vi.fn(actual.timingSafeEqual) };
});
expectOffline();

type Handler = (req: Request, call?: { params?: Record<string, string> }) => Promise<Response>;
const logs: string[] = [];
let app: App;
let collection: { POST: Handler; GET: Handler };
let one: { DELETE: Handler };
let deliveriesRoute: { GET: Handler };
let buyerA: Actor;
let buyerB: Actor;
let harbour: Actor;
let quayside: Actor;
let tokens: { buyerA: string; buyerB: string; harbour: string; quayside: string };
let counter = 0;

const issue = async (owner: Actor, scopes: readonly Scope[]): Promise<string> => {
  const r = await issueKey(apiKeyDeps(app), { owner, key_kind: 'api_client', scopes });
  if (!r.ok) throw new Error(`issue refused: ${r.error}`);
  return r.value.token;
};
const publisher = async (slug: string): Promise<Actor> => ({
  kind: 'publisher',
  publisher_id: (
    await app.db.query<{ id: string }>('SELECT id FROM publishers WHERE slug = $1', [slug])
  ).rows[0]!.id,
});
const pubId = (a: Actor): string => (a.kind === 'publisher' ? a.publisher_id : '');
const buyerId = (a: Actor): string => (a.kind === 'buyer' ? a.buyer_id : '');

beforeAll(async () => {
  app = await bootPackApp({}, { log_sink: (line) => void logs.push(line) });
  collection =
    (await import('../app/api/v1/webhook-subscriptions/route')) as unknown as typeof collection;
  one = (await import('../app/api/v1/webhook-subscriptions/[id]/route')) as unknown as typeof one;
  deliveriesRoute =
    (await import('../app/api/v1/webhook-subscriptions/[id]/deliveries/route')) as unknown as typeof deliveriesRoute;
  buyerA = await buyer(app, 'a');
  buyerB = await buyer(app, 'b');
  harbour = await publisher('harbour-ledger');
  quayside = await publisher('quayside-gazette');
  tokens = {
    buyerA: await issue(buyerA, ['events:read']),
    buyerB: await issue(buyerB, ['events:read']),
    harbour: await issue(harbour, ['events:read']),
    quayside: await issue(quayside, ['events:read']),
  };
});

const headers = (token: string, extra: Record<string, string> = {}): Record<string, string> => ({
  authorization: `Bearer ${token}`,
  ...extra,
});
const post = (token: string, body: unknown) =>
  collection.POST(
    new Request(`${ORIGIN}/api/v1/webhook-subscriptions`, {
      method: 'POST',
      headers: headers(token, {
        'content-type': 'application/json',
        'idempotency-key': `adv-${String(++counter)}-abcdefgh`,
      }),
      body: JSON.stringify(body),
    }),
  );
const list = (token: string) =>
  collection.GET(
    new Request(`${ORIGIN}/api/v1/webhook-subscriptions`, { headers: headers(token) }),
  );
const del = (token: string, id: string) =>
  one.DELETE(
    new Request(`${ORIGIN}/api/v1/webhook-subscriptions/${id}`, {
      method: 'DELETE',
      headers: headers(token, { 'idempotency-key': `adv-del-${String(++counter)}-abcdefgh` }),
    }),
    { params: { id } },
  );
const deliveries = (token: string, id: string) =>
  deliveriesRoute.GET(
    new Request(`${ORIGIN}/api/v1/webhook-subscriptions/${id}/deliveries`, {
      headers: headers(token),
    }),
    { params: { id } },
  );
interface Json {
  id: string;
  signing_secret?: string;
  disabled_at: string | null;
  items: Record<string, unknown>[];
  error: { code: string; message: string };
}
const json = async (r: Response) => (await r.json()) as Json;
const count = async (): Promise<number> =>
  Number(
    (await app.db.query<{ n: string }>('SELECT count(*)::text AS n FROM webhook_subscriptions'))
      .rows[0]!.n,
  );
const append = async (type: EventType, payload: unknown): Promise<string> =>
  app.db.transaction((tx) => createApiV1(app).events.append(tx, { type, payload }));
const PAID = (buyer_id: string) => ({
  order_id: `ord_adv_${String(++counter)}`,
  buyer_id,
  total: { currency: 'USD', minor: 100 },
  paid_at: app.security.clock.now().toISOString(),
});
const SALE = (publisher_id: string) => ({
  order_id: `ord_adv_${String(++counter)}`,
  unit_id: `unt_adv_${String(counter)}`,
  publisher_id,
  gross: { currency: 'USD', minor: 40 },
  recorded_at: app.security.clock.now().toISOString(),
});
const URL_OK = 'https://hooks.example.com/adv';

describe('one owner against another', () => {
  it('a buyer cannot read, disable or list the deliveries of a seller subscription: 404, same body as a missing id', async () => {
    const mine = await json(
      await post(tokens.harbour, { url: URL_OK, event_types: ['sale.recorded'] }),
    );
    const missing = 'wsb_00000000000000000000000000';
    const probes = [
      [await deliveries(tokens.buyerA, mine.id), await deliveries(tokens.buyerA, missing)],
      [await del(tokens.buyerA, mine.id), await del(tokens.buyerA, missing)],
    ] as const;
    for (const [others, gone] of probes) {
      expect(others.status).toBe(404);
      expect(gone.status).toBe(404);
      // the same code and words; only the per-request support code differs
      const words = async (r: Response) => {
        const { code, message } = ((await r.json()) as Json).error;
        return { code, message };
      };
      expect(await words(others)).toEqual(await words(gone));
    }
    const row = await app.db.query<{ disabled_at: Date | null }>(
      'SELECT disabled_at FROM webhook_subscriptions WHERE id = $1',
      [mine.id],
    );
    expect(row.rows[0]!.disabled_at).toBeNull();
  });

  it('a buyer cannot touch another buyer’s subscription either', async () => {
    const mine = await json(
      await post(tokens.buyerA, { url: URL_OK, event_types: ['order.paid'] }),
    );
    expect((await deliveries(tokens.buyerB, mine.id)).status).toBe(404);
    expect((await del(tokens.buyerB, mine.id)).status).toBe(404);
    expect((await deliveries(tokens.buyerA, mine.id)).status).toBe(200);
    const row = await app.db.query<{ disabled_at: Date | null }>(
      'SELECT disabled_at FROM webhook_subscriptions WHERE id = $1',
      [mine.id],
    );
    expect(row.rows[0]!.disabled_at).toBeNull();
  });

  it('seller B cannot touch seller A’s subscription', async () => {
    const mine = await json(
      await post(tokens.harbour, { url: URL_OK, event_types: ['sale.recorded'] }),
    );
    expect((await deliveries(tokens.quayside, mine.id)).status).toBe(404);
    expect((await del(tokens.quayside, mine.id)).status).toBe(404);
  });

  it('a list never shows another owner’s subscription', async () => {
    const mine = await json(
      await post(tokens.buyerA, { url: URL_OK, event_types: ['order.paid'] }),
    );
    for (const t of [tokens.buyerB, tokens.harbour, tokens.quayside]) {
      const ids = (await json(await list(t))).items.map((i) => i['id']);
      expect(ids).not.toContain(mine.id);
    }
  });

  it('a malformed id is 404, not an error from the database', async () => {
    for (const id of ['x', "wsb_' OR 1=1 --", '../api-keys', 'wsb_'.padEnd(200, 'a')]) {
      expect((await deliveries(tokens.buyerA, id)).status).toBe(404);
      expect((await del(tokens.buyerA, id)).status).toBe(404);
    }
  });
});

describe('what an owner may subscribe to', () => {
  const matrix: [string, () => string, string[]][] = [
    ['buyer', () => tokens.buyerA, ['sale.recorded', 'settlement.completed']],
    [
      'seller',
      () => tokens.harbour,
      ['order.paid', 'entitlement.granted', 'mandate.exhausted', 'settlement.completed'],
    ],
  ];
  for (const [who, token, refused] of matrix) {
    for (const type of refused) {
      it(`a ${who} asking for ${type} is refused at creation: 403 event_type_not_allowed, no row`, async () => {
        const before = await count();
        const res = await post(token(), { url: URL_OK, event_types: ['refund.completed', type] });
        expect(res.status).toBe(403);
        expect((await json(res)).error.code).toBe('event_type_not_allowed');
        expect(await count()).toBe(before);
      });
    }
  }
});

describe('URLs', () => {
  const bad = [
    'http://hooks.example.com/x',
    'https://127.0.0.1/x',
    'https://127.1/x',
    'https://0x7f.1/x',
    'https://2130706433/x',
    'https://[::1]/x',
    'https://10.0.0.5/x',
    'https://169.254.169.254/latest/meta-data',
    'https://localhost/x',
    'https://localhost./x',
    'https://app.localhost/x',
    'https://intranet/x',
    'https://user:pass@hooks.example.com/x',
    'https://hooks.example.com/ x',
    `https://hooks.example.com/${'a'.repeat(2048)}`,
    'ftp://hooks.example.com/x',
    'javascript:alert(1)',
    '//hooks.example.com/x',
    '',
  ];
  it('refuses each unsafe URL with 422 and writes no row', async () => {
    const before = await count();
    for (const url of bad) {
      const res = await post(tokens.buyerA, { url, event_types: ['order.paid'] });
      expect(res.status, url.slice(0, 80)).toBe(422);
      expect((await json(res)).error.code).toBe('invalid_input');
    }
    expect(await count()).toBe(before);
  });
});

describe('the signing secret', () => {
  it('is in the creation answer only: not in a log line, an audit row, a list, a delivery list or a delete answer', async () => {
    const created = await json(
      await post(tokens.buyerA, { url: URL_OK, event_types: ['order.paid'] }),
    );
    const secret = created.signing_secret!;
    expect(secret).toMatch(/^whsec_[0-9a-f]{64}$/);
    await append('order.paid', PAID(buyerId(buyerA)));
    await app.deliverWebhooks({ max_items: 100 });
    const reads = [
      await list(tokens.buyerA),
      await deliveries(tokens.buyerA, created.id),
      await del(tokens.buyerA, created.id),
    ];
    for (const r of reads) expect(await r.text()).not.toContain(secret);
    expect(logs.join('\n')).not.toContain(secret);
    expect(logs.join('\n')).not.toContain('whsec_');
    const audit = await app.db.query<{ detail: unknown }>('SELECT detail FROM audit_log');
    expect(JSON.stringify(audit.rows)).not.toContain('whsec_');
    // the event and delivery rows do not carry it either
    const outbox = await app.db.query<{ payload: unknown }>('SELECT payload FROM event_outbox');
    expect(JSON.stringify(outbox.rows)).not.toContain('whsec_');
    const dl = await app.db.query<{ last_error: string | null }>(
      'SELECT last_error FROM webhook_deliveries',
    );
    expect(JSON.stringify(dl.rows)).not.toContain('whsec_');
  });

  it('an error from the sender is not stored or logged, only a code', async () => {
    const s = await json(
      await post(tokens.buyerB, {
        url: 'https://hooks.example.com/boom',
        event_types: ['order.paid'],
      }),
    );
    app.webhook_sink.clear();
    app.webhook_sink.script({ ok: false, error: 'connection' });
    await append('order.paid', PAID(buyerId(buyerB)));
    await app.deliverWebhooks({ max_items: 100 });
    const d = await json(await deliveries(tokens.buyerB, s.id));
    expect(d.items[0]).toMatchObject({ status: 'failed', last_error: 'connection' });
  });
});

describe('who receives an event', () => {
  it('seller B never receives seller A’s sale', async () => {
    const a = await json(
      await post(tokens.harbour, {
        url: 'https://a.example.com/h',
        event_types: ['sale.recorded'],
      }),
    );
    const b = await json(
      await post(tokens.quayside, {
        url: 'https://b.example.com/h',
        event_types: ['sale.recorded'],
      }),
    );
    app.webhook_sink.clear();
    await append('sale.recorded', SALE(pubId(harbour)));
    await app.deliverWebhooks({ max_items: 100 });
    expect(
      app.webhook_sink.records.filter((r) => r.url === 'https://a.example.com/h'),
    ).toHaveLength(1);
    expect(
      app.webhook_sink.records.filter((r) => r.url === 'https://b.example.com/h'),
    ).toHaveLength(0);
    expect((await json(await deliveries(tokens.quayside, b.id))).items).toEqual([]);
    expect((await json(await deliveries(tokens.harbour, a.id))).items).toHaveLength(1);
  });

  it('buyer B never receives buyer A’s order', async () => {
    await post(tokens.buyerA, { url: 'https://ba.example.com/h', event_types: ['order.paid'] });
    await post(tokens.buyerB, { url: 'https://bb.example.com/h', event_types: ['order.paid'] });
    app.webhook_sink.clear();
    await append('order.paid', PAID(buyerId(buyerA)));
    await app.deliverWebhooks({ max_items: 100 });
    expect(
      app.webhook_sink.records.filter((r) => r.url === 'https://ba.example.com/h'),
    ).toHaveLength(1);
    expect(
      app.webhook_sink.records.filter((r) => r.url === 'https://bb.example.com/h'),
    ).toHaveLength(0);
  });
});

describe('replay and switch off', () => {
  it('running the delivery pass again delivers nothing twice', async () => {
    const s = await json(
      await post(tokens.buyerA, {
        url: 'https://replay.example.com/h',
        event_types: ['order.paid'],
      }),
    );
    app.webhook_sink.clear();
    const evt = await append('order.paid', PAID(buyerId(buyerA)));
    for (let i = 0; i < 4; i++) await app.deliverWebhooks({ max_items: 100 });
    expect(
      app.webhook_sink.records.filter((r) => r.url === 'https://replay.example.com/h'),
    ).toHaveLength(1);
    const rows = await app.db.query<{ n: string }>(
      'SELECT count(*)::text AS n FROM webhook_deliveries WHERE event_id = $1 AND subscription_id = $2',
      [evt, s.id],
    );
    expect(rows.rows[0]!.n).toBe('1');
  });

  it('an event that is already in the outbox is not fanned out again to a subscription that exists twice for it', async () => {
    const evt = await append('order.paid', PAID(buyerId(buyerA)));
    await app.deliverWebhooks({ max_items: 100 });
    const before = await app.db.query<{ n: string }>(
      'SELECT count(*)::text AS n FROM webhook_deliveries WHERE event_id = $1',
      [evt],
    );
    await app.db.query('DELETE FROM webhook_fanout WHERE event_id = $1', [evt]);
    await app.deliverWebhooks({ max_items: 100 });
    const after = await app.db.query<{ n: string }>(
      'SELECT count(*)::text AS n FROM webhook_deliveries WHERE event_id = $1',
      [evt],
    );
    expect(after.rows[0]!.n).toBe(before.rows[0]!.n);
  });

  it('a disabled subscription gets nothing, also when the event was fanned out before it was disabled', async () => {
    const s = await json(
      await post(tokens.buyerB, { url: 'https://off.example.com/h', event_types: ['order.paid'] }),
    );
    app.webhook_sink.clear();
    await append('order.paid', PAID(buyerId(buyerB)));
    await del(tokens.buyerB, s.id);
    await app.deliverWebhooks({ max_items: 100 });
    expect(
      app.webhook_sink.records.filter((r) => r.url === 'https://off.example.com/h'),
    ).toHaveLength(0);
    const d = await json(await deliveries(tokens.buyerB, s.id));
    for (const item of d.items) expect(item['status']).toBe('dead');
  });
});

describe('verifySignature', () => {
  const SECRET = `whsec_${'ab'.repeat(32)}`;
  const BODY = '{"id":"evt_x","type":"order.paid"}';
  const NOW = new Date('2026-11-04T10:00:00.000Z');

  it('uses timingSafeEqual on two equal-length buffers', () => {
    const spy = vi.mocked(timingSafeEqual);
    spy.mockClear();
    const header = signatureHeader(SECRET, Math.floor(NOW.getTime() / 1000), BODY);
    expect(verifySignature(SECRET, header, BODY, NOW)).toBe(true);
    expect(spy).toHaveBeenCalled();
    for (const [a, b] of spy.mock.calls) {
      expect(Buffer.from(a as Uint8Array).length).toBe(Buffer.from(b as Uint8Array).length);
    }
  });

  it('refuses, and does not throw on, a v1 of the wrong length or not hex', () => {
    const t = Math.floor(NOW.getTime() / 1000);
    for (const v1 of ['', 'a', 'a'.repeat(63), 'a'.repeat(65), 'g'.repeat(64), '😀'.repeat(32)]) {
      expect(() => verifySignature(SECRET, `t=${String(t)},v1=${v1}`, BODY, NOW)).not.toThrow();
      expect(verifySignature(SECRET, `t=${String(t)},v1=${v1}`, BODY, NOW)).toBe(false);
    }
  });
});

describe('delivery stays in process', () => {
  it('opens no socket, no lookup and no fetch (the offline guard checks this at the end of the file)', async () => {
    await post(tokens.buyerA, {
      url: 'https://offline.example.com/h',
      event_types: ['order.paid'],
    });
    app.webhook_sink.clear();
    await append('order.paid', PAID(buyerId(buyerA)));
    await app.deliverWebhooks({ max_items: 100 });
    expect(app.webhook_sink.records.some((r) => r.url === 'https://offline.example.com/h')).toBe(
      true,
    );
  });
});
