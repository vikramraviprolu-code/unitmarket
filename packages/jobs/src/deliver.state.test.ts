// API-C (E1, E2): the webhook delivery pass. Fan-out of outbox events to matching subscriptions (each
// subscriber sees only events about its own resources), one signed send per delivery, the retry schedule
// 1 min, 5 min, 30 min, 2 h, 6 h and then dead, on a fake clock. Real PGlite with every migration; the
// sender is a script, so nothing leaves the process. Adversarial cases are in
// apps/web/src/api-v1/events.adversarial.test.ts.
import { createHmac } from 'node:crypto';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Database, EventType, WebhookOutcome, WebhookRequest } from '@umsbx/contracts';
import { migrate, openDatabase } from '@umsbx/db';
import { fakeClock, seededIds } from '@umsbx/runtime';
import { MAX_ATTEMPTS, RETRY_DELAYS_MS, runDeliveryPass } from './deliver';
import type { DeliverDeps } from './deliver';

const START = '2026-11-04T10:00:00.000Z';
const MIN = 60_000;
const HOUR = 60 * MIN;
type Db = Database & { close(): Promise<void> };

// One migrated database for the file. event_outbox is append-only, so between tests it is emptied the
// way the db package's own reset does it: TRUNCATE behind the guard that only an in-memory test database
// may open (ums.allow_reset and ums.db_target set for that one statement).
let shared: Promise<Db> | null = null;
const sharedDb = (): Promise<Db> =>
  (shared ??= (async () => {
    const d = await openDatabase({ kind: 'pglite-memory' });
    await migrate(d, fakeClock(START));
    return d;
  })());
afterAll(async () => {
  if (shared !== null) await (await shared).close();
  shared = null;
});
const emptyTables = (db: Db): Promise<void> =>
  db.exec(
    `SELECT set_config('ums.allow_reset', 'on', true), set_config('ums.db_target', 'memory', true);
     TRUNCATE event_outbox, webhook_subscriptions, orders, approvals, buyers, corridors CASCADE`,
  );

const SECRET_A = `whsec_${'a1'.repeat(32)}`;
const SECRET_B = `whsec_${'b2'.repeat(32)}`;
const hmacHeader = (secret: string, t: number, body: string): string =>
  `t=${String(t)},v1=${createHmac('sha256', secret)
    .update(`${String(t)}.${body}`)
    .digest('hex')}`;

interface Rig {
  db: Db;
  clock: ReturnType<typeof fakeClock>;
  deps: DeliverDeps;
  sent: (WebhookRequest & { at: string })[];
  logs: string[];
  /** Outcomes for the next sends, in order; an empty script answers ok. */
  script: (WebhookOutcome | 'throw')[];
  /** Holds every send until released (for a pass that is still running). */
  gate: { hold: boolean; release: (() => void)[] };
  pass(max_items?: number): ReturnType<typeof runDeliveryPass>;
  tick(ms: number): void;
  now(): string;
  sub(o?: SubOver): Promise<string>;
  event(
    type: EventType,
    payload: Record<string, unknown>,
    o?: { id?: string; at?: string },
  ): Promise<string>;
  order(order_id: string, buyer_id: string): Promise<void>;
  deliveries(): Promise<Row[]>;
}
interface SubOver {
  id?: string;
  owner_kind?: 'buyer' | 'publisher' | 'operator';
  owner_id?: string;
  event_types?: string[];
  url?: string;
  secret?: string;
  created_at?: string;
  disabled_at?: string | null;
}
interface Row {
  id: string;
  event_id: string;
  subscription_id: string;
  attempt: number;
  status: string;
  next_at: string | null;
  last_error: string | null;
}

