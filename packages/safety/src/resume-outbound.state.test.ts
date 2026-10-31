// WEB-OPS-START: the one shared check behind `pnpm safety:resume` and the Operations "Start PayPal"
// button. Real in-memory database, real audit sink, approval rows in the test database only.
// Nothing here reaches a network.
import { afterEach, describe, expect, it } from 'vitest';
import { migrate, openDatabase } from '@umsbx/db';
import { createAuditSink } from '@umsbx/obs';
import { fakeClock, seededIds } from '@umsbx/runtime';
import type { Actor, Database } from '@umsbx/contracts';
import { resumeOutbound, runResume } from './index';

const REF = 'DL-ops-start-1';
const SCOPE = 'mvp_b_polling';
const NOW = '2026-10-31T12:00:00Z';
const OPERATOR: Actor = { kind: 'operator', operator_id: 'opr_vikram', mfa: true };

type Db = Database & { close(): Promise<void> };
const dbs: Db[] = [];
afterEach(async () => {
  for (const d of dbs.splice(0)) await d.close();
});

async function rig(
  o: {
    approval?: false | { scope?: string; valid_until?: string; max_calls?: number };
    on?: boolean;
  } = {},
) {
  const clock = fakeClock(NOW);
  const db = (await openDatabase({ kind: 'pglite-memory' })) as Db;
  dbs.push(db);
  await migrate(db, clock);
  if (o.approval !== false) {
    const a = o.approval ?? {};
    await db.query(
      `INSERT INTO outbound_approvals (id, approval_ref, scope, operations, max_amount_minor, max_calls_per_day, valid_until, approved_by, created_at, updated_at)
       VALUES ('oap_ops_start', $1, $2, $3, 2000, $4, $5, 'test-owner', '2026-10-29T00:00:00Z', '2026-10-29T00:00:00Z')`,
      [
        REF,
        a.scope ?? SCOPE,
        ['oauth_token', 'create_order'],
        a.max_calls ?? 120,
        a.valid_until ?? '2026-11-03T12:00:00Z',
      ],
    );
  }
  await db.query(`UPDATE safety_switches SET "on" = $1 WHERE name = 'paypal_outbound'`, [
    o.on === true,
  ]);
  const audit = createAuditSink(seededIds('rs'), clock);
  const asked: string[] = [];
  const base = {
    db,
    clock,
    audit,
    by: OPERATOR as Actor,
    reason: 'tester sitting',
    approval_ref: REF as string | null,
    scope: SCOPE,
    confirm: async (row: { scope: string }) => {
      asked.push(row.scope);
      return true;
    },
  };
  const isOn = async () =>
    (
      await db.query<{ on: boolean }>(
        `SELECT "on" FROM safety_switches WHERE name = 'paypal_outbound'`,
      )
    ).rows[0]?.on === true;
  const count = async (action: string) =>
    Number(
      (
        await db.query<{ n: string }>(`SELECT count(*) AS n FROM audit_log WHERE action = $1`, [
          action,
        ])
      ).rows[0]?.n,
    );
  const spend = async (n: number) => {
    for (let i = 0; i < n; i += 1)
      await db.query(
        `INSERT INTO audit_log (id, actor_kind, actor_id, action, target, reason, detail, created_at, updated_at)
         VALUES ($1, 'system', NULL, 'gate.reserve', $2, 'reserved create_order', '{}', $3, $3)`,
        [`gres_test_${i}`, REF, '2026-10-31T09:00:00.000Z'],
      );
  };
  return { db, clock, base, asked, isOn, count, spend };
}

