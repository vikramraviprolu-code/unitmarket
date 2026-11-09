import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { migrate, openDatabase } from '@umsbx/db';
import { createAuditSink } from '@umsbx/obs';
import { fakeClock, seededIds } from '@umsbx/runtime';
import type { Database } from '@umsbx/contracts';
import {
  aiEnabled,
  createOutboundGate,
  createSwitchReader,
  readSafetyStatus,
  setSwitch,
} from './index';

type Db = Database & { close(): Promise<void> };
const T0 = '2026-10-22T10:00:00Z';
const REF = 'DL-2026-10-22-01';
const OPERATOR = {
  kind: 'operator',
  operator_id: 'buy_operator0000000000000000a',
  mfa: true,
} as const;

type Op = { kind: 'operator'; operator_id: string; mfa: boolean };
const opened: Db[] = [];
afterAll(async () => {
  for (const d of opened) await d.close();
});

let db: Db;
let clock: ReturnType<typeof fakeClock>;
beforeEach(async () => {
  clock = fakeClock(T0);
  db = await openDatabase({ kind: 'pglite-memory' });
  opened.push(db);
  await migrate(db, clock);
});

async function addApproval(
  over: Partial<{
    ref: string;
    ops: string[];
    max: number;
    calls: number;
    until: string;
  }> = {},
) {
  await db.query(
    `INSERT INTO outbound_approvals (id, approval_ref, scope, operations, max_amount_minor, max_calls_per_day, valid_until, approved_by, created_at, updated_at)
     VALUES ($1,$2,'mvp_b_polling',$3,$4,$5,$6,'owner',$7,$7)`,
    [
      `oap_${over.ref ?? REF}`.slice(0, 40),
      over.ref ?? REF,
      over.ops ?? ['create_order', 'get_order'],
      over.max ?? 2000,
      over.calls ?? 3,
      over.until ?? '2026-10-23T00:00:00Z',
      T0,
    ],
  );
}
async function addCalls(n: number, createdAt = T0) {
  for (let i = 0; i < n; i++) {
    await db.query(
      `INSERT INTO provider_calls (id, operation, method, path_template, outcome, duration_ms, transport_kind, request_redacted, response_redacted, environment, created_at, updated_at)
       VALUES ($1,'create_order','POST','/v2/checkout/orders','ok',5,'sandbox','{}'::jsonb,'{}'::jsonb,'sandbox',$2,$2)`,
      [`pcl_${createdAt}_${i}`, createdAt],
    );
  }
}
async function switchOn(name = 'paypal_outbound') {
  await db.query(`UPDATE safety_switches SET "on" = true WHERE name = $1`, [name]);
}
const gate = (
  cfg: Partial<{ mode: 'offline' | 'sandbox'; connect: boolean; ref: string | null }> = {},
) =>
  createOutboundGate({
    db,
    clock,
    switches: createSwitchReader(db, clock, 0),
    config: {
      mode: cfg.mode ?? 'sandbox',
      connect: cfg.connect ?? true,
      outbound_approval_ref: cfg.ref === undefined ? REF : cfg.ref,
    },
  });
const create = { operation: 'create_order', amount_minor: 1500 } as const;
const reserved = async (ref = REF) =>
  Number(
    (
      await db.query<{ n: number | string }>(
        `SELECT count(*) AS n FROM audit_log WHERE action = 'gate.reserve' AND target = $1`,
        [ref],
      )
    ).rows[0]?.n ?? 0,
  );

