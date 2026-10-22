import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { migrate, openDatabase } from '@umsbx/db';
import { createAuditSink } from '@umsbx/obs';
import { fakeClock, seededIds } from '@umsbx/runtime';
import type { Database } from '@umsbx/contracts';
import { createOutboundGate, createSwitchReader, setSwitch } from './index';

type Db = Database & { close(): Promise<void> };
const T0 = '2026-10-22T10:00:00Z';
const REF = 'DL-2026-10-22-01';
const OPERATOR = {
  kind: 'operator',
  operator_id: 'buy_operator0000000000000000a',
  mfa: true,
} as const;

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
    await addCalls(2);
    expect((await gate().check(create)).allowed).toBe(true);
    await addCalls(1, '2026-10-22T09:00:00Z');
    expect(await gate().check(create)).toEqual({ allowed: false, by: 'budget' });
  });
  it('calls before UTC midnight do not count', async () => {
    await switchOn();
    await addApproval({ calls: 1 });
    await addCalls(5, '2026-10-21T23:59:59Z');
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
  it('turning paypal_outbound on with approval_ref works and records the ref', async () => {
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
  it('stopping paypal_outbound needs only a reason', async () => {
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
