// INT-TR0 / TR0.5: nothing personal and no free text reaches the journal. The world writes a canary into
// every free-text and jsonb detail column of the tracked tables; none of them may appear anywhere in
// trace_events or trace_context, in any form but its sha256, and the context never carries a name, a raw
// IP address or a User-Agent string.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { TraceContext } from '@umsbx/contracts';
import {
  CANARIES,
  HASH,
  HASH2,
  as,
  eventsOf,
  freshDb,
  ctx,
  ins,
  j,
  seedWorld,
  updateWorld,
} from './trace-test-support';
import type { Db } from './trace-test-support';

let db: Db;
beforeAll(async () => {
  db = await freshDb();
  await seedWorld(db);
  await updateWorld(db);
});
afterAll(async () => {
  await db.close();
});

const sha = async (text: string): Promise<string> =>
  (
    await db.query<{ h: string }>("SELECT encode(sha256(convert_to($1, 'UTF8')), 'hex') AS h", [
      text,
    ])
  ).rows[0]!.h;

const dump = async (table: string): Promise<string> =>
  (
    await db.query<{ t: string }>(
      `SELECT coalesce(string_agg(x::text, E'\\n'), '') AS t FROM ${table} x`,
    )
  ).rows[0]!.t;

describe('canaries never appear', () => {
  it('not one canary string is in trace_events, trace_context, trace_heads or trace_seals', async () => {
    const found: string[] = [];
    for (const table of ['trace_events', 'trace_context', 'trace_heads', 'trace_seals']) {
      const text = await dump(table);
      for (const canary of CANARIES) if (text.includes(canary)) found.push(`${table}: ${canary}`);
      // The word CANARY itself, in case a canary was truncated or re-cased.
      if (/canary/i.test(text)) found.push(`${table}: canary (any case)`);
    }
    expect(found).toEqual([]);
  });

  it('every canary is in a column of its table, so the test above is not vacuous', async () => {
    const tables = [
      'approvals',
      'provider_calls',
      'refund_requests',
      'receipts',
      'access_events',
      'recovery_cases',
      'recovery_actions',
      'alerts',
      'audit_log',
      'safety_switches',
      'payee_change_requests',
      'payee_decisions',
      'publisher_applicant_decisions',
      'rule_settings',
    ];
    let all = '';
    for (const t of tables) all += await dump(t);
    for (const canary of CANARIES) expect(all, canary).toContain(canary);
  });

  it('a hashed column holds sha256 of the column’s text and nothing else', async () => {
    const [e] = (await eventsOf(db, 'refund_requests', 'rfr_1')).slice(0, 1);
    expect(e!.body.hashed['reason']![1]).toBe(await sha('CANARY-REFUND-REASON'));
    const sw = (await eventsOf(db, 'safety_switches', 'paypal_outbound')).at(-1)!;
    expect(sw.body.hashed['reason']![1]).toBe(await sha('CANARY-SWITCH-REASON'));
  });

  it('a hashed jsonb column is hashed over its text, so the same detail gives the same hash and a change gives another', async () => {
    // The world updates alr_1's detail once: the first event hashes the original, the last the current text.
    const events = await eventsOf(db, 'alerts', 'alr_1');
    expect(events[0]!.body.hashed['detail']![1]).not.toBe(events.at(-1)!.body.hashed['detail']![1]);
    const a = events.at(-1)!;
    const hash = String(a.body.hashed['detail']![1]);
    expect(hash).toMatch(/^[a-f0-9]{64}$/);
    expect(hash).toBe(
      await sha(
        (await db.query<{ t: string }>("SELECT detail::text AS t FROM alerts WHERE id = 'alr_1'"))
          .rows[0]!.t,
      ),
    );
  });
});

