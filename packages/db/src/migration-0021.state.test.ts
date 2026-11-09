// API-B (G1): migration 0021 adds the mandate tables, the agent purchase claims and the agent_buy_enabled
// switch (off). Number is the next free one on main at merge time.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { fakeClock } from '@umsbx/runtime';
import type { Database } from '@umsbx/contracts';
import { migrate, openDatabase } from './index';

let db: Database & { close(): Promise<void> };
beforeAll(async () => {
  db = await openDatabase({ kind: 'pglite-memory' });
  await migrate(db, fakeClock('2026-11-04T10:00:00.000Z'));
  await db.query(
    `INSERT INTO buyers (id, display_name, auth_subject, country, created_at, updated_at)
     VALUES ('buy_m', 'm', 'sub-m', 'US', now(), now())`,
  );
  await db.query(
    `INSERT INTO api_keys (id, owner_kind, owner_id, key_kind, agent_buyer_id, scopes, secret_hash, created_at)
     VALUES ('key_m', 'buyer', 'buy_m', 'agent', 'buy_m', ARRAY['agent:buy'], '${'a'.repeat(64)}', now())`,
  );
});
afterAll(() => db.close());

const insert = (over: Record<string, unknown> = {}) => {
  const row: Record<string, unknown> = {
    id: 'man_1',
    buyer_id: 'buy_m',
    agent_key_id: 'key_m',
    currency: 'USD',
    max_total_minor: 500,
    max_count: null,
    max_per_purchase_minor: null,
    expires_at: '2026-12-04T10:00:00Z',
    revoked_at: null,
    spent_minor: 0,
    used_count: 0,
    exhausted_at: null,
    created_at: '2026-11-04T10:00:00Z',
    updated_at: '2026-11-04T10:00:00Z',
    ...over,
  };
  const cols = Object.keys(row);
  return db.query(
    `INSERT INTO mandates (${cols.join(', ')}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(', ')})`,
    cols.map((c) => row[c]),
  );
};

describe('mandates', () => {
  it('stores a mandate with at least one cap', async () => {
    await insert();
    await insert({
      id: 'man_2',
      agent_key_id: 'key_m',
      revoked_at: '2026-11-04T11:00:00Z',
      max_total_minor: null,
      max_count: 2,
    });
  });
  it('refuses a mandate with no cap, a zero cap, or spend past a cap', async () => {
    await expect(
      insert({
        id: 'man_x1',
        max_total_minor: null,
        max_count: null,
        revoked_at: '2026-11-04T11:00:00Z',
      }),
    ).rejects.toThrow();
    await expect(
      insert({ id: 'man_x2', max_total_minor: 0, revoked_at: '2026-11-04T11:00:00Z' }),
    ).rejects.toThrow();
    await expect(
      insert({ id: 'man_x3', spent_minor: 501, revoked_at: '2026-11-04T11:00:00Z' }),
    ).rejects.toThrow();
    await expect(
      insert({ id: 'man_x4', max_count: 1, used_count: 2, revoked_at: '2026-11-04T11:00:00Z' }),
    ).rejects.toThrow();
  });
  it('allows one open (not revoked) mandate per agent key', async () => {
    await expect(insert({ id: 'man_dup' })).rejects.toThrow();
  });
  it('needs a real buyer and a real key', async () => {
    await expect(
      insert({ id: 'man_y1', buyer_id: 'buy_none', revoked_at: '2026-11-04T11:00:00Z' }),
    ).rejects.toThrow();
    await expect(
      insert({ id: 'man_y2', agent_key_id: 'key_none', revoked_at: '2026-11-04T11:00:00Z' }),
    ).rejects.toThrow();
  });
});

describe('mandate_reservations', () => {
  const res = (over: Record<string, unknown> = {}) => {
    const row: Record<string, unknown> = {
      id: 'rsv_1',
      mandate_id: 'man_1',
      order_id: null,
      amount_minor: 10,
      state: 'held',
      created_at: '2026-11-04T10:00:00Z',
      settled_at: null,
      ...over,
    };
    const cols = Object.keys(row);
    return db.query(
      `INSERT INTO mandate_reservations (${cols.join(', ')}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(', ')})`,
      cols.map((c) => row[c]),
    );
  };
  it('stores a held reservation and refuses a bad state, a zero amount or an unknown mandate', async () => {
    await res();
    await expect(res({ id: 'rsv_2', state: 'paid' })).rejects.toThrow();
    await expect(res({ id: 'rsv_3', amount_minor: 0 })).rejects.toThrow();
    await expect(res({ id: 'rsv_4', mandate_id: 'man_none' })).rejects.toThrow();
  });
});

describe('agent_purchases', () => {
  it('keys a claim by agent key and idempotency key, once', async () => {
    const claim = () =>
      db.query(
        `INSERT INTO agent_purchases (agent_key_id, idempotency_key, request_hash, state, result, created_at, updated_at)
         VALUES ('key_m', 'idem-key-1', '${'b'.repeat(64)}', 'pending', NULL, now(), now())`,
      );
    await claim();
    await expect(claim()).rejects.toThrow();
  });
});

describe('the agent_buy_enabled switch', () => {
  it('exists and is off', async () => {
    const r = await db.query<{ on: boolean }>(
      'SELECT "on" FROM safety_switches WHERE name = \'agent_buy_enabled\'',
    );
    expect(r.rows).toEqual([{ on: false }]);
  });
  it('the other switches keep their seed values (0035 adds web_import_enabled, off)', async () => {
    const r = await db.query<{ name: string; on: boolean }>(
      'SELECT name, "on" FROM safety_switches ORDER BY name',
    );
    expect(Object.fromEntries(r.rows.map((x) => [x.name, x.on]))).toEqual({
      agent_buy_enabled: false,
      ai_enabled: true,
      checkout_enabled: true,
      paypal_outbound: false,
      refunds_enabled: true,
      unlock_enabled: true,
      web_import_enabled: false,
      webhook_enabled: true,
    });
  });
  it('still refuses a switch name that is not on the list, and a delete', async () => {
    await expect(
      db.query(
        "INSERT INTO safety_switches (name, \"on\", changed_by, changed_at, reason, created_at, updated_at) VALUES ('live', true, 'x', now(), 'x', now(), now())",
      ),
    ).rejects.toThrow();
    await expect(
      db.query("DELETE FROM safety_switches WHERE name = 'agent_buy_enabled'"),
    ).rejects.toThrow();
  });
});
