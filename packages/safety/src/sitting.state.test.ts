// OPS-SW: "Open a PayPal sitting" from Operations Controls. The console writes the approval row that
// `pnpm safety:approve` used to write at the owner's terminal, with the D-094 ceiling fixed in code and a
// fresh reference per sitting (<configured ref>~<UTC stamp>). Real in-memory database; nothing here
// reaches a network.
import { afterEach, describe, expect, it } from 'vitest';
import { migrate, openDatabase } from '@umsbx/db';
import { createAuditSink } from '@umsbx/obs';
import { fakeClock, seededIds } from '@umsbx/runtime';
import type { Actor, Database, SwitchName } from '@umsbx/contracts';
import {
  SITTING_CEILING,
  createOutboundGate,
  findActiveApproval,
  openSitting,
  readSafetyStatus,
  resumeOutbound,
} from './index';

const REF = 'DL_sit';
const SCOPE = 'mvp_b_polling';
const NOW = '2026-11-10T04:00:00Z';
const VIKRAM: Actor = { kind: 'operator', operator_id: 'opr_vikram', mfa: true };

type Db = Database & { close(): Promise<void> };
const dbs: Db[] = [];
afterEach(async () => {
  for (const d of dbs.splice(0)) await d.close();
});

async function rig() {
  const clock = fakeClock(NOW);
  const db = (await openDatabase({ kind: 'pglite-memory' })) as Db;
  dbs.push(db);
  await migrate(db, clock);
  const audit = createAuditSink(seededIds('st'), clock);
  const open = (by: Actor = VIKRAM, base: string | null = REF) =>
    openSitting({ db, clock, audit, by, reason: 'demo sitting', base_ref: base, scope: SCOPE });
  return { db, clock, audit, open };
}

describe('openSitting', () => {
  it('writes one approval row with the D-094 ceiling, a fresh reference and an audit row', async () => {
    const { db, open } = await rig();
    const r = await open();
    expect(r).toEqual({
      ok: true,
      value: {
        approval_ref: 'DL_sit~20261110T040000Z',
        scope: SCOPE,
        valid_until: '2026-11-10T08:00:00.000Z',
        max_amount_minor: 500,
        max_calls: 40,
      },
    });
    const row = (
      await db.query<{
        operations: string[];
        max_amount_minor: string;
        max_calls_per_day: number;
        approved_by: string;
      }>(
        'SELECT operations, max_amount_minor, max_calls_per_day, approved_by FROM outbound_approvals',
      )
    ).rows;
    expect(row).toHaveLength(1);
    expect(row[0]!.operations).toEqual([
      'oauth_token',
      'create_order',
      'get_order',
      'capture_order',
      'get_capture',
    ]);
    expect(Number(row[0]!.max_amount_minor)).toBe(500);
    expect(row[0]!.max_calls_per_day).toBe(40);
    expect(row[0]!.approved_by).toBe('opr_vikram (console)');
    const audit = await db.query<{ action: string; detail: unknown; reason: string }>(
      `SELECT action, detail, reason FROM audit_log WHERE action = 'outbound_approval.create'`,
    );
    expect(audit.rows).toHaveLength(1);
    expect(audit.rows[0]!.detail).toMatchObject({ source: 'console', scope: SCOPE });
    expect(audit.rows[0]!.reason).toBe('demo sitting');
  });

  it('the ceiling is the D-094 one and cannot be passed in', () => {
    expect(SITTING_CEILING).toEqual({
      operations: ['oauth_token', 'create_order', 'get_order', 'capture_order', 'get_capture'],
      max_amount_minor: 500,
      max_calls: 40,
      valid_ms: 4 * 3_600_000,
    });
    expect(Object.isFrozen(SITTING_CEILING)).toBe(true);
  });

  it('refuses an operator without the authenticator code, and anyone who is not an operator', async () => {
    const { open } = await rig();
    expect(await open({ kind: 'operator', operator_id: 'opr_x', mfa: false })).toEqual({
      ok: false,
      error: 'operator_required',
    });
    expect(await open({ kind: 'buyer', buyer_id: 'byr_1' } as Actor)).toEqual({
      ok: false,
      error: 'operator_required',
    });
  });

  it('refuses an empty reason', async () => {
    const { db, clock, audit } = await rig();
    expect(
      await openSitting({
        db,
        clock,
        audit,
        by: VIKRAM,
        reason: '  ',
        base_ref: REF,
        scope: SCOPE,
      }),
    ).toEqual({ ok: false, error: 'reason_required' });
  });

  it('refuses when no approval reference is configured', async () => {
    const { open } = await rig();
    expect(await open(VIKRAM, null)).toEqual({ ok: false, error: 'no_reference' });
    expect(await open(VIKRAM, '  ')).toEqual({ ok: false, error: 'no_reference' });
  });

  it('allows one sitting at a time, and a new one once the last has ended', async () => {
    const { clock, open, db } = await rig();
    expect((await open()).ok).toBe(true);
    clock.advance(60_000);
    expect(await open()).toEqual({ ok: false, error: 'sitting_active' });
    clock.advance(4 * 3_600_000);
    const second = await open();
    expect(second.ok && second.value.approval_ref).toBe('DL_sit~20261110T080100Z');
    const n = await db.query<{ n: string }>('SELECT count(*) AS n FROM outbound_approvals');
    expect(Number(n.rows[0]!.n)).toBe(2);
  });

  it('an active terminal approval on the configured reference also counts as a sitting', async () => {
    const { db, open } = await rig();
    await db.query(
      `INSERT INTO outbound_approvals (id, approval_ref, scope, operations, max_amount_minor, max_calls_per_day, valid_until, approved_by, created_at, updated_at)
       VALUES ('oap_t', $1, $2, $3, 500, 40, '2026-11-10T06:00:00Z', 'owner', $4, $4)`,
      [REF, SCOPE, ['oauth_token'], NOW],
    );
    expect(await open()).toEqual({ ok: false, error: 'sitting_active' });
  });
});