let counter = 0;
async function makeRig(): Promise<Rig> {
  const db = await sharedDb();
  await emptyTables(db);
  const clock = fakeClock(START);
  const sent: Rig['sent'] = [];
  const logs: string[] = [];
  const script: Rig['script'] = [];
  const gate: Rig['gate'] = { hold: false, release: [] };
  const deps: DeliverDeps = {
    db,
    clock,
    ids: seededIds(`deliver-${String(++counter)}`),
    log: {
      log: (e) => {
        logs.push(JSON.stringify(e));
      },
      child: () => deps.log,
    },
    sign: (secret, t, body) => hmacHeader(secret, t, body),
    sender: {
      async send(req) {
        sent.push({ ...req, at: clock.now().toISOString() });
        if (gate.hold) await new Promise<void>((r) => gate.release.push(r));
        const next = script.shift();
        if (next === 'throw') throw new Error(`boom: ${SECRET_A} ${req.url}`);
        return next ?? { ok: true };
      },
    },
  };
  const iso = (v: unknown): string | null =>
    v === null ? null : new Date(v as string).toISOString();
  const rig: Rig = {
    db,
    clock,
    deps,
    sent,
    logs,
    script,
    gate,
    pass: (max_items = 100) => runDeliveryPass(deps, { max_items }),
    tick: (ms) => clock.advance(ms),
    now: () => clock.now().toISOString(),
    async sub(o = {}) {
      const id = o.id ?? `wsb_${String(++counter)}`;
      await db.query(
        `INSERT INTO webhook_subscriptions (id, owner_kind, owner_id, url, event_types, signing_secret, created_at, updated_at, disabled_at)
         VALUES ($1, $2, $3, $4, $5::text[], $6, $7, $7, $8)`,
        [
          id,
          o.owner_kind ?? 'buyer',
          o.owner_id ?? 'buy_a',
          o.url ?? `https://hooks.example.com/${id}`,
          o.event_types ?? ['order.paid'],
          o.secret ?? SECRET_A,
          o.created_at ?? START,
          o.disabled_at ?? null,
        ],
      );
      return id;
    },
    async event(type, payload, o = {}) {
      const id = o.id ?? `evt_${String(++counter)}`;
      await db.query(
        `INSERT INTO event_outbox (id, type, payload, occurred_at) VALUES ($1, $2, $3::jsonb, $4)`,
        [id, type, JSON.stringify(payload), o.at ?? clock.now().toISOString()],
      );
      return id;
    },
    async order(order_id, buyer_id) {
      await db.query(
        `INSERT INTO corridors (id, currency, minor_units, buyer_countries, payee_countries, domestic_supported, min_charge_minor, enabled, created_at, updated_at)
         VALUES ('us-usd', 'USD', 2, ARRAY['US'], ARRAY['US'], true, NULL, true, $1, $1) ON CONFLICT (id) DO NOTHING`,
        [START],
      );
      await db.query(
        `INSERT INTO buyers (id, display_name, auth_subject, country, created_at, updated_at)
         VALUES ($1, 'B', $2, 'GB', $3, $3) ON CONFLICT (id) DO NOTHING`,
        [buyer_id, `s:${buyer_id}`, START],
      );
      await db.query(
        `INSERT INTO approvals (id, buyer_id, snapshot, content_hash, nonce, expires_at, used_at, environment, created_at, updated_at)
         VALUES ($1, $2, '{}'::jsonb, $3, $4, $5, NULL, 'dryrun', $6, $6)`,
        [
          `apr_${order_id}`,
          buyer_id,
          'c'.repeat(64),
          `n-${order_id}`,
          new Date(Date.parse(START) + 15 * MIN).toISOString(),
          START,
        ],
      );
      await db.query(
        `INSERT INTO orders (id, approval_id, buyer_id, content_hash, order_ref, expected, status, mismatch, corridor_id, currency, total_minor, environment, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, '{}'::jsonb, 'paid', false, 'us-usd', 'USD', 100, 'dryrun', $6, $6)`,
        [order_id, `apr_${order_id}`, buyer_id, 'c'.repeat(64), `ref_${order_id}`, START],
      );
    },
    async deliveries() {
      const r = await db.query<Record<string, unknown>>(
        'SELECT id, event_id, subscription_id, attempt, status, next_at, last_error FROM webhook_deliveries ORDER BY created_at, id',
      );
      return r.rows.map((x) => ({
        id: x['id'] as string,
        event_id: x['event_id'] as string,
        subscription_id: x['subscription_id'] as string,
        attempt: Number(x['attempt']),
        status: x['status'] as string,
        next_at: iso(x['next_at']),
        last_error: x['last_error'] as string | null,
      }));
    },
  };
  return rig;
}

