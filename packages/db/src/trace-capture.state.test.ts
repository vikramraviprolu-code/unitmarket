// INT-TR0 / TR0.3: the capture trigger and the guards on the journal. Each tracked table gets one insert
// and one update from the world in trace-test-support.ts; the expectations (chain, subject keys, copied
// columns, hashed columns) are written there by hand from the spec table.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { TRACKED_TABLES } from '@umsbx/contracts';
import { resetDatabase } from './testing';
import { verifyTrace } from './trace-verify';
import {
  CANARIES,
  STEPS,
  T,
  T2,
  as,
  chainOf,
  countEvents,
  ctx,
  eventsOf,
  freshDb,
  ins,
  j,
  updateWorld,
} from './trace-test-support';
import type { Db } from './trace-test-support';

const HEX64 = /^[a-f0-9]{64}$/;
let db: Db;
beforeAll(async () => {
  db = await freshDb();
});
afterAll(async () => {
  await db.close();
});

describe('the trace_tracked table is the golden list', () => {
  it('holds one row per tracked table with the same columns, hashed columns, digest columns, time column and chain', async () => {
    const r = await db.query<{
      table_name: string;
      columns: string[];
      hashed_columns: string[];
      digest_columns: string[];
      time_column: string;
      chain_expr: string;
    }>('SELECT * FROM trace_tracked ORDER BY table_name');
    expect(
      r.rows.map((x) => ({
        table: x.table_name,
        copied: x.columns,
        hashed: x.hashed_columns,
        digest: x.digest_columns,
        time: x.time_column,
        chain: x.chain_expr,
      })),
    ).toEqual(
      TRACKED_TABLES.map((t) => ({
        table: t.table,
        copied: [...t.copied],
        hashed: [...t.hashed],
        digest: [...t.digest],
        time: t.time,
        chain: t.chain,
      })),
    );
  });

  it('puts one capture trigger on each tracked table, and the world covers every one of them', async () => {
    const trig = await db.query<{ tgname: string }>(
      "SELECT tgname FROM pg_trigger WHERE NOT tgisinternal AND tgname LIKE 'trace_capture_%' ORDER BY tgname",
    );
    expect(trig.rows.map((t) => t.tgname)).toEqual(
      TRACKED_TABLES.map((t) => `trace_capture_${t.table}`).sort(),
    );
    expect(STEPS.map((s) => s.table).sort()).toEqual(TRACKED_TABLES.map((t) => t.table).sort());
  });
});

describe('an insert writes one event', () => {
  const c = ctx({ actor_kind: 'operator', actor_id: 'opr_test', channel: 'web', mfa: true });
  for (const s of STEPS.filter((x) => x.insert)) {
    it(`${s.table}: one event on ${s.chain}, with the copied values and the hashed columns only as sha256`, async () => {
      await s.insert!(as(db, c));
      const events = await eventsOf(db, s.table, s.id);
      expect(events).toHaveLength(1);
      const e = events[0]!;
      expect(e.event_type).toBe(`${s.table}.created`);
      expect(e.chain_key).toBe(s.chain);
      expect(e.source_table).toBe(s.table);
      expect(e.actor_kind).toBe('operator');
      expect(e.ctx_id).toBe(c.id);
      expect(e.body.op).toBe('insert');
      expect(e.body.n).toBe(1);
      for (const [k, v] of Object.entries(s.subject ?? {})) {
        expect(e[k as keyof typeof e], `${s.table} subject ${k}`).toBe(v);
      }
      for (const [col, v] of Object.entries(s.insertCols ?? {})) {
        expect(e.body.cols[col], `${s.table}.${col}`).toEqual([null, v]);
      }
      const tracked = TRACKED_TABLES.find((t) => t.table === s.table)!;
      expect(Object.keys(e.body.cols).sort()).toEqual([...tracked.copied].sort());
      expect(Object.keys(e.body.hashed).sort()).toEqual([...tracked.hashed].sort());
      for (const col of tracked.hashed) {
        const pair = e.body.hashed[col]!;
        expect(pair[0]).toBeNull();
        expect(pair[1] === null || HEX64.test(String(pair[1]))).toBe(true);
      }
      const text = JSON.stringify(e);
      for (const canary of CANARIES) expect(text).not.toContain(canary);
      if (tracked.digest.length > 0) expect(e.body.source_digest).toMatch(HEX64);
      else expect(e.body.source_digest).toBeUndefined();
    });
  }

  it('the seven seeded safety switches have no insert event of their own: the migration journals them', async () => {
    const e = await eventsOf(db, 'safety_switches', 'ai_enabled');
    expect(e).toHaveLength(1);
    expect(e[0]).toMatchObject({
      event_type: 'safety_switches.imported',
      actor_kind: 'system',
      channel: 'backfill',
    });
  });

  it('the world wrote one event per inserted row (the publishers step also inserts pub_2) and the migration seven', async () => {
    const inserts = STEPS.filter((s) => s.insert).length + 1;
    expect(await countEvents(db)).toBe(inserts + 7);
  });
});

