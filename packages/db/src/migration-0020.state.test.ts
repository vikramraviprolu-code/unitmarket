// API-C (E1): migration 0020 adds webhook_subscriptions, webhook_fanout and webhook_deliveries. Forward-only,
// no defaults, system only (the Supabase policy is a listed follow-up, Supabase is unused, D-049). The
// number is the next free one after main at merge time; this file and the migration move together.
import { readdirSync, readFileSync } from 'node:fs';
import { afterAll, describe, expect, it } from 'vitest';
import type { Database } from '@umsbx/contracts';
import { migrate, openDatabase } from './index';

const T = '2026-11-04T10:00:00Z';
const clock = { now: () => new Date(T) };
type Db = Database & { close(): Promise<void> };
const toClose: Db[] = [];
afterAll(async () => {
  for (const d of toClose) await d.close();
});
async function fresh(): Promise<Db> {
  const d = await openDatabase({ kind: 'pglite-memory' });
  toClose.push(d);
  await migrate(d, clock);
  return d;
}
const FILE = '0020_webhooks.sql';
const SECRET = `whsec_${'ab'.repeat(32)}`;

const event = (d: Db, id = 'evt_a') =>
  d.query(
    `INSERT INTO event_outbox (id, type, payload, occurred_at) VALUES ($1, 'order.paid', '{}'::jsonb, $2)`,
    [id, T],
  );
interface SubOver {
  id?: string;
  owner_kind?: string;
  owner_id?: string;
  url?: string;
  event_types?: string[];
  secret?: string;
  disabled_at?: string | null;
}
const sub = (d: Db, o: SubOver = {}) =>
  d.query(
    `INSERT INTO webhook_subscriptions (id, owner_kind, owner_id, url, event_types, signing_secret, created_at, updated_at, disabled_at)
     VALUES ($1, $2, $3, $4, $5::text[], $6, $7, $7, $8)`,
    [
      o.id ?? 'wsb_a',
      o.owner_kind ?? 'buyer',
      o.owner_id ?? 'buy_a',
      o.url ?? 'https://hooks.example.com/um',
      o.event_types ?? ['order.paid'],
      o.secret ?? SECRET,
      T,
      o.disabled_at ?? null,
    ],
  );
interface DelOver {
  id?: string;
  event_id?: string;
  subscription_id?: string;
  attempt?: number;
  status?: string;
  next_at?: string | null;
  last_error?: string | null;
}
const delivery = (d: Db, o: DelOver = {}) =>
  d.query(
    `INSERT INTO webhook_deliveries (id, event_id, subscription_id, attempt, status, next_at, last_error, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $8)`,
    [
      o.id ?? 'wdl_a',
      o.event_id ?? 'evt_a',
      o.subscription_id ?? 'wsb_a',
      o.attempt ?? 0,
      o.status ?? 'pending',
      o.next_at === undefined ? T : o.next_at,
      o.last_error === undefined ? null : o.last_error,
      T,
    ],
  );