const PAID = (order_id = 'ord_1', buyer_id = 'buy_a') => ({
  order_id,
  buyer_id,
  total: { currency: 'USD', minor: 100 },
  paid_at: START,
});
const SALE = (publisher_id = 'pub_a', order_id = 'ord_1') => ({
  order_id,
  unit_id: 'unt_1',
  publisher_id,
  gross: { currency: 'USD', minor: 100 },
  recorded_at: START,
});
const REFUND = (publisher_id = 'pub_a', order_id = 'ord_1') => ({
  refund_id: 'ref_1',
  order_id,
  unit_id: 'unt_1',
  publisher_id,
  amount: { currency: 'USD', minor: 100 },
  completed_at: START,
});
const SETTLED = { pass_id: 'pas_1', checked: 2, fixed: 1, completed_at: START };

let r: Rig;
beforeEach(async () => {
  r = await makeRig();
});

describe('constants', () => {
  it('retries at 1 min, 5 min, 30 min, 2 h and 6 h: six tries in all, the first send counts as attempt 1', () => {
    expect([...RETRY_DELAYS_MS]).toEqual([MIN, 5 * MIN, 30 * MIN, 2 * HOUR, 6 * HOUR]);
    expect(MAX_ATTEMPTS).toBe(6);
  });
});

describe('fan-out and the first send', () => {
  it('sends an event to a matching subscription once, signed, with the event id', async () => {
    const sub = await r.sub();
    const evt = await r.event('order.paid', PAID());
    const counts = await r.pass();
    expect(counts).toMatchObject({ fanned_out: 1, attempted: 1, delivered: 1, failed: 0, dead: 0 });
    expect(r.sent).toHaveLength(1);
    const s = r.sent[0]!;
    expect(s.url).toBe(`https://hooks.example.com/${sub}`);
    expect(JSON.parse(s.body)).toEqual({
      id: evt,
      type: 'order.paid',
      payload: PAID(),
      occurred_at: START,
    });
    expect(Object.keys(JSON.parse(s.body))).toEqual(['id', 'type', 'payload', 'occurred_at']);
    expect(s.headers['UnitMarket-Event-Id']).toBe(evt);
    expect(s.headers['Content-Type']).toBe('application/json');
    const t = Math.floor(Date.parse(START) / 1000);
    expect(s.headers['UnitMarket-Signature']).toBe(hmacHeader(SECRET_A, t, s.body));
    expect(await r.deliveries()).toEqual([
      expect.objectContaining({
        event_id: evt,
        subscription_id: sub,
        attempt: 1,
        status: 'delivered',
        next_at: null,
        last_error: null,
      }),
    ]);
  });

  it('signs with the secret of that subscription, not another one', async () => {
    await r.sub({ id: 'wsb_one', owner_id: 'buy_a', secret: SECRET_A });
    await r.sub({ id: 'wsb_two', owner_id: 'buy_a', secret: SECRET_B });
    await r.event('order.paid', PAID());
    await r.pass();
    expect(r.sent).toHaveLength(2);
    const t = Math.floor(Date.parse(START) / 1000);
    for (const s of r.sent) {
      const secret = s.url.endsWith('wsb_one') ? SECRET_A : SECRET_B;
      expect(s.headers['UnitMarket-Signature']).toBe(hmacHeader(secret, t, s.body));
    }
  });

  it('the time in the signature is whole unix seconds of the clock at the send', async () => {
    await r.sub();
    await r.event('order.paid', PAID());
    r.tick(1_999);
    await r.pass();
    const t = Math.floor((Date.parse(START) + 1_999) / 1000);
    expect(r.sent[0]!.headers['UnitMarket-Signature']).toMatch(new RegExp(`^t=${String(t)},v1=`));
  });

  it('only a subscription that asked for the type, and was made before the event, gets it', async () => {
    await r.sub({ id: 'wsb_other_type', event_types: ['entitlement.granted'] });
    await r.sub({ id: 'wsb_late', created_at: new Date(Date.parse(START) + MIN).toISOString() });
    await r.sub({ id: 'wsb_same_time', created_at: START });
    await r.event('order.paid', PAID());
    await r.pass();
    expect((await r.deliveries()).map((d) => d.subscription_id)).toEqual(['wsb_same_time']);
    expect(r.sent.map((s) => s.url)).toEqual(['https://hooks.example.com/wsb_same_time']);
  });

  it('a disabled subscription gets nothing', async () => {
    await r.sub({ id: 'wsb_off', disabled_at: START });
    await r.event('order.paid', PAID());
    const counts = await r.pass();
    expect(counts.fanned_out).toBe(1);
    expect(counts.attempted).toBe(0);
    expect(await r.deliveries()).toEqual([]);
    expect(r.sent).toEqual([]);
  });

  it('an event nobody subscribed to is marked and not looked at again', async () => {
    await r.event('order.paid', PAID());
    expect((await r.pass()).fanned_out).toBe(1);
    expect((await r.pass()).fanned_out).toBe(0);
    const marks = await r.db.query<{ n: string }>('SELECT count(*)::text AS n FROM webhook_fanout');
    expect(marks.rows[0]!.n).toBe('1');
    // a subscription made afterwards does not get the older event
    await r.sub();
    await r.pass();
    expect(r.sent).toEqual([]);
  });

  it('delivers events in the order they happened, then by id', async () => {
    await r.sub({ event_types: ['order.paid'] });
    const later = new Date(Date.parse(START) + 5_000).toISOString();
    await r.event('order.paid', PAID('ord_3'), { id: 'evt_c', at: later });
    await r.event('order.paid', PAID('ord_2'), { id: 'evt_b', at: START });
    await r.event('order.paid', PAID('ord_1'), { id: 'evt_a', at: START });
    r.tick(10_000);
    await r.pass();
    expect(r.sent.map((s) => s.headers['UnitMarket-Event-Id'])).toEqual([
      'evt_a',
      'evt_b',
      'evt_c',
    ]);
  });

  it('keeps to the cap of one pass for fan-out and for sends', async () => {
    await r.sub();
    for (let i = 0; i < 5; i += 1)
      await r.event('order.paid', PAID(`ord_${String(i)}`), { id: `evt_${String(i)}` });
    const first = await r.pass(2);
    expect(first).toMatchObject({ fanned_out: 2, attempted: 2, delivered: 2 });
    const second = await r.pass(2);
    expect(second).toMatchObject({ fanned_out: 2, attempted: 2, delivered: 2 });
    const third = await r.pass(2);
    expect(third).toMatchObject({ fanned_out: 1, attempted: 1, delivered: 1 });
    expect(r.sent).toHaveLength(5);
    expect(await r.pass(2)).toMatchObject({ fanned_out: 0, attempted: 0 });
  });

  it('a pass that has nothing to do answers zeroes', async () => {
    expect(await r.pass()).toEqual({
      fanned_out: 0,
      attempted: 0,
      delivered: 0,
      failed: 0,
      dead: 0,
    });
  });

  it('a pass with a cap of zero or less does nothing', async () => {
    await r.sub();
    await r.event('order.paid', PAID());
    expect(await r.pass(0)).toEqual({
      fanned_out: 0,
      attempted: 0,
      delivered: 0,
      failed: 0,
      dead: 0,
    });
    expect(await r.pass(-1)).toEqual({
      fanned_out: 0,
      attempted: 0,
      delivered: 0,
      failed: 0,
      dead: 0,
    });
    expect(r.sent).toEqual([]);
  });
});