describe('an update of a copied column writes [old, new]', () => {
  const c = ctx({ actor_kind: 'operator', actor_id: 'opr_upd', channel: 'web', mfa: true });
  beforeAll(async () => {
    // The world's updates run in order and some depend on earlier ones, so they run once here.
    for (const s of STEPS.filter((x) => x.update)) {
      const before = (await eventsOf(db, s.table, s.id)).length;
      await as(db, c).query(s.update!.sql, s.update!.params);
      const after = (await eventsOf(db, s.table, s.id)).length;
      expect(after, `${s.table} update`).toBe(before + 1);
    }
  });

  for (const s of STEPS.filter((x) => x.update)) {
    it(`${s.table}: ${s.update!.col} ${JSON.stringify(s.update!.before)} to ${JSON.stringify(s.update!.after)}`, async () => {
      const events = await eventsOf(db, s.table, s.id);
      const e = events[events.length - 1]!;
      expect(e.event_type).toBe(`${s.table}.updated`);
      expect(e.body.op).toBe('update');
      expect(e.body.n).toBe(events.length);
      expect(e.actor_id).toBe('opr_upd');
      if (s.insertHashed?.includes(s.update!.col)) {
        const pair = e.body.hashed[s.update!.col]!;
        expect(String(pair[0])).toMatch(HEX64);
        expect(String(pair[1])).toMatch(HEX64);
        expect(pair[0]).not.toBe(pair[1]);
        expect(e.body.cols).toEqual({});
      } else {
        expect(e.body.cols[s.update!.col]).toEqual([s.update!.before, s.update!.after]);
        // The switch update also sets the hashed reason and changed_by; every other step touches no hashed column.
        const hashedKeys = s.table === 'safety_switches' ? ['changed_by', 'reason'] : [];
        expect(Object.keys(e.body.hashed).sort()).toEqual(hashedKeys);
      }
    });
  }

  it('safety_switches: the switch event is on the platform chain and the reason is only a hash', async () => {
    const e = (await eventsOf(db, 'safety_switches', 'paypal_outbound')).at(-1)!;
    expect(e.chain_key).toBe('plat');
    expect(e.body.cols['on']).toEqual([false, true]);
    expect(e.body.cols['changed_at']).toEqual([
      '1970-01-01T00:00:00+00:00',
      '2026-11-04T11:00:00+00:00',
    ]);
    expect(String(e.body.hashed['reason']![1])).toMatch(HEX64);
    expect(JSON.stringify(e)).not.toContain('CANARY-SWITCH-REASON');
    expect(e.occurred_at).toBe('2026-11-04T11:00:00Z');
  });

  it('mandate_reservations: attachOrder moves the next event to the order chain; earlier events stay on the mandate chain', async () => {
    const events = await eventsOf(db, 'mandate_reservations', 'rsv_1');
    expect(events.map((e) => e.chain_key)).toEqual(['mdt:man_1', 'ord:ord_1']);
    expect(events[1]).toMatchObject({ order_id: 'ord_1', mandate_ref: 'man_1' });
    // The second event is the only reservation event on the order chain.
    const ord = await chainOf(db, 'ord:ord_1');
    expect(ord.filter((e) => e.source_table === 'mandate_reservations')).toHaveLength(1);
    // Both chains still verify.
    expect((await verifyTrace(db)).findings).toEqual([]);
  });

  it('a later reservation update stays on the order chain', async () => {
    await as(db, c).query(
      `UPDATE mandate_reservations SET state = 'committed', settled_at = '${T2}' WHERE id = 'rsv_1'`,
    );
    const events = await eventsOf(db, 'mandate_reservations', 'rsv_1');
    expect(events.map((e) => e.chain_key)).toEqual(['mdt:man_1', 'ord:ord_1', 'ord:ord_1']);
    expect(events[2]!.occurred_at).toBe('2026-11-04T11:00:00Z');
  });
});

