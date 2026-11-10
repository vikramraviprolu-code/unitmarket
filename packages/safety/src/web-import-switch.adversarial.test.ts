// WEB-IMPORT-SW (docs/specs/web-import-switch.md): the new web_import_enabled switch does not loosen the PayPal
// path. Whatever it says, the outbound gate answers kill_switch while paypal_outbound is off, turning
// paypal_outbound on still needs an approval ref and an active approval row, and resume still refuses without an
// active approval. The import switch needs no approval to turn on. Real in-memory database, no network.
import { afterEach, describe, expect, it } from 'vitest';
import { migrate, openDatabase } from '@umsbx/db';
import { createAuditSink } from '@umsbx/obs';
import { fakeClock, seededIds } from '@umsbx/runtime';
import type { Actor, Database } from '@umsbx/contracts';
import { createOutboundGate, createSwitchReader, resumeOutbound, setSwitch } from './index';

type Db = Database & { close(): Promise<void> };
const NOW = '2026-11-09T12:00:00Z';
const REF = 'DL-import-sw-1';
const OPERATOR: Actor = { kind: 'operator', operator_id: 'opr_import_sw', mfa: true };
const dbs: Db[] = [];
afterEach(async () => {
  for (const d of dbs.splice(0)) await d.close();
});

async function rig(o: { approval?: boolean } = {}) {
  const clock = fakeClock(NOW);
  const db = (await openDatabase({ kind: 'pglite-memory' })) as Db;
  dbs.push(db);
  await migrate(db, clock);
  if (o.approval !== false)
    await db.query(
      `INSERT INTO outbound_approvals (id, approval_ref, scope, operations, max_amount_minor, max_calls_per_day, valid_until, approved_by, created_at, updated_at)
       VALUES ('oap_import_sw', $1, 'mvp_b_polling', $2, 2000, 50, '2026-11-12T12:00:00Z', 'test-owner', '2026-11-08T00:00:00Z', '2026-11-08T00:00:00Z')`,
      [REF, ['oauth_token', 'create_order']],
    );
  const audit = createAuditSink(seededIds('wis'), clock);
  const reader = createSwitchReader(db, clock, 0);
  const gate = createOutboundGate({
    db,
    clock,
    switches: reader,
    config: { mode: 'sandbox', connect: true, outbound_approval_ref: REF },
  });
  const set = (name: string, on: boolean) =>
    db.query(`UPDATE safety_switches SET "on" = $2 WHERE name = $1`, [name, on]);
  return { db, clock, audit, reader, gate, set };
}
const create = { operation: 'create_order', amount_minor: 1500 } as const;

describe('web_import_enabled does not open the PayPal path', () => {
  it('the gate answers kill_switch with paypal_outbound off, whether the import switch is on or off', async () => {
    const t = await rig();
    for (const v of [true, false]) {
      await t.set('web_import_enabled', v);
      expect(await t.gate.check(create)).toEqual({ allowed: false, by: 'kill_switch' });
    }
  });

  it('the reader reports the two switches independently', async () => {
    const t = await rig();
    await t.set('web_import_enabled', true);
    expect(await t.reader.isOn('web_import_enabled')).toBe(true);
    expect(await t.reader.isOn('paypal_outbound')).toBe(false);
    await t.set('web_import_enabled', false);
    await t.set('paypal_outbound', true);
    expect(await t.reader.isOn('web_import_enabled')).toBe(false);
    expect(await t.reader.isOn('paypal_outbound')).toBe(true);
  });

  it('a missing web_import_enabled row reads off, and paypal_outbound is unaffected by it', async () => {
    const t = await rig();
    await t.db.exec('ALTER TABLE safety_switches DISABLE TRIGGER safety_switches_no_delete');
    await t.db.query(`DELETE FROM safety_switches WHERE name = 'web_import_enabled'`);
    await t.set('paypal_outbound', true);
    expect(await t.reader.isOn('web_import_enabled')).toBe(false);
    expect(await t.reader.isOn('paypal_outbound')).toBe(true);
  });

  it('turning paypal_outbound on still needs an approval ref, MFA and an active approval row', async () => {
    const t = await rig({ approval: false });
    const base = { name: 'paypal_outbound' as const, on: true, by: OPERATOR, reason: 'drill' };
    expect(await setSwitch(t.db, t.audit, t.clock, { ...base, approval_ref: null })).toEqual({
      ok: false,
      error: 'approval_ref_required',
    });
    expect(
      await setSwitch(t.db, t.audit, t.clock, {
        ...base,
        by: { ...OPERATOR, mfa: false },
        approval_ref: REF,
      }),
    ).toEqual({ ok: false, error: 'operator_required' });
    expect(await setSwitch(t.db, t.audit, t.clock, { ...base, approval_ref: REF })).toEqual({
      ok: false,
      error: 'approval_not_active',
    });
    expect(await t.reader.isOn('paypal_outbound')).toBe(false);
  });

  it('turning web_import_enabled on needs no approval ref and does not touch paypal_outbound', async () => {
    const t = await rig({ approval: false });
    const r = await setSwitch(t.db, t.audit, t.clock, {
      name: 'web_import_enabled',
      on: true,
      by: OPERATOR,
      reason: 'maintenance',
      approval_ref: null,
    });
    expect(r.ok).toBe(true);
    expect(await t.reader.isOn('web_import_enabled')).toBe(true);
    expect(await t.reader.isOn('paypal_outbound')).toBe(false);
    const a = await t.db.query<{ action: string }>(
      `SELECT action FROM audit_log WHERE action LIKE 'switch.%'`,
    );
    expect(a.rows).toEqual([{ action: 'switch.web_import_enabled.on' }]);
  });

  it('resume still refuses without an active approval, whatever the import switch says', async () => {
    const t = await rig({ approval: false });
    await t.set('web_import_enabled', true);
    const r = await resumeOutbound({
      db: t.db,
      clock: t.clock,
      audit: t.audit,
      by: OPERATOR,
      reason: 'tester sitting',
      approval_ref: REF,
      scope: 'mvp_b_polling',
      confirm: async () => true,
    });
    expect(r).toEqual({ ok: false, error: 'no_active_approval' });
    expect(await t.reader.isOn('paypal_outbound')).toBe(false);
  });
});