describe('migration 0020', () => {
  it('is applied once, after 0019, with no down step, no default and no now()', async () => {
    const d = await openDatabase({ kind: 'pglite-memory' });
    toClose.push(d);
    const first = await migrate(d, clock);
    expect(first).toContain('0020_webhooks');
    expect(first.indexOf('0020_webhooks')).toBeGreaterThan(first.indexOf('0019_api_keys'));
    expect(await migrate(d, clock)).toEqual([]);
    const dir = new URL('../migrations/common/', import.meta.url);
    expect(readdirSync(dir).filter((n) => /^0020_.*(down|rollback)/i.test(n))).toEqual([]);
    const sql = readFileSync(new URL(FILE, dir), 'utf8').replace(/--.*$/gm, '');
    expect(sql).not.toMatch(/\bDEFAULT\b/i);
    expect(sql).not.toMatch(/\bnow\s*\(/i);
  });

  it('says in its header that Supabase row level security is a hard prerequisite before any Supabase use', () => {
    const raw = readFileSync(new URL(`../migrations/common/${FILE}`, import.meta.url), 'utf8');
    const header = raw.split('CREATE TABLE')[0]!.replace(/\s+/g, ' ');
    expect(header).toMatch(/hard prerequisite/i);
    expect(header).toMatch(/row.level security/i);
    expect(header).toMatch(/signing_secret/);
  });

  it('adds three tables and changes no other table', async () => {
    const d = await fresh();
    const tables = await d.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'
        AND table_name IN ('webhook_subscriptions', 'webhook_fanout', 'webhook_deliveries')
         ORDER BY table_name`,
    );
    expect(tables.rows.map((t) => t.table_name)).toEqual([
      'webhook_deliveries',
      'webhook_fanout',
      'webhook_subscriptions',
    ]);
  });
});

describe('webhook_subscriptions', () => {
  it('has the spec columns, and only disabled_at may be null', async () => {
    const d = await fresh();
    const cols = await d.query<{ column_name: string; is_nullable: string }>(
      `SELECT column_name, is_nullable FROM information_schema.columns
        WHERE table_name = 'webhook_subscriptions' ORDER BY column_name`,
    );
    expect(cols.rows.map((c) => c.column_name)).toEqual([
      'created_at',
      'disabled_at',
      'event_types',
      'id',
      'owner_id',
      'owner_kind',
      'signing_secret',
      'updated_at',
      'url',
    ]);
    expect(cols.rows.filter((c) => c.is_nullable === 'YES').map((c) => c.column_name)).toEqual([
      'disabled_at',
    ]);
  });

  it('stores a buyer, a publisher and an operator subscription with the events each may have', async () => {
    const d = await fresh();
    await sub(d, { id: 'wsb_1', event_types: ['order.paid', 'entitlement.granted'] });
    await sub(d, {
      id: 'wsb_2',
      owner_kind: 'publisher',
      owner_id: 'pub_a',
      event_types: ['sale.recorded', 'refund.completed'],
    });
    await sub(d, {
      id: 'wsb_3',
      owner_kind: 'operator',
      owner_id: 'opr_a',
      event_types: ['settlement.completed'],
    });
    const n = await d.query<{ n: string }>('SELECT count(*)::text AS n FROM webhook_subscriptions');
    expect(n.rows[0]!.n).toBe('3');
  });

  it('refuses, in the database itself, an event type the owner kind may not have', async () => {
    const d = await fresh();
    await expect(sub(d, { id: 'wsb_x1', event_types: ['sale.recorded'] })).rejects.toThrow();
    await expect(
      sub(d, { id: 'wsb_x2', event_types: ['order.paid', 'sale.recorded'] }),
    ).rejects.toThrow();
    await expect(
      sub(d, {
        id: 'wsb_x3',
        owner_kind: 'publisher',
        owner_id: 'pub_a',
        event_types: ['order.paid'],
      }),
    ).rejects.toThrow();
    await expect(
      sub(d, {
        id: 'wsb_x4',
        owner_kind: 'operator',
        owner_id: 'opr_a',
        event_types: ['sale.recorded'],
      }),
    ).rejects.toThrow();
    await expect(sub(d, { id: 'wsb_x5', event_types: ['payout.sent'] })).rejects.toThrow();
    await expect(sub(d, { id: 'wsb_x6', event_types: [] })).rejects.toThrow();
  });

  it('refuses a system owner, a duplicate id, a plain http or non https url and a malformed secret', async () => {
    const d = await fresh();
    await sub(d);
    await expect(sub(d)).rejects.toThrow();
    await expect(sub(d, { id: 'wsb_s', owner_kind: 'system' })).rejects.toThrow();
    for (const url of [
      'http://hooks.example.com/um',
      'ftp://hooks.example.com',
      '',
      'hooks.example.com',
    ]) {
      await expect(sub(d, { id: 'wsb_u', url }), url).rejects.toThrow();
    }
    for (const secret of [
      '',
      'whsec_',
      'plain',
      SECRET.slice(0, -1),
      `${SECRET}0`,
      'ab'.repeat(32),
      SECRET.toUpperCase(),
    ]) {
      await expect(sub(d, { id: 'wsb_k', secret }), secret).rejects.toThrow();
    }
  });
});

describe('webhook_deliveries', () => {
  async function seeded(): Promise<Db> {
    const d = await fresh();
    await event(d);
    await event(d, 'evt_b');
    await sub(d);
    await sub(d, { id: 'wsb_b', owner_id: 'buy_b' });
    return d;
  }

  it('has the spec columns, and only next_at and last_error may be null', async () => {
    const d = await fresh();
    const cols = await d.query<{ column_name: string; is_nullable: string }>(
      `SELECT column_name, is_nullable FROM information_schema.columns
        WHERE table_name = 'webhook_deliveries' ORDER BY column_name`,
    );
    expect(cols.rows.map((c) => c.column_name)).toEqual([
      'attempt',
      'created_at',
      'event_id',
      'id',
      'last_error',
      'next_at',
      'status',
      'subscription_id',
      'updated_at',
    ]);
    expect(cols.rows.filter((c) => c.is_nullable === 'YES').map((c) => c.column_name)).toEqual([
      'last_error',
      'next_at',
    ]);
  });

  it('one delivery per event and subscription: a replay cannot add a second', async () => {
    const d = await seeded();
    await delivery(d);
    await expect(delivery(d, { id: 'wdl_dup' })).rejects.toThrow();
    await delivery(d, { id: 'wdl_b', subscription_id: 'wsb_b' });
    await delivery(d, { id: 'wdl_c', event_id: 'evt_b' });
  });

  it('points at an event and a subscription that exist', async () => {
    const d = await seeded();
    await expect(delivery(d, { event_id: 'evt_missing' })).rejects.toThrow();
    await expect(delivery(d, { subscription_id: 'wsb_missing' })).rejects.toThrow();
  });

  it('has the four statuses, a next time exactly while a try is still to come, and closed error codes', async () => {
    const d = await seeded();
    await expect(delivery(d, { status: 'sent' })).rejects.toThrow();
    await expect(delivery(d, { attempt: -1 })).rejects.toThrow();
    // pending and failed need a next time; delivered and dead have none
    await expect(delivery(d, { status: 'pending', next_at: null })).rejects.toThrow();
    await expect(
      delivery(d, { status: 'failed', next_at: null, attempt: 1, last_error: 'timeout' }),
    ).rejects.toThrow();
    await expect(delivery(d, { status: 'delivered', next_at: T, attempt: 1 })).rejects.toThrow();
    await expect(
      delivery(d, { status: 'dead', next_at: T, attempt: 6, last_error: 'timeout' }),
    ).rejects.toThrow();
    await delivery(d, { id: 'wdl_1', status: 'delivered', next_at: null, attempt: 1 });
    await delivery(d, {
      id: 'wdl_2',
      event_id: 'evt_b',
      status: 'dead',
      next_at: null,
      attempt: 6,
      last_error: 'http_5xx',
    });
    for (const code of [
      'timeout',
      'connection',
      'http_4xx',
      'http_5xx',
      'sender_error',
      'subscription_disabled',
    ]) {
      await d.query('DELETE FROM webhook_deliveries WHERE id = $1', ['wdl_code']);
      await delivery(d, {
        id: 'wdl_code',
        subscription_id: 'wsb_b',
        status: 'failed',
        attempt: 1,
        last_error: code,
      });
    }
    await expect(
      delivery(d, {
        id: 'wdl_free',
        subscription_id: 'wsb_b',
        event_id: 'evt_b',
        status: 'failed',
        attempt: 1,
        last_error: 'ECONNRESET https://hooks.example.com',
      }),
    ).rejects.toThrow();
  });
});

describe('webhook_fanout and the outbox', () => {
  it('marks an event once, and only an event that exists', async () => {
    const d = await fresh();
    await event(d);
    await d.query(
      `INSERT INTO webhook_fanout (event_id, created_at, updated_at) VALUES ('evt_a', $1, $1)`,
      [T],
    );
    await expect(
      d.query(
        `INSERT INTO webhook_fanout (event_id, created_at, updated_at) VALUES ('evt_a', $1, $1)`,
        [T],
      ),
    ).rejects.toThrow();
    await expect(
      d.query(
        `INSERT INTO webhook_fanout (event_id, created_at, updated_at) VALUES ('evt_nope', $1, $1)`,
        [T],
      ),
    ).rejects.toThrow();
  });

  it('event_outbox stays append-only', async () => {
    const d = await fresh();
    await event(d);
    await expect(
      d.query(`UPDATE event_outbox SET type = 'sale.recorded' WHERE id = 'evt_a'`),
    ).rejects.toThrow(/append-only/);
    await expect(d.query(`DELETE FROM event_outbox WHERE id = 'evt_a'`)).rejects.toThrow(
      /append-only/,
    );
  });
});