describe('who sees which event', () => {
  it('a buyer gets the order, entitlement and mandate events of that buyer only', async () => {
    await r.sub({
      id: 'wsb_a',
      owner_id: 'buy_a',
      event_types: ['order.paid', 'entitlement.granted', 'mandate.exhausted'],
    });
    await r.sub({
      id: 'wsb_b',
      owner_id: 'buy_b',
      event_types: ['order.paid', 'entitlement.granted', 'mandate.exhausted'],
    });
    await r.event('order.paid', PAID('ord_1', 'buy_a'));
    await r.event('entitlement.granted', {
      entitlement_id: 'ent_1',
      order_id: 'ord_2',
      buyer_id: 'buy_b',
      unit_id: 'unt_2',
      granted_at: START,
    });
    await r.event('mandate.exhausted', {
      mandate_id: 'man_1',
      buyer_id: 'buy_a',
      agent_key_id: 'key_1',
      reason: 'count',
      exhausted_at: START,
    });
    await r.pass();
    const bySub = new Map<string, string[]>();
    for (const d of await r.deliveries()) {
      const type = (
        await r.db.query<{ type: string }>('SELECT type FROM event_outbox WHERE id = $1', [
          d.event_id,
        ])
      ).rows[0]!.type;
      bySub.set(d.subscription_id, [...(bySub.get(d.subscription_id) ?? []), type].sort());
    }
    expect(bySub.get('wsb_a')).toEqual(['mandate.exhausted', 'order.paid']);
    expect(bySub.get('wsb_b')).toEqual(['entitlement.granted']);
  });

  it('a seller gets its own sales and refunds, never another seller’s', async () => {
    await r.sub({
      id: 'wsb_pa',
      owner_kind: 'publisher',
      owner_id: 'pub_a',
      event_types: ['sale.recorded', 'refund.completed'],
    });
    await r.sub({
      id: 'wsb_pb',
      owner_kind: 'publisher',
      owner_id: 'pub_b',
      event_types: ['sale.recorded', 'refund.completed'],
    });
    await r.event('sale.recorded', SALE('pub_a'), { id: 'evt_sale_a' });
    await r.event('sale.recorded', SALE('pub_b'), { id: 'evt_sale_b' });
    await r.event('refund.completed', REFUND('pub_b'), { id: 'evt_ref_b' });
    await r.pass();
    const got = (await r.deliveries()).map((d) => `${d.subscription_id}:${d.event_id}`).sort();
    expect(got).toEqual(['wsb_pa:evt_sale_a', 'wsb_pb:evt_ref_b', 'wsb_pb:evt_sale_b']);
    const toA = r.sent
      .filter((s) => s.url.endsWith('wsb_pa'))
      .map((s) => s.body)
      .join('');
    expect(toA).not.toContain('pub_b');
  });

  it('a buyer gets a refund.completed for an order of its own, not for someone else’s or an unknown one', async () => {
    await r.order('ord_mine', 'buy_a');
    await r.order('ord_theirs', 'buy_b');
    await r.sub({ id: 'wsb_a', owner_id: 'buy_a', event_types: ['refund.completed'] });
    await r.event('refund.completed', REFUND('pub_a', 'ord_mine'), { id: 'evt_mine' });
    await r.event('refund.completed', REFUND('pub_a', 'ord_theirs'), { id: 'evt_theirs' });
    await r.event('refund.completed', REFUND('pub_a', 'ord_unknown'), { id: 'evt_unknown' });
    await r.pass();
    expect((await r.deliveries()).map((d) => d.event_id)).toEqual(['evt_mine']);
  });

  it('the operator gets the reconciler pass events, a buyer or a seller never does', async () => {
    await r.sub({
      id: 'wsb_op',
      owner_kind: 'operator',
      owner_id: 'opr_a',
      event_types: ['settlement.completed'],
    });
    await r.sub({
      id: 'wsb_op2',
      owner_kind: 'operator',
      owner_id: 'opr_b',
      event_types: ['settlement.completed'],
    });
    await r.sub({ id: 'wsb_b', owner_id: 'buy_a', event_types: ['order.paid'] });
    await r.event('settlement.completed', SETTLED);
    await r.pass();
    expect((await r.deliveries()).map((d) => d.subscription_id).sort()).toEqual([
      'wsb_op',
      'wsb_op2',
    ]);
  });
});

