// API-W0 (F1, F3): migration 0019 adds api_keys and event_outbox. Forward-only, no defaults, system only
// (the Supabase policy is a listed follow-up, Supabase is unused, D-049). Tolerates later migrations; MC-V2 took 0017 (fx rates) and MC2-L5 took 0018, so the API-W0 migration is 0019.
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
const FILE = '0019_api_keys.sql';
const HASH = 'a'.repeat(64);
const buyer = (d: Db, id: string) =>
  d.query(
    `INSERT INTO buyers (id, display_name, auth_subject, country, created_at, updated_at)
     VALUES ($1, 'B', $2, 'GB', $3, $3)`,
    [id, `account:${id}`, T],
  );
interface KeyOver {
  id?: string;
  owner_kind?: string;
  owner_id?: string;
  key_kind?: string;
  agent_buyer_id?: string | null;
  scopes?: string[];
  hash?: string;
}
const key = (d: Db, o: KeyOver = {}) =>
  d.query(
    `INSERT INTO api_keys (id, owner_kind, owner_id, key_kind, agent_buyer_id, scopes, secret_hash, created_at, revoked_at, last_used_at)
     VALUES ($1, $2, $3, $4, $5, $6::text[], $7, $8, NULL, NULL)`,
    [
      o.id ?? 'key_a',
      o.owner_kind ?? 'publisher',
      o.owner_id ?? 'pub_a',
      o.key_kind ?? 'api_client',
      o.agent_buyer_id === undefined ? null : o.agent_buyer_id,
      o.scopes ?? ['catalogue:read'],
      o.hash ?? HASH,
      T,
    ],
  );

