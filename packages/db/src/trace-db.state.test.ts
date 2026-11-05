// INT-TR0 / TR0.2: withTraceDb. A context carried by the caller becomes the ums.trace setting of every
// write, whether it comes through transaction, query or exec; without a context nothing changes and the
// capture trigger records an unattributed row.
import { AsyncLocalStorage } from 'node:async_hooks';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Clock, Database, SqlExecutor, TraceContext } from '@umsbx/contracts';
import { withTraceDb } from './trace-db';
import {
  allEvents,
  as,
  clock,
  ctx,
  eventsOf,
  freshDb,
  ins,
  j,
  T,
  T2,
  T3,
} from './trace-test-support';
import type { Db } from './trace-test-support';

let db: Db;
beforeAll(async () => {
  db = await freshDb();
});
afterAll(async () => {
  await db.close();
});

let n = 0;
const alert = (d: SqlExecutor, id: string) =>
  ins(d, 'alerts', {
    id,
    kind: 'unit_mismatch',
    order_id: null,
    unit_id: null,
    detail: j({ n: ++n }),
  });

describe('a write under a context is attributed to it', () => {
  it('through transaction: every field of the context lands on the event and on trace_context', async () => {
    const c = ctx({
      channel: 'mcp',
      actor_kind: 'agent',
      actor_id: 'key_9',
      on_behalf_of: 'buy_9',
      mandate_id: 'man_9',
      mfa: false,
      req_id: 'req_tx',
      ip_hash: 'e'.repeat(32),
      ua_family: 'sdk',
      api_key_id: 'key_9',
      tool: 'buy_unit',
    });
    await as(db, c).transaction(async (tx) => alert(tx, 'alr_tx'));
    const [e] = await eventsOf(db, 'alerts', 'alr_tx');
    expect(e).toMatchObject({
      actor_kind: 'agent',
      actor_id: 'key_9',
      on_behalf_of: 'buy_9',
      mandate_id: 'man_9',
      mfa: false,
      channel: 'mcp',
      ctx_id: c.id,
      event_type: 'alerts.created',
    });
    const row = await db.query('SELECT * FROM trace_context WHERE id = $1', [c.id]);
    expect(row.rows).toHaveLength(1);
    expect(row.rows[0]).toMatchObject({
      channel: 'mcp',
      actor_kind: 'agent',
      actor_id: 'key_9',
      on_behalf_of: 'buy_9',
      mandate_id: 'man_9',
      mfa: false,
      req_id: 'req_tx',
      ip_hash: 'e'.repeat(32),
      ua_family: 'sdk',
      api_key_id: 'key_9',
      tool: 'buy_unit',
    });
  });

  it('through a bare exec (several statements): attributed', async () => {
    const c = ctx({ channel: 'cli', actor_id: 'cli:abc' });
    await as(db, c).exec(
      `INSERT INTO alerts (id, kind, order_id, unit_id, detail, created_at, updated_at)
       VALUES ('alr_x1', 'k', NULL, NULL, '{"a":1,"reason":"x1"}', '${T}', '${T}'),
              ('alr_x2', 'k', NULL, NULL, '{"a":2,"reason":"x2"}', '${T}', '${T}')`,
    );
    for (const id of ['alr_x1', 'alr_x2']) {
      const [e] = await eventsOf(db, 'alerts', id);
      expect(e).toMatchObject({
        actor_kind: 'operator',
        actor_id: 'cli:abc',
        ctx_id: c.id,
        channel: 'cli',
      });
    }
  });

  it('through a bare query that writes: attributed', async () => {
    const c = ctx({
      channel: 'job',
      actor_kind: 'system',
      actor_id: null,
      mfa: false,
      job: 'pass',
    });
    await alert(as(db, c), 'alr_q');
    const [e] = await eventsOf(db, 'alerts', 'alr_q');
    expect(e).toMatchObject({ actor_kind: 'system', actor_id: null, channel: 'job', ctx_id: c.id });
  });

  it('a WITH query that writes is still wrapped', async () => {
    const c = ctx();
    await as(db, c).query(
      `WITH x AS (INSERT INTO alerts (id, kind, order_id, unit_id, detail, created_at, updated_at)
                  VALUES ('alr_cte', 'k', NULL, NULL, '{"reason":"cte"}', '${T}', '${T}') RETURNING id)
       SELECT id FROM x`,
    );
    const [e] = await eventsOf(db, 'alerts', 'alr_cte');
    expect(e!.ctx_id).toBe(c.id);
  });

  it('a read does not open a transaction of its own', async () => {
    let transactions = 0;
    const spy: Database = {
      dialect: db.dialect,
      query: (s, p) => db.query(s, p),
      exec: (s) => db.exec(s),
      transaction: (fn) => {
        transactions += 1;
        return db.transaction(fn);
      },
    };
    const traced = withTraceDb(spy, () => ctx(), clock);
    await traced.query('SELECT 1 AS one');
    await traced.query('  select count(*) from alerts');
    expect(transactions).toBe(0);
    await traced.exec(
      "INSERT INTO alerts (id, kind, detail, created_at, updated_at) VALUES ('alr_spy', 'k', '{\"reason\":\"spy\"}', '" +
        T +
        "', '" +
        T +
        "')",
    );
    expect(transactions).toBe(1);
  });

  it('the context row is written once per context, on its first write, and only when something is journaled', async () => {
    const c = ctx();
    const traced = as(db, c);
    await traced.query('SELECT 1');
    expect((await db.query('SELECT 1 FROM trace_context WHERE id = $1', [c.id])).rows).toHaveLength(
      0,
    );
    await alert(traced, 'alr_once_1');
    await alert(traced, 'alr_once_2');
    expect((await db.query('SELECT 1 FROM trace_context WHERE id = $1', [c.id])).rows).toHaveLength(
      1,
    );
    const [a] = await eventsOf(db, 'alerts', 'alr_once_1');
    const [b] = await eventsOf(db, 'alerts', 'alr_once_2');
    expect(a!.ctx_id).toBe(c.id);
    expect(b!.ctx_id).toBe(c.id);
  });

  it('a rolled back transaction leaves no event and no context row', async () => {
    const c = ctx();
    await expect(
      as(db, c).transaction(async (tx) => {
        await alert(tx, 'alr_rb');
        throw new Error('undo');
      }),
    ).rejects.toThrow('undo');
    expect(await eventsOf(db, 'alerts', 'alr_rb')).toEqual([]);
    expect((await db.query('SELECT 1 FROM trace_context WHERE id = $1', [c.id])).rows).toHaveLength(
      0,
    );
  });

  it('occurred_at falls back to the clock at the time of the write, not to the context open time', async () => {
    let now = T2;
    const moving: Clock = { now: () => new Date(now) };
    const c = ctx({ at: T });
    const traced = withTraceDb(db, () => c, moving);
    // changed_at stays the same, only the hashed reason changes: the time column is unchanged.
    await traced.query(
      `UPDATE safety_switches SET reason = 'first', updated_at = '${T2}' WHERE name = 'ai_enabled'`,
    );
    now = T3;
    await traced.query(
      `UPDATE safety_switches SET reason = 'second', updated_at = '${T3}' WHERE name = 'ai_enabled'`,
    );
    const events = (await eventsOf(db, 'safety_switches', 'ai_enabled')).filter(
      (e) => e.ctx_id === c.id,
    );
    expect(events.map((e) => e.occurred_at)).toEqual([
      '2026-11-04T11:00:00Z',
      '2026-11-04T12:00:00Z',
    ]);
    expect(c.at).toBe(T);
  });

  it('after a traced statement the setting is gone: the next plain statement is unattributed', async () => {
    await alert(as(db, ctx()), 'alr_after_1');
    await alert(db, 'alr_after_2');
    const [e] = await eventsOf(db, 'alerts', 'alr_after_2');
    expect(e).toMatchObject({
      actor_kind: 'unattributed',
      ctx_id: null,
      channel: null,
      actor_id: null,
      mfa: false,
    });
  });
});