describe('resumeOutbound: the shared check', () => {
  it('turns the switch on, writes one safety.resume row and leaves the calls left unchanged', async () => {
    const t = await rig();
    await t.spend(6);
    const r = await resumeOutbound(t.base);
    expect(r).toEqual({
      ok: true,
      value: {
        approval_ref: REF,
        scope: SCOPE,
        calls_left: 114,
        valid_until: '2026-11-03T12:00:00.000Z',
      },
    });
    expect(await t.isOn()).toBe(true);
    expect(t.asked).toEqual([SCOPE]);
    const rows = await t.db.query<{
      actor_kind: string;
      actor_id: string;
      target: string;
      reason: string;
      detail: Record<string, unknown>;
    }>(
      `SELECT actor_kind, actor_id, target, reason, detail FROM audit_log WHERE action = 'safety.resume'`,
    );
    expect(rows.rows).toHaveLength(1);
    expect(rows.rows[0]).toMatchObject({
      actor_kind: 'operator',
      actor_id: 'opr_vikram',
      target: REF,
      reason: 'tester sitting',
    });
    expect(rows.rows[0]?.detail).toEqual({ approval_ref: REF, scope: SCOPE });
    // the switch change keeps its own row, as the CLI always wrote it
    expect(await t.count('switch.paypal_outbound.on')).toBe(1);
    // starting spends no call from the budget
    expect(await t.count('gate.reserve')).toBe(6);
  });

  it.each([
    ['no approval row', { approval: false as const }, 'no_active_approval'],
    [
      'an expired approval row',
      { approval: { valid_until: '2026-10-31T11:00:00Z' } },
      'no_active_approval',
    ],
    [
      'a row for another scope than the app serves',
      { approval: { scope: 'mvp_c_refunds' } },
      'scope_mismatch',
    ],
  ])('refuses %s and changes nothing', async (_n, o, code) => {
    const t = await rig(o);
    expect(await resumeOutbound(t.base)).toEqual({ ok: false, error: code });
    expect(t.asked).toEqual([]);
    expect(await t.isOn()).toBe(false);
    expect(await t.count('safety.resume')).toBe(0);
    expect(await t.count('switch.paypal_outbound.on')).toBe(0);
  });

  it('refuses when no approval ref is configured, or an empty or unknown one', async () => {
    const t = await rig();
    for (const ref of [null, '', '   ', 'some-other-ref']) {
      expect(await resumeOutbound({ ...t.base, approval_ref: ref })).toEqual({
        ok: false,
        error: 'no_active_approval',
      });
    }
    expect(await t.isOn()).toBe(false);
  });

  it('refuses when the calls for the day are used up, and allows the last call left', async () => {
    const t = await rig({ approval: { max_calls: 3 } });
    await t.spend(3);
    expect(await resumeOutbound(t.base)).toEqual({ ok: false, error: 'budget_used_up' });
    expect(await t.isOn()).toBe(false);
    const u = await rig({ approval: { max_calls: 3 } });
    await u.spend(2);
    const r = await resumeOutbound(u.base);
    expect(r.ok && r.value.calls_left).toBe(1);
  });

  it('refuses a blank reason before it asks anything', async () => {
    const t = await rig();
    expect(await resumeOutbound({ ...t.base, reason: '   ' })).toEqual({
      ok: false,
      error: 'reason_required',
    });
    expect(t.asked).toEqual([]);
    expect(await t.isOn()).toBe(false);
  });

  it('refuses when the typed scope is not confirmed, and writes nothing', async () => {
    const t = await rig();
    expect(await resumeOutbound({ ...t.base, confirm: async () => false })).toEqual({
      ok: false,
      error: 'scope_not_confirmed',
    });
    expect(await t.isOn()).toBe(false);
    expect(await t.count('safety.resume')).toBe(0);
  });

  it.each<[string, Actor]>([
    [
      'an operator without the second factor',
      { kind: 'operator', operator_id: 'opr_demo', mfa: false },
    ],
    ['a buyer', { kind: 'buyer', buyer_id: 'buyer_a' } as Actor],
    ['the system actor', { kind: 'system' }],
  ])('refuses %s', async (_n, by) => {
    const t = await rig();
    expect(await resumeOutbound({ ...t.base, by })).toEqual({
      ok: false,
      error: 'operator_required',
    });
    expect(t.asked).toEqual([]);
    expect(await t.isOn()).toBe(false);
  });

  it('with refuse_if_on, a switch that is already on is refused; without it the call goes through as before', async () => {
    const t = await rig({ on: true });
    expect(await resumeOutbound({ ...t.base, refuse_if_on: true })).toEqual({
      ok: false,
      error: 'already_on',
    });
    expect(await t.count('safety.resume')).toBe(0);
    expect((await resumeOutbound(t.base)).ok).toBe(true);
  });

  it('a row that expires while the person confirms is checked again in the transaction', async () => {
    const t = await rig();
    const r = await resumeOutbound({
      ...t.base,
      confirm: async () => {
        t.clock.set('2026-11-03T12:00:01Z');
        return true;
      },
    });
    expect(r).toEqual({ ok: false, error: 'no_active_approval' });
    expect(await t.isOn()).toBe(false);
    expect(await t.count('safety.resume')).toBe(0);
  });

  it('a switch the database will not change is refused as switch_locked, with no audit row left behind', async () => {
    const t = await rig();
    await t.db.exec(`
      CREATE FUNCTION um_test_hold() RETURNS trigger AS $$ BEGIN RAISE EXCEPTION 'held'; END $$ LANGUAGE plpgsql;
      CREATE TRIGGER um_test_hold BEFORE UPDATE ON safety_switches FOR EACH ROW EXECUTE FUNCTION um_test_hold();
    `);
    expect(await resumeOutbound(t.base)).toEqual({ ok: false, error: 'switch_locked' });
    expect(await t.count('safety.resume')).toBe(0);
    expect(await t.count('switch.paypal_outbound.on')).toBe(0);
  });
});

describe('runResume (the terminal command) uses the same check', () => {
  const tty = { isTTY: true as boolean | undefined, env: {} as Record<string, string | undefined> };
  const cliBase = async (o: Parameters<typeof rig>[0] = {}) => {
    const t = await rig(o);
    return {
      t,
      d: {
        db: t.db,
        clock: t.clock,
        audit: t.base.audit,
        tty,
        ask: async () => SCOPE,
        write: () => undefined,
        operator_id: 'owner-1',
        approval_ref: REF as string | null,
        scope: SCOPE,
        reason: 'owner resumes',
      },
    };
  };

  it('refuses when the calls for the day are used up', async () => {
    const { t, d } = await cliBase({ approval: { max_calls: 2 } });
    await t.spend(2);
    expect(await runResume(d)).toEqual({ ok: false, error: 'budget_used_up' });
    expect(await t.isOn()).toBe(false);
  });

  it('still answers exactly the approval ref and scope, and now also writes the safety.resume row', async () => {
    const { t, d } = await cliBase();
    expect(await runResume(d)).toEqual({ ok: true, value: { approval_ref: REF, scope: SCOPE } });
    expect(await t.isOn()).toBe(true);
    expect(await t.count('safety.resume')).toBe(1);
    expect(await t.count('switch.paypal_outbound.on')).toBe(1);
  });
});