describe('replay', () => {
  it('fanning an event out again delivers once per subscription', async () => {
    await r.sub({ id: 'wsb_1' });
    await r.sub({ id: 'wsb_2' });
    const evt = await r.event('order.paid', PAID());
    await r.pass();
    expect(r.sent).toHaveLength(2);
    await r.db.query('DELETE FROM webhook_fanout WHERE event_id = $1', [evt]);
    const again = await r.pass();
    expect(again.fanned_out).toBe(1);
    expect(again.attempted).toBe(0);
    expect(r.sent).toHaveLength(2);
    expect(await r.deliveries()).toHaveLength(2);
  });

  it('a delivered delivery is never sent again, however many passes run', async () => {
    await r.sub();
    await r.event('order.paid', PAID());
    for (let i = 0; i < 5; i += 1) {
      await r.pass();
      r.tick(10 * HOUR);
    }
    expect(r.sent).toHaveLength(1);
  });

  it('two passes at once send a delivery once (a claim, not a hope)', async () => {
    await r.sub();
    await r.event('order.paid', PAID());
    const both = await Promise.all([r.pass(), r.pass()]);
    expect(r.sent).toHaveLength(1);
    expect(both.reduce((n, c) => n + c.attempted, 0)).toBe(1);
    expect((await r.deliveries())[0]).toMatchObject({ attempt: 1, status: 'delivered' });
  });

  it('a pass that starts while another still waits for the receiver does not send it again', async () => {
    await r.sub();
    await r.event('order.paid', PAID());
    r.gate.hold = true;
    const first = r.pass();
    await vi.waitFor(() => expect(r.sent).toHaveLength(1), { timeout: 10_000 });
    r.tick(MIN / 2);
    const second = await r.pass();
    expect(second.attempted).toBe(0);
    expect(r.sent).toHaveLength(1);
    r.gate.hold = false;
    for (const release of r.gate.release) release();
    await first;
    expect((await r.deliveries())[0]).toMatchObject({ status: 'delivered', attempt: 1 });
  });
});