describe('outbound gate order (A-03)', () => {
  it('offline mode gives connect_off, and connect false gives connect_off', async () => {
    await switchOn();
    await addApproval();
    expect(await gate({ mode: 'offline' }).check(create)).toEqual({
      allowed: false,
      by: 'connect_off',
    });
    expect(await gate({ connect: false }).check(create)).toEqual({
      allowed: false,
      by: 'connect_off',
    });
  });
  it('switch off gives kill_switch (the seeded default)', async () => {
    await addApproval();
    expect(await gate().check(create)).toEqual({ allowed: false, by: 'kill_switch' });
  });
  it('no row, expired row, wrong scope give no_approval', async () => {
    await switchOn();
    expect(await gate().check(create)).toEqual({ allowed: false, by: 'no_approval' });
    expect(await gate({ ref: null }).check(create)).toEqual({ allowed: false, by: 'no_approval' });
    await addApproval({ until: '2026-10-22T09:59:59Z' });
    expect(await gate().check(create)).toEqual({ allowed: false, by: 'no_approval' });
    await addApproval({ ref: 'OTHER', ops: ['create_order'] });
    expect(
      await gate({ ref: 'OTHER' }).check({ operation: 'refund_capture', amount_minor: 10 }),
    ).toEqual({
      allowed: false,
      by: 'no_approval',
    });
  });
  it('valid_until equal to now is expired', async () => {
    await switchOn();
    await addApproval({ until: T0 });
    expect(await gate().check(create)).toEqual({ allowed: false, by: 'no_approval' });
  });
  it('amount over cap and daily calls at cap give budget', async () => {
    await switchOn();
    await addApproval({ max: 2000, calls: 3 });
    expect(await gate().check({ operation: 'create_order', amount_minor: 2001 })).toEqual({
      allowed: false,
      by: 'budget',
    });
    expect((await gate().check({ operation: 'create_order', amount_minor: 2000 })).allowed).toBe(
      true,
    );
    // The 2000-minor check above reserved call 1 of 3; two more fit, the fourth does not.
    expect((await gate().check(create)).allowed).toBe(true);
    expect((await gate().check(create)).allowed).toBe(true);
    expect(await gate().check(create)).toEqual({ allowed: false, by: 'budget' });
  });
  it('reservations before UTC midnight do not count', async () => {
    await switchOn();
    await addApproval({ calls: 1, until: '2026-10-25T00:00:00Z' });
    clock.set('2026-10-22T23:59:59Z');
    expect((await gate().check(create)).allowed).toBe(true);
    expect(await gate().check(create)).toEqual({ allowed: false, by: 'budget' });
    clock.set('2026-10-23T00:00:01Z');
    expect((await gate().check(create)).allowed).toBe(true);
  });
  it('null amount skips the amount cap', async () => {
    await switchOn();
    await addApproval();
    expect((await gate().check({ operation: 'get_order', amount_minor: null })).allowed).toBe(true);
  });
  it('all open gives allowed with approval_ref', async () => {
    await switchOn();
    await addApproval();
    expect(await gate().check(create)).toEqual({ allowed: true, approval_ref: REF });
  });
  it('connect_off wins over kill_switch, kill_switch wins over no_approval', async () => {
    expect(await gate({ connect: false }).check(create)).toEqual({
      allowed: false,
      by: 'connect_off',
    });
    expect(await gate().check(create)).toEqual({ allowed: false, by: 'kill_switch' });
  });
});

// Opus review 4 H3: the budget is reserved inside the gate, per approval, under a row lock.
describe('budget reservation (review 4 H3)', () => {
  it('N concurrent checks at the cap let exactly max_calls_per_day through', async () => {
    await switchOn();
    await addApproval({ calls: 3 });
    const g = gate();
    const verdicts = await Promise.all(Array.from({ length: 12 }, () => g.check(create)));
    expect(verdicts.filter((v) => v.allowed)).toHaveLength(3);
    expect(verdicts.filter((v) => !v.allowed && v.by === 'budget')).toHaveLength(9);
    expect(await reserved()).toBe(3);
  });
  it('concurrent checks from separate gates share the same budget', async () => {
    await switchOn();
    await addApproval({ calls: 2 });
    const verdicts = await Promise.all(Array.from({ length: 6 }, () => gate().check(create)));
    expect(verdicts.filter((v) => v.allowed)).toHaveLength(2);
  });
  it('the budget counts per approval_ref', async () => {
    await switchOn();
    await addApproval({ ref: 'REF-A', calls: 1 });
    await addApproval({ ref: 'REF-B', calls: 1 });
    expect((await gate({ ref: 'REF-A' }).check(create)).allowed).toBe(true);
    expect(await gate({ ref: 'REF-A' }).check(create)).toEqual({ allowed: false, by: 'budget' });
    expect((await gate({ ref: 'REF-B' }).check(create)).allowed).toBe(true);
    expect(await reserved('REF-A')).toBe(1);
    expect(await reserved('REF-B')).toBe(1);
  });
  it('a refused check reserves nothing', async () => {
    await addApproval({ calls: 2 });
    expect((await gate().check(create)).allowed).toBe(false); // switch off
    await switchOn();
    expect((await gate().check({ operation: 'refund_capture', amount_minor: 1 })).allowed).toBe(
      false,
    ); // operation not covered
    expect((await gate().check({ operation: 'create_order', amount_minor: 99_999 })).allowed).toBe(
      false,
    ); // over the per-order cap
    expect(await reserved()).toBe(0);
  });
  it('unrelated provider_calls rows do not consume an approval budget', async () => {
    await switchOn();
    await addApproval({ calls: 1 });
    await addCalls(5);
    expect((await gate().check(create)).allowed).toBe(true);
  });
  it('a failed read blocks and reserves nothing', async () => {
    await switchOn();
    await addApproval({ calls: 2 });
    await db.exec('ALTER TABLE audit_log RENAME TO audit_log_gone');
    expect((await gate().check(create)).allowed).toBe(false);
  });
});