describe('an update that changes nothing in the allow-list writes nothing', () => {
  for (const s of STEPS.filter((x) => x.untracked)) {
    it(`${s.table}: an untracked column changes, no event`, async () => {
      const before = (await eventsOf(db, s.table, s.id)).length;
      await as(db, ctx()).query(s.untracked!.sql, s.untracked!.params);
      expect((await eventsOf(db, s.table, s.id)).length).toBe(before);
    });
  }

  it('an update to the same values is not an event either', async () => {
    const before = await countEvents(db);
    await as(db, ctx()).query(
      `UPDATE orders SET status = status, total_minor = total_minor WHERE id = 'ord_1'`,
    );
    expect(await countEvents(db)).toBe(before);
  });
});

describe('occurred_at', () => {
  it('is the table time column when it is set or changes, else the clock of the write', async () => {
    const o = await eventsOf(db, 'orders', 'ord_1');
    expect(o[0]!.occurred_at).toBe('2026-11-04T10:00:00Z'); // updated_at at insert
    expect(o[1]!.occurred_at).toBe('2026-11-04T11:00:00Z'); // updated_at moved to T2 with the update
    // api_keys has no updated_at: the insert uses created_at, the revoke uses the clock in ums.trace (T2).
    const k = await eventsOf(db, 'api_keys', 'key_1');
    expect(k[0]!.occurred_at).toBe('2026-11-04T10:00:00Z');
    expect(k[1]!.occurred_at).toBe('2026-11-04T11:00:00Z');
  });
});

describe('chains that cannot be resolved fall back to the platform chain', () => {
  it('a webhook event that names no known order, a case with no order and an alert with no order', async () => {
    const t = as(db, ctx({ actor_kind: 'paypal', actor_id: null, channel: 'webhook', mfa: false }));
    await ins(t, 'webhook_events', {
      id: 'whk_x',
      event_id: 'EVX',
      transmission_id: 'TRX',
      type: 'X',
      verified: true,
      outcome: null,
      resource: j({
        capture_id: null,
        refund_id: null,
        provider_order_id: 'NOSUCHORDER',
        occurred_at: T,
      }),
      received_at: T,
      applied_at: null,
      environment: 'dryrun',
    });
    await ins(t, 'recovery_cases', {
      id: 'cas_x',
      kind: 'payment_unresolved',
      state: 'open',
      order_id: null,
      entitlement_id: null,
      buyer_id: null,
      opened_by: 'system',
      sla_due_at: T,
      credit_ms: 0,
      buyer_message: '',
    });
    await ins(t, 'alerts', {
      id: 'alr_x',
      kind: 'k',
      order_id: null,
      unit_id: null,
      detail: j({}),
    });
    for (const [table, id] of [
      ['webhook_events', 'whk_x'],
      ['recovery_cases', 'cas_x'],
      ['alerts', 'alr_x'],
    ] as const) {
      expect((await eventsOf(db, table, id))[0]!.chain_key, table).toBe('plat');
    }
  });

  it('a webhook event is resolved by its capture id or its refund id when no PayPal order is named', async () => {
    const t = as(db, ctx({ actor_kind: 'paypal', actor_id: null, channel: 'webhook', mfa: false }));
    await ins(t, 'webhook_events', {
      id: 'whk_cap',
      event_id: 'EVC',
      transmission_id: 'TRC',
      type: 'X',
      verified: true,
      outcome: null,
      resource: j({ capture_id: 'CAP1', refund_id: null, provider_order_id: null, occurred_at: T }),
      received_at: T,
      applied_at: null,
      environment: 'dryrun',
    });
    await as(db, ctx()).query(`UPDATE refund_requests SET refund_id = 'RFD1' WHERE id = 'rfr_1'`);
    await ins(t, 'webhook_events', {
      id: 'whk_rfd',
      event_id: 'EVR',
      transmission_id: 'TRR',
      type: 'X',
      verified: true,
      outcome: null,
      resource: j({ capture_id: null, refund_id: 'RFD1', provider_order_id: null, occurred_at: T }),
      received_at: T,
      applied_at: null,
      environment: 'dryrun',
    });
    expect((await eventsOf(db, 'webhook_events', 'whk_cap'))[0]!.chain_key).toBe('ord:ord_1');
    expect((await eventsOf(db, 'webhook_events', 'whk_rfd'))[0]!.chain_key).toBe('ord:ord_1');
  });
});