describe('retries and the dead letter', () => {
  const fail5xx = (): void => {
    for (let i = 0; i < 20; i += 1) r.script.push({ ok: false, error: 'http_5xx' });
  };

  it('fails, waits 1 min, 5 min, 30 min, 2 h, 6 h, and then the delivery is dead', async () => {
    await r.sub();
    await r.event('order.paid', PAID());
    fail5xx();
    const t0 = Date.parse(START);
    const at = (ms: number): string => new Date(t0 + ms).toISOString();
    const timeline: { attempt: number; at: string; status: string; next_at: string | null }[] = [];
    const wait = [MIN, 5 * MIN, 30 * MIN, 2 * HOUR, 6 * HOUR];
    let elapsed = 0;
    for (let attempt = 1; attempt <= 6; attempt += 1) {
      const counts = await r.pass();
      expect(counts.attempted, `attempt ${String(attempt)}`).toBe(1);
      const d = (await r.deliveries())[0]!;
      timeline.push({ attempt: d.attempt, at: r.now(), status: d.status, next_at: d.next_at });
      if (attempt < 6) {
        elapsed += wait[attempt - 1]!;
        expect(d.next_at, `after attempt ${String(attempt)}`).toBe(at(elapsed));
        // one millisecond early: nothing is sent
        r.tick(wait[attempt - 1]! - 1);
        expect((await r.pass()).attempted).toBe(0);
        r.tick(1);
      }
    }
    expect(timeline).toEqual([
      { attempt: 1, at: at(0), status: 'failed', next_at: at(MIN) },
      { attempt: 2, at: at(MIN), status: 'failed', next_at: at(6 * MIN) },
      { attempt: 3, at: at(6 * MIN), status: 'failed', next_at: at(36 * MIN) },
      { attempt: 4, at: at(36 * MIN), status: 'failed', next_at: at(36 * MIN + 2 * HOUR) },
      {
        attempt: 5,
        at: at(36 * MIN + 2 * HOUR),
        status: 'failed',
        next_at: at(36 * MIN + 8 * HOUR),
      },
      { attempt: 6, at: at(36 * MIN + 8 * HOUR), status: 'dead', next_at: null },
    ]);
    expect(r.sent).toHaveLength(6);
    expect((await r.deliveries())[0]).toMatchObject({
      attempt: 6,
      status: 'dead',
      next_at: null,
      last_error: 'http_5xx',
    });
    // dead is final
    r.tick(48 * HOUR);
    expect((await r.pass()).attempted).toBe(0);
    expect(r.sent).toHaveLength(6);
  });

  it('counts failed and dead in the answer of the pass', async () => {
    await r.sub();
    await r.event('order.paid', PAID());
    fail5xx();
    expect(await r.pass()).toMatchObject({ attempted: 1, delivered: 0, failed: 1, dead: 0 });
    for (const ms of [MIN, 5 * MIN, 30 * MIN, 2 * HOUR]) {
      r.tick(ms);
      await r.pass();
    }
    r.tick(6 * HOUR);
    expect(await r.pass()).toMatchObject({ attempted: 1, delivered: 0, failed: 0, dead: 1 });
  });

  it('a later success ends it: delivered, no next time, the old error cleared', async () => {
    await r.sub();
    await r.event('order.paid', PAID());
    r.script.push({ ok: false, error: 'timeout' }, { ok: false, error: 'connection' });
    await r.pass();
    expect((await r.deliveries())[0]).toMatchObject({
      attempt: 1,
      status: 'failed',
      last_error: 'timeout',
    });
    r.tick(MIN);
    await r.pass();
    expect((await r.deliveries())[0]).toMatchObject({
      attempt: 2,
      status: 'failed',
      last_error: 'connection',
    });
    r.tick(5 * MIN);
    await r.pass();
    expect((await r.deliveries())[0]).toMatchObject({
      attempt: 3,
      status: 'delivered',
      next_at: null,
      last_error: null,
    });
    r.tick(10 * HOUR);
    await r.pass();
    expect(r.sent).toHaveLength(3);
  });

  it('every retry sends the same bytes with a new time in the signature', async () => {
    await r.sub();
    await r.event('order.paid', PAID());
    r.script.push({ ok: false, error: 'http_4xx' });
    await r.pass();
    r.tick(MIN);
    await r.pass();
    expect(r.sent).toHaveLength(2);
    expect(r.sent[1]!.body).toBe(r.sent[0]!.body);
    expect(r.sent[1]!.headers['UnitMarket-Event-Id']).toBe(
      r.sent[0]!.headers['UnitMarket-Event-Id'],
    );
    expect(r.sent[1]!.headers['UnitMarket-Signature']).not.toBe(
      r.sent[0]!.headers['UnitMarket-Signature'],
    );
    const t = Math.floor((Date.parse(START) + MIN) / 1000);
    expect(r.sent[1]!.headers['UnitMarket-Signature']).toBe(
      hmacHeader(SECRET_A, t, r.sent[1]!.body),
    );
  });

  it('a sender that throws is a failed try with the code sender_error, and the message is kept nowhere', async () => {
    await r.sub();
    await r.event('order.paid', PAID());
    r.script.push('throw');
    const counts = await r.pass();
    expect(counts).toMatchObject({ attempted: 1, failed: 1 });
    const d = (await r.deliveries())[0]!;
    expect(d).toMatchObject({ status: 'failed', last_error: 'sender_error' });
    const everything = JSON.stringify(d) + r.logs.join('\n');
    expect(everything).not.toContain(SECRET_A);
    expect(everything).not.toContain('hooks.example.com');
  });

  it('failures of other deliveries do not hold up the rest of the pass', async () => {
    await r.sub({ id: 'wsb_1' });
    await r.sub({ id: 'wsb_2' });
    await r.event('order.paid', PAID());
    r.script.push({ ok: false, error: 'timeout' });
    const counts = await r.pass();
    expect(counts).toMatchObject({ attempted: 2, delivered: 1, failed: 1 });
  });

  it('a subscription disabled after fan-out is not sent to: the delivery ends dead with subscription_disabled', async () => {
    const sub = await r.sub();
    await r.event('order.paid', PAID());
    r.script.push({ ok: false, error: 'timeout' });
    await r.pass();
    await r.db.query(
      'UPDATE webhook_subscriptions SET disabled_at = $2, updated_at = $2 WHERE id = $1',
      [sub, r.now()],
    );
    r.tick(MIN);
    const counts = await r.pass();
    expect(counts.dead).toBe(1);
    expect(r.sent).toHaveLength(1);
    expect((await r.deliveries())[0]).toMatchObject({
      status: 'dead',
      next_at: null,
      last_error: 'subscription_disabled',
    });
  });

  it('a delivery whose last try was claimed and never finished ends dead instead of a seventh try', async () => {
    const sub = await r.sub();
    const evt = await r.event('order.paid', PAID());
    await r.db.query(
      `INSERT INTO webhook_deliveries (id, event_id, subscription_id, attempt, status, next_at, last_error, created_at, updated_at)
       VALUES ('wdl_stuck', $1, $2, 6, 'failed', $3, 'timeout', $3, $3)`,
      [evt, sub, START],
    );
    await r.db.query(
      `INSERT INTO webhook_fanout (event_id, created_at, updated_at) VALUES ($1, $2, $2)`,
      [evt, START],
    );
    const counts = await r.pass();
    expect(counts.dead).toBe(1);
    expect(r.sent).toEqual([]);
    expect((await r.deliveries())[0]).toMatchObject({ attempt: 6, status: 'dead', next_at: null });
  });

  it('writes no secret and no body to the log, whatever happens', async () => {
    await r.sub();
    await r.event('order.paid', PAID());
    r.script.push({ ok: false, error: 'http_5xx' }, 'throw');
    await r.pass();
    r.tick(MIN);
    await r.pass();
    const logged = r.logs.join('\n');
    expect(logged).not.toContain('whsec_');
    expect(logged).not.toContain('buy_a');
    expect(logged).not.toContain('UnitMarket-Signature');
  });
});