describe('secrets and identifiers that are not on the allow-list stay out', () => {
  it('token hashes, secret hashes, nonces, merchant ids and auth subjects appear nowhere in the journal', async () => {
    const text = (await dump('trace_events')) + (await dump('trace_context'));
    for (const v of [HASH2, 'nonce1', 'MERCH1', 'MERCH2', 'sub1', 'sub2']) {
      expect(text, v).not.toContain(v);
    }
    // HASH ('aaaa...') is the content hash of approvals and the sha256 of the article: approvals.content_hash is
    // allow-listed on purpose, so it may appear there and nowhere else.
    const ev = await db.query<{ source_table: string }>(
      `SELECT DISTINCT source_table FROM trace_events WHERE body::text LIKE '%${HASH}%' ORDER BY 1`,
    );
    expect(
      ev.rows.map((r) => r.source_table).every((t) => ['approvals', 'receipts'].includes(t)),
    ).toBe(true);
  });

  it('entitlement transition_log, api key last_used_at and operation leases are not copied', async () => {
    const ent = await eventsOf(db, 'entitlements', 'ent_1');
    for (const e of ent) {
      expect(Object.keys(e.body.cols)).not.toContain('transition_log');
      expect(JSON.stringify(e.body)).not.toContain('"x":1');
    }
    for (const e of await eventsOf(db, 'api_keys', 'key_1')) {
      expect(Object.keys(e.body.cols)).not.toContain('last_used_at');
    }
  });
});

describe('the context holds ids and enums, never a person', () => {
  it('trace_context has exactly the spec columns, none of which can hold a name, an IP or a User-Agent', async () => {
    const cols = await db.query<{ column_name: string }>(
      "SELECT column_name FROM information_schema.columns WHERE table_name = 'trace_context' ORDER BY ordinal_position",
    );
    expect(cols.rows.map((c) => c.column_name)).toEqual([
      'id',
      'at',
      'channel',
      'actor_kind',
      'actor_id',
      'on_behalf_of',
      'mandate_id',
      'mfa',
      'req_id',
      'ip_hash',
      'ua_family',
      'api_key_id',
      'job',
      'tool',
    ]);
  });

  it('extra properties on a context object (ip, user agent, name, email) are dropped before they reach the database', async () => {
    const dirty = {
      ...ctx({ req_id: 'req_dirty' }),
      ip: '203.0.113.77',
      user_agent: 'CanaryBrowser/9.9 (secret-token-123)',
      name: 'Ada Lovelace',
      email: 'ada@example.com',
    } as unknown as TraceContext;
    await ins(as(db, dirty), 'alerts', {
      id: 'alr_dirty',
      kind: 'k',
      order_id: null,
      unit_id: null,
      detail: j({}),
    });
    const text = (await dump('trace_context')) + (await dump('trace_events'));
    for (const bad of [
      '203.0.113.77',
      'CanaryBrowser',
      'secret-token-123',
      'Ada Lovelace',
      'ada@example.com',
    ]) {
      expect(text, bad).not.toContain(bad);
    }
    expect(
      (await db.query("SELECT 1 FROM trace_context WHERE req_id = 'req_dirty'")).rows,
    ).toHaveLength(1);
  });

  it('the database refuses a raw IP in ip_hash and a raw User-Agent in ua_family', async () => {
    const insert = (over: Record<string, string>) =>
      db.query(
        `INSERT INTO trace_context (id, at, channel, actor_kind, mfa, ip_hash, ua_family)
         VALUES ($1, '2026-11-04T10:00:00Z', 'web', 'buyer', false, $2, $3)`,
        [over['id'], over['ip'] ?? null, over['ua'] ?? null],
      );
    await expect(insert({ id: 'ctx_raw_ip', ip: '203.0.113.77' })).rejects.toThrow();
    await expect(
      insert({ id: 'ctx_raw_ua', ua: 'Mozilla/5.0 (X11; Linux x86_64)' }),
    ).rejects.toThrow();
    await expect(
      insert({ id: 'ctx_ok', ip: 'f'.repeat(32), ua: 'browser' }),
    ).resolves.toBeDefined();
  });

  it('the database refuses an unknown actor_kind or channel in the context and in the journal', async () => {
    await expect(
      db.query(
        `INSERT INTO trace_context (id, at, channel, actor_kind, mfa) VALUES ('ctx_bad1', '2026-11-04T10:00:00Z', 'web', 'wizard', false)`,
      ),
    ).rejects.toThrow();
    await expect(
      db.query(
        `INSERT INTO trace_context (id, at, channel, actor_kind, mfa) VALUES ('ctx_bad2', '2026-11-04T10:00:00Z', 'fax', 'buyer', false)`,
      ),
    ).rejects.toThrow();
    await expect(
      db.query(
        `INSERT INTO trace_events (chain_key, seq, prev_hash, row_hash, occurred_at, actor_kind, mfa, event_type, source_table, source_id, body)
         VALUES ('plat', 9999, repeat('0', 64), repeat('1', 64), '2026-11-04T10:00:00Z', 'wizard', false, 'x.created', 'alerts', 'a', '{}')`,
      ),
    ).rejects.toThrow();
  });
});