describe('without a context calls pass through unchanged', () => {
  it('get() returning undefined leaves the database as it was: the write is unattributed', async () => {
    await alert(
      withTraceDb(db, () => undefined, clock),
      'alr_none',
    );
    const [e] = await eventsOf(db, 'alerts', 'alr_none');
    expect(e).toMatchObject({ actor_kind: 'unattributed', ctx_id: null, channel: null });
  });

  it('keeps the other members of the driver (close, target)', () => {
    const traced = withTraceDb(db, () => undefined, clock);
    expect(typeof traced.close).toBe('function');
    expect(traced.dialect).toBe(db.dialect);
  });
});

describe('100 interleaved promises never mix contexts', () => {
  it('each write carries the context of the promise that made it', async () => {
    const store = new AsyncLocalStorage<TraceContext>();
    const traced = withTraceDb(db, () => store.getStore(), clock);
    const contexts = Array.from({ length: 100 }, (_, i) =>
      ctx({ actor_kind: 'buyer', actor_id: `buy_${i}`, req_id: `req_iv_${i}` }),
    );
    await Promise.all(
      contexts.map((c, i) =>
        store.run(c, async () => {
          await new Promise<void>((r) => setTimeout(r, (i * 3) % 7));
          if (i % 2 === 0) await alert(traced, `alr_iv_${i}`);
          else await traced.transaction(async (tx) => alert(tx, `alr_iv_${i}`));
        }),
      ),
    );
    const wrong: string[] = [];
    for (let i = 0; i < 100; i += 1) {
      const [e] = await eventsOf(db, 'alerts', `alr_iv_${i}`);
      if (e?.ctx_id !== contexts[i]!.id || e.actor_id !== `buy_${i}`) wrong.push(`alr_iv_${i}`);
    }
    expect(wrong).toEqual([]);
    expect((await allEvents(db)).filter((e) => e.source_id.startsWith('alr_iv_'))).toHaveLength(
      100,
    );
  });
});