describe('switch reader cache (RLR-3)', () => {
  it('never serves a value older than 5 s', async () => {
    const r = createSwitchReader(db, clock);
    expect(await r.isOn('paypal_outbound')).toBe(false);
    await switchOn();
    clock.advance(4999);
    expect(await r.isOn('paypal_outbound')).toBe(false); // cached
    clock.advance(1);
    expect(await r.isOn('paypal_outbound')).toBe(true);
  });
  it('cache_ms above 5000 is clamped to 5000', async () => {
    const r = createSwitchReader(db, clock, 60_000);
    expect(await r.isOn('paypal_outbound')).toBe(false);
    await switchOn();
    clock.advance(5000);
    expect(await r.isOn('paypal_outbound')).toBe(true);
  });
  it('reads the other switches from the seed', async () => {
    const r = createSwitchReader(db, clock, 0);
    expect(await r.isOn('checkout_enabled')).toBe(true);
  });
});

describe('setSwitch', () => {
  const audit = () => createAuditSink(seededIds('sw'), clock);
  it('writes audit_log and updates the row', async () => {
    const r = await setSwitch(db, audit(), clock, {
      name: 'checkout_enabled',
      on: false,
      by: OPERATOR,
      reason: 'drill',
      approval_ref: null,
    });
    expect(r).toEqual({ ok: true, value: undefined });
    const sw = await db.query<{ on: boolean; reason: string }>(
      `SELECT "on", reason FROM safety_switches WHERE name='checkout_enabled'`,
    );
    expect(sw.rows[0]).toEqual({ on: false, reason: 'drill' });
    const a = await db.query<{ action: string; reason: string }>(
      `SELECT action, reason FROM audit_log`,
    );
    expect(a.rows).toHaveLength(1);
    expect(a.rows[0]?.action).toContain('checkout_enabled');
    expect(a.rows[0]?.reason).toBe('drill');
  });
  it('turning paypal_outbound on without approval_ref is refused', async () => {
    const r = await setSwitch(db, audit(), clock, {
      name: 'paypal_outbound',
      on: true,
      by: OPERATOR,
      reason: 'go',
      approval_ref: null,
    });
    expect(r).toEqual({ ok: false, error: 'approval_ref_required' });
    const sw = await db.query<{ on: boolean }>(
      `SELECT "on" FROM safety_switches WHERE name='paypal_outbound'`,
    );
    expect(sw.rows[0]?.on).toBe(false);
    expect((await db.query(`SELECT 1 FROM audit_log`)).rows).toHaveLength(0);
  });
  it('turning paypal_outbound on needs an active matching outbound_approvals row (M10)', async () => {
    const on = (ref: string | null, by: Op | { kind: 'system' } = OPERATOR) =>
      setSwitch(db, audit(), clock, {
        name: 'paypal_outbound',
        on: true,
        by,
        reason: 'go',
        approval_ref: ref,
      });
    // no row at all
    expect(await on('NO-SUCH-REF')).toEqual({ ok: false, error: 'approval_not_active' });
    // expired row
    await addApproval({ ref: 'OLD', until: '2026-10-22T09:59:59Z' });
    expect(await on('OLD')).toEqual({ ok: false, error: 'approval_not_active' });
    // an active row, but a non-operator actor, or an operator without MFA
    await addApproval();
    expect(await on(REF, { kind: 'system' })).toEqual({ ok: false, error: 'operator_required' });
    expect(await on(REF, { ...OPERATOR, mfa: false })).toEqual({
      ok: false,
      error: 'operator_required',
    });
    const sw = await db.query<{ on: boolean }>(
      `SELECT "on" FROM safety_switches WHERE name='paypal_outbound'`,
    );
    expect(sw.rows[0]?.on).toBe(false);
    expect((await db.query(`SELECT 1 FROM audit_log`)).rows).toHaveLength(0);
    expect((await on(REF)).ok).toBe(true);
  });
  it('stopping needs an operator but no approval; a non-operator cannot stop either (M10)', async () => {
    await switchOn();
    const stop = (by: Op | { kind: 'system' } | { kind: 'buyer'; buyer_id: string }) =>
      setSwitch(db, audit(), clock, {
        name: 'paypal_outbound',
        on: false,
        by,
        reason: 'stop',
        approval_ref: null,
      });
    expect(await stop({ kind: 'buyer', buyer_id: 'buy_1' })).toEqual({
      ok: false,
      error: 'operator_required',
    });
    expect(await stop({ kind: 'system' })).toEqual({ ok: false, error: 'operator_required' });
    expect((await stop({ ...OPERATOR, mfa: false })).ok).toBe(true);
  });
  it('turning paypal_outbound on with approval_ref works and records the ref', async () => {
    await addApproval();
    const r = await setSwitch(db, audit(), clock, {
      name: 'paypal_outbound',
      on: true,
      by: OPERATOR,
      reason: 'go',
      approval_ref: REF,
    });
    expect(r.ok).toBe(true);
    const a = await db.query<{ detail: Record<string, unknown> }>(`SELECT detail FROM audit_log`);
    expect(JSON.stringify(a.rows[0]?.detail)).toContain(REF);
  });
  it('stopping paypal_outbound needs only a reason and an operator', async () => {
    await switchOn();
    expect(
      (
        await setSwitch(db, audit(), clock, {
          name: 'paypal_outbound',
          on: false,
          by: OPERATOR,
          reason: 'stop',
          approval_ref: null,
        })
      ).ok,
    ).toBe(true);
  });
  it('empty or blank reason is refused', async () => {
    expect(
      await setSwitch(db, audit(), clock, {
        name: 'ai_enabled',
        on: false,
        by: OPERATOR,
        reason: '   ',
        approval_ref: null,
      }),
    ).toEqual({ ok: false, error: 'reason_required' });
  });
});