describe('the gate finds a console sitting through the configured reference', () => {
  it('findActiveApproval and readSafetyStatus resolve the sitting row', async () => {
    const { db, clock, open } = await rig();
    await open();
    const row = await findActiveApproval(db, REF, clock.now());
    expect(row?.approval_ref).toBe('DL_sit~20261110T040000Z');
    const st = await readSafetyStatus(db, clock.now(), REF);
    expect(st.budget).toMatchObject({
      approval_ref: 'DL_sit~20261110T040000Z',
      max_calls_per_day: 40,
      remaining_today: 40,
      max_amount_minor: 500,
    });
  });

  it('LIKE wildcards in the configured reference match nothing else', async () => {
    const { db, clock } = await rig();
    await db.query(
      `INSERT INTO outbound_approvals (id, approval_ref, scope, operations, max_amount_minor, max_calls_per_day, valid_until, approved_by, created_at, updated_at)
       VALUES ('oap_w', 'DLXsit~1', $1, $2, 500, 40, '2026-11-10T06:00:00Z', 'x', $3, $3)`,
      [SCOPE, ['oauth_token'], NOW],
    );
    expect(await findActiveApproval(db, REF, clock.now())).toBeNull();
    expect(await findActiveApproval(db, 'DL', clock.now())).toBeNull();
  });

  it('Start turns the switch on under the sitting; the gate allows 500 and blocks 501', async () => {
    const { db, clock, audit, open } = await rig();
    await open();
    const started = await resumeOutbound({
      db,
      clock,
      audit,
      by: VIKRAM,
      reason: 'demo sitting',
      approval_ref: REF,
      scope: SCOPE,
      confirm: () => true,
    });
    expect(started.ok && started.value.approval_ref).toBe('DL_sit~20261110T040000Z');
    const switches = {
      isOn: async (name: SwitchName) =>
        (
          await db.query<{ on: boolean }>('SELECT "on" FROM safety_switches WHERE name = $1', [
            name,
          ])
        ).rows[0]?.on === true,
    };
    const gate = createOutboundGate({
      db,
      clock,
      switches: switches as never,
      config: { mode: 'sandbox', connect: true, outbound_approval_ref: REF },
    });
    expect(await gate.check({ operation: 'create_order', amount_minor: 500 })).toEqual({
      allowed: true,
      approval_ref: 'DL_sit~20261110T040000Z',
    });
    expect(await gate.check({ operation: 'create_order', amount_minor: 501 })).toEqual({
      allowed: false,
      by: 'budget',
    });
    expect(await gate.check({ operation: 'refund_capture', amount_minor: 100 })).toEqual({
      allowed: false,
      by: 'no_approval',
    });
    clock.advance(4 * 3_600_000);
    expect(await gate.check({ operation: 'get_order', amount_minor: null })).toEqual({
      allowed: false,
      by: 'no_approval',
    });
  });
});