describe('migration 0019', () => {
  it('is applied once, after 0018, with no down step, no default and no now()', async () => {
    const d = await openDatabase({ kind: 'pglite-memory' });
    toClose.push(d);
    const first = await migrate(d, clock);
    expect(first).toContain('0019_api_keys');
    expect(first.indexOf('0019_api_keys')).toBeGreaterThan(
      first.indexOf('0018_buyer_display_currency'),
    );
    expect(await migrate(d, clock)).toEqual([]);
    const dir = new URL('../migrations/common/', import.meta.url);
    expect(readdirSync(dir).filter((n) => /^0019_.*(down|rollback)/i.test(n))).toEqual([]);
    const sql = readFileSync(new URL(FILE, dir), 'utf8').replace(/--.*$/gm, '');
    expect(sql).not.toMatch(/\bDEFAULT\b/i);
    expect(sql).not.toMatch(/\bnow\s*\(/i);
  });

  it('says in its header that Supabase row level security is a hard prerequisite before any Supabase use', () => {
    const raw = readFileSync(new URL(`../migrations/common/${FILE}`, import.meta.url), 'utf8');
    const header = raw.split('CREATE TABLE')[0]!.replace(/\s+/g, ' ');
    expect(header).toMatch(/hard prerequisite/i);
    expect(header).toMatch(/row.level security/i);
    expect(header).toMatch(/before any Supabase use/i);
  });

  it('api_keys has the spec columns and only revoked_at, last_used_at and agent_buyer_id may be null', async () => {
    const d = await fresh();
    const cols = await d.query<{ column_name: string; is_nullable: string }>(
      `SELECT column_name, is_nullable FROM information_schema.columns
        WHERE table_name = 'api_keys' ORDER BY column_name`,
    );
    expect(cols.rows.map((c) => c.column_name)).toEqual([
      'agent_buyer_id',
      'created_at',
      'id',
      'key_kind',
      'last_used_at',
      'owner_id',
      'owner_kind',
      'revoked_at',
      'scopes',
      'secret_hash',
    ]);
    expect(cols.rows.filter((c) => c.is_nullable === 'YES').map((c) => c.column_name)).toEqual([
      'agent_buyer_id',
      'last_used_at',
      'revoked_at',
    ]);
  });

  it('stores a publisher key, refuses a duplicate id, an empty scope list and a bad hash', async () => {
    const d = await fresh();
    await key(d);
    await expect(key(d)).rejects.toThrow();
    await expect(key(d, { id: 'key_b', scopes: [] })).rejects.toThrow();
    for (const hash of ['', 'A'.repeat(64), 'a'.repeat(63), 'g'.repeat(64), 'plain-secret-value']) {
      await expect(key(d, { id: 'key_c', hash }), hash).rejects.toThrow();
    }
    await expect(key(d, { id: 'key_d', owner_kind: 'system' })).rejects.toThrow();
    await expect(key(d, { id: 'key_e', key_kind: 'root' })).rejects.toThrow();
  });

  it('an agent key belongs to a buyer who exists, and only an agent key names a buyer', async () => {
    const d = await fresh();
    await buyer(d, 'buy_a');
    await key(d, {
      id: 'key_agent',
      owner_kind: 'buyer',
      owner_id: 'buy_a',
      key_kind: 'agent',
      agent_buyer_id: 'buy_a',
      scopes: ['agent:buy'],
    });
    // unknown buyer
    await expect(
      key(d, {
        id: 'key_x1',
        owner_kind: 'buyer',
        owner_id: 'buy_ghost',
        key_kind: 'agent',
        agent_buyer_id: 'buy_ghost',
      }),
    ).rejects.toThrow();
    // agent key without a buyer
    await expect(
      key(d, { id: 'key_x2', owner_kind: 'buyer', owner_id: 'buy_a', key_kind: 'agent' }),
    ).rejects.toThrow();
    // api_client key that names an agent buyer
    await expect(
      key(d, {
        id: 'key_x3',
        owner_kind: 'buyer',
        owner_id: 'buy_a',
        key_kind: 'api_client',
        agent_buyer_id: 'buy_a',
      }),
    ).rejects.toThrow();
    // agent key owned by a publisher, or naming a different buyer than its owner
    await buyer(d, 'buy_b');
    await expect(
      key(d, {
        id: 'key_x4',
        owner_kind: 'publisher',
        owner_id: 'pub_a',
        key_kind: 'agent',
        agent_buyer_id: 'buy_a',
      }),
    ).rejects.toThrow();
    await expect(
      key(d, {
        id: 'key_x5',
        owner_kind: 'buyer',
        owner_id: 'buy_a',
        key_kind: 'agent',
        agent_buyer_id: 'buy_b',
      }),
    ).rejects.toThrow();
  });

  it('round-trips the scopes as an array and lets revoke and use stamps change in place', async () => {
    const d = await fresh();
    await key(d, { scopes: ['catalogue:read', 'sales:read'] });
    const row = await d.query<{ scopes: string[] }>('SELECT scopes FROM api_keys WHERE id = $1', [
      'key_a',
    ]);
    expect([...row.rows[0]!.scopes].sort()).toEqual(['catalogue:read', 'sales:read']);
    await d.query('UPDATE api_keys SET revoked_at = $2, last_used_at = $2 WHERE id = $1', [
      'key_a',
      T,
    ]);
    const after = await d.query<{ revoked_at: unknown }>(
      'SELECT revoked_at FROM api_keys WHERE id = $1',
      ['key_a'],
    );
    expect(after.rows[0]!.revoked_at).not.toBeNull();
  });

  it('event_outbox has id, type, payload and occurred_at, and nothing else', async () => {
    const d = await fresh();
    const cols = await d.query<{ column_name: string; is_nullable: string }>(
      `SELECT column_name, is_nullable FROM information_schema.columns
        WHERE table_name = 'event_outbox' ORDER BY column_name`,
    );
    expect(cols.rows.map((c) => c.column_name)).toEqual(['id', 'occurred_at', 'payload', 'type']);
    expect(cols.rows.every((c) => c.is_nullable === 'NO')).toBe(true);
  });

  it('event_outbox takes a json payload, refuses a duplicate id and a null payload, and keeps order by time then id', async () => {
    const d = await fresh();
    const ins = (id: string, at: string, payload: string | null = '{"a":1}') =>
      d.query(
        `INSERT INTO event_outbox (id, type, payload, occurred_at) VALUES ($1, 'order.paid', $2::jsonb, $3)`,
        [id, payload, at],
      );
    await ins('evt_b', '2026-11-04T10:00:01Z');
    await ins('evt_a', '2026-11-04T10:00:00Z');
    await expect(ins('evt_a', '2026-11-04T10:00:00Z')).rejects.toThrow();
    await expect(ins('evt_c', T, null)).rejects.toThrow();
    const r = await d.query<{ id: string }>('SELECT id FROM event_outbox ORDER BY occurred_at, id');
    expect(r.rows.map((x) => x.id)).toEqual(['evt_a', 'evt_b']);
  });

  it('event_outbox is append-only: update and delete are refused', async () => {
    const d = await fresh();
    await d.query(
      `INSERT INTO event_outbox (id, type, payload, occurred_at) VALUES ('evt_1', 'order.paid', '{}'::jsonb, $1)`,
      [T],
    );
    await expect(
      d.query(`UPDATE event_outbox SET type = 'sale.recorded' WHERE id = 'evt_1'`),
    ).rejects.toThrow(/append-only/);
    await expect(d.query(`DELETE FROM event_outbox WHERE id = 'evt_1'`)).rejects.toThrow(
      /append-only/,
    );
  });
});