describe('status and the ai_enabled reader (review 4 M11)', () => {
  it('aiEnabled follows the ai_enabled switch and fails closed', async () => {
    const r = createSwitchReader(db, clock, 0);
    expect(await aiEnabled(r)).toBe(true);
    await db.query(`UPDATE safety_switches SET "on" = false WHERE name = 'ai_enabled'`);
    expect(await aiEnabled(r)).toBe(false);
    await db.exec('ALTER TABLE safety_switches RENAME TO safety_switches_gone');
    await db.query('SELECT 1');
    expect(await aiEnabled(createSwitchReader(db, clock, 0))).toBe(false);
  });
  it('readSafetyStatus lists the switches and the budget left, without secrets', async () => {
    await switchOn();
    await addApproval({ calls: 5 });
    await gate().check(create);
    await gate().check(create);
    const s = await readSafetyStatus(db, clock.now(), REF);
    expect(s.switches.map((x) => x.name)).toContain('paypal_outbound');
    // WEB-IMPORT-SW: pnpm safety:status prints these rows, so the web import switch is listed, off at seed
    expect(s.switches.find((x) => x.name === 'web_import_enabled')?.on).toBe(false);
    expect(s.switches.find((x) => x.name === 'paypal_outbound')?.on).toBe(true);
    expect(s.budget).toMatchObject({
      approval_ref: REF,
      max_calls_per_day: 5,
      reserved_today: 2,
      remaining_today: 3,
    });
    expect(JSON.stringify(s)).not.toMatch(/secret|password|token/i);
    expect((await readSafetyStatus(db, clock.now(), null)).budget).toBeNull();
    expect((await readSafetyStatus(db, clock.now(), 'GONE')).budget).toBeNull();
  });
});