describe('a write with no context', () => {
  it('is stored with actor_kind unattributed, no context and no channel', async () => {
    await ins(db, 'alerts', {
      id: 'alr_bare',
      kind: 'k',
      order_id: null,
      unit_id: null,
      detail: j({}),
    });
    const [e] = await eventsOf(db, 'alerts', 'alr_bare');
    expect(e).toMatchObject({
      actor_kind: 'unattributed',
      actor_id: null,
      ctx_id: null,
      channel: null,
      mfa: false,
      on_behalf_of: null,
      mandate_id: null,
    });
  });
});

describe('the journal cannot be changed', () => {
  beforeAll(async () => {
    await db.query("SELECT trace_seal('2026-11-03'::date, '2026-11-04T00:00:00Z'::timestamptz)");
  });

  for (const table of ['trace_events', 'trace_context', 'trace_seals', 'trace_tracked']) {
    it(`${table}: UPDATE, DELETE and TRUNCATE raise`, async () => {
      const col =
        table === 'trace_events'
          ? 'seq = seq'
          : table === 'trace_context'
            ? 'job = job'
            : table === 'trace_seals'
              ? 'at = at'
              : 'time_column = time_column';
      await expect(db.query(`UPDATE ${table} SET ${col}`)).rejects.toThrow(/append-only/);
      await expect(db.query(`DELETE FROM ${table}`)).rejects.toThrow(/append-only/);
      await expect(db.query(`TRUNCATE ${table}`)).rejects.toThrow(/TRUNCATE on .* is not allowed/);
    });
  }

  it('the guards are the existing ones from migration 0001', async () => {
    const r = await db.query<{ tgname: string; fn: string }>(
      `SELECT t.tgname, p.proname AS fn FROM pg_trigger t JOIN pg_proc p ON p.oid = t.tgfoid
        WHERE NOT t.tgisinternal AND t.tgrelid IN ('trace_events'::regclass, 'trace_context'::regclass, 'trace_seals'::regclass)
        ORDER BY t.tgname`,
    );
    expect(r.rows).toEqual([
      { tgname: 'trace_context_append_only', fn: 'ums_deny_mutation' },
      { tgname: 'trace_context_no_truncate', fn: 'ums_deny_truncate' },
      { tgname: 'trace_events_append_only', fn: 'ums_deny_mutation' },
      { tgname: 'trace_events_no_truncate', fn: 'ums_deny_truncate' },
      { tgname: 'trace_seals_append_only', fn: 'ums_deny_mutation' },
      { tgname: 'trace_seals_no_truncate', fn: 'ums_deny_truncate' },
    ]);
  });
});

describe('reset and column changes', () => {
  it('resetDatabase (ums.allow_reset) empties the journal, keeps the allow-list and journaling still works after it', async () => {
    const d = await freshDb();
    try {
      await as(d, ctx()).query(
        `INSERT INTO alerts (id, kind, detail, created_at, updated_at) VALUES ('alr_r', 'k', '{"reason":"r"}', '${T}', '${T}')`,
      );
      expect(await countEvents(d)).toBeGreaterThan(0);
      await resetDatabase(d);
      expect(await countEvents(d)).toBe(0);
      expect((await d.query('SELECT count(*)::int AS n FROM trace_heads')).rows[0]).toEqual({
        n: 0,
      });
      expect(
        (await d.query<{ n: number }>('SELECT count(*)::int AS n FROM trace_tracked')).rows[0]!.n,
      ).toBe(TRACKED_TABLES.length);
      // Every lane's rows are back, 0023's and each later seed function's (alert_events is 0025's own).
      expect(
        (
          await d.query<{ t: string }>('SELECT table_name AS t FROM trace_tracked ORDER BY 1')
        ).rows.map((r) => r.t),
      ).toEqual(TRACKED_TABLES.map((t) => t.table).sort());
      await as(d, ctx()).query(
        `INSERT INTO alerts (id, kind, detail, created_at, updated_at) VALUES ('alr_r2', 'k', '{"reason":"r2"}', '${T}', '${T}')`,
      );
      expect((await eventsOf(d, 'alerts', 'alr_r2'))[0]!.seq).toBe(1);
    } finally {
      await d.close();
    }
  });

  it('adding a column to ledger_entries does not change a stored digest: verify still passes', async () => {
    const d = await freshDb();
    try {
      const { seedWorld } = await import('./trace-test-support');
      await seedWorld(d);
      await updateWorld(d);
      expect((await verifyTrace(d)).findings).toEqual([]);
      await d.exec('ALTER TABLE ledger_entries ADD COLUMN memo text');
      await d.exec('ALTER TABLE receipts ADD COLUMN memo text');
      expect((await verifyTrace(d)).findings).toEqual([]);
    } finally {
      await d.close();
    }
  });
});
