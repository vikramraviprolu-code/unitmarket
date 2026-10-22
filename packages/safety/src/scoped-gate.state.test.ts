import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { migrate, openDatabase } from '@umsbx/db';
import { fakeClock } from '@umsbx/runtime';
import { createApprovedSandboxTransport } from '@umsbx/transport';
import type { Wire, WireRequest } from '@umsbx/transport';
import type { Database, Logger, OutboundRequest } from '@umsbx/contracts';
import { createOutboundGate, createScopedGate, createSwitchReader } from './index';

// FIX-BPREP M2 and M3: the real scoped gate reads the outbound_approvals row, binds each request
// to its scope and approval ref, and is the only source of an approval capability. In-memory
// database, fake Wire: nothing here can reach a network.
type Db = Database & { close(): Promise<void> };
const T0 = '2026-10-22T10:00:00Z';
const REF = 'DL-2026-10-22-01';
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
  o: Partial<{ ref: string; scope: string; ops: string[]; max: number; until: string }> = {},
) {
  await db.query(
    `INSERT INTO outbound_approvals (id, approval_ref, scope, operations, max_amount_minor, max_calls_per_day, valid_until, approved_by, created_at, updated_at)
     VALUES ($1,$2,$3,$4,$5,100,$6,'owner',$7,$7)`,
    [
      `oap_${o.ref ?? REF}`.slice(0, 40),
      o.ref ?? REF,
      o.scope ?? 'mvp_b_polling',
      o.ops ?? ['oauth_token', 'create_order', 'get_order', 'capture_order'],
      o.max ?? 2000,
      o.until ?? '2026-10-23T00:00:00Z',
      T0,
    ],
  );
}
const switchOn = () =>
  db.query(`UPDATE safety_switches SET "on" = true WHERE name = 'paypal_outbound'`);
const config = (
  c: Partial<{ mode: 'offline' | 'sandbox'; connect: boolean; ref: string | null }> = {},
) => ({
  mode: c.mode ?? ('sandbox' as const),
  connect: c.connect ?? true,
  outbound_approval_ref: c.ref === undefined ? REF : c.ref,
});
const scoped = (scope = 'mvp_b_polling', c: Parameters<typeof config>[0] = {}) =>
  createScopedGate(db, clock, {
    scope,
    switches: createSwitchReader(db, clock, 0),
    config: config(c),
  });

describe('activeApproval reads the row', () => {
  it('reports scope and ref for a live row with the switch on', async () => {
    await addApproval();
    await switchOn();
    expect(await scoped().activeApproval()).toEqual({ scope: 'mvp_b_polling', approval_ref: REF });
  });
  it('is null with no row, a wrong scope, an expired row, the switch off, or the wrong config', async () => {
    await switchOn();
    expect(await scoped().activeApproval()).toBeNull(); // no row
    await addApproval({ scope: 'mvp_c_refunds' });
    expect(await scoped('mvp_b_polling').activeApproval()).toBeNull(); // wrong scope
    expect(await scoped('mvp_c_refunds').activeApproval()).not.toBeNull();
    expect(await scoped('mvp_c_refunds', { ref: 'DL-other' }).activeApproval()).toBeNull();
    expect(await scoped('mvp_c_refunds', { ref: null }).activeApproval()).toBeNull();
    expect(await scoped('mvp_c_refunds', { connect: false }).activeApproval()).toBeNull();
    expect(await scoped('mvp_c_refunds', { mode: 'offline' }).activeApproval()).toBeNull();
    await db.query(`UPDATE safety_switches SET "on" = false WHERE name = 'paypal_outbound'`);
    expect(await scoped('mvp_c_refunds').activeApproval()).toBeNull(); // kill switch
    await switchOn();
  });
  it('is null once the row has expired', async () => {
    await addApproval({ until: '2026-10-22T10:30:00Z' });
    await switchOn();
    const g = scoped();
    expect(await g.activeApproval()).not.toBeNull();
    clock.set('2026-10-22T10:30:01.000Z');
    expect(await g.activeApproval()).toBeNull();
    expect(await g.approvalCapability()).toBeNull();
  });
  it('a database error reads as no approval (fail closed)', async () => {
    const broken = createScopedGate(
      { ...db, query: async () => Promise.reject(new Error('down')) } as unknown as Database,
      clock,
      { scope: 'mvp_b_polling', switches: createSwitchReader(db, clock, 0), config: config() },
    );
    expect(await broken.activeApproval()).toBeNull();
  });
});

describe('request binding in the gate', () => {
  const create = (over: Record<string, unknown> = {}) =>
    ({ operation: 'create_order', amount_minor: 1500, ...over }) as const;
  it('the scoped gate allows only a request that names its scope and approval ref', async () => {
    await addApproval();
    await switchOn();
    const g = scoped();
    expect(await g.check(create())).toEqual({ allowed: false, by: 'no_approval' }); // unbound
    expect(await g.check(create({ scope: 'mvp_b_polling' }))).toEqual({
      allowed: false,
      by: 'no_approval',
    });
    expect(await g.check(create({ scope: 'mvp_c_refunds', approval_ref: REF }))).toEqual({
      allowed: false,
      by: 'no_approval',
    });
    expect(await g.check(create({ scope: 'mvp_b_polling', approval_ref: 'DL-other' }))).toEqual({
      allowed: false,
      by: 'no_approval',
    });
    expect(await g.check(create({ scope: 'mvp_b_polling', approval_ref: REF }))).toEqual({
      allowed: true,
      approval_ref: REF,
    });
  });
  it('an operation outside the row, a null money amount and an amount over the cap are blocked', async () => {
    await addApproval({ ops: ['create_order', 'get_order'], max: 2000 });
    await switchOn();
    const g = scoped();
    const bound = { scope: 'mvp_b_polling', approval_ref: REF };
    expect(await g.check({ operation: 'capture_order', amount_minor: null, ...bound })).toEqual({
      allowed: false,
      by: 'no_approval',
    });
    expect(await g.check({ operation: 'create_order', amount_minor: null, ...bound })).toEqual({
      allowed: false,
      by: 'budget',
    });
    expect(await g.check({ operation: 'create_order', amount_minor: 2001, ...bound })).toEqual({
      allowed: false,
      by: 'budget',
    });
    expect(await g.check({ operation: 'get_order', amount_minor: null, ...bound })).toEqual({
      allowed: true,
      approval_ref: REF,
    });
  });
  it('an unscoped gate still checks scope and ref when the caller supplies them', async () => {
    await addApproval();
    await switchOn();
    const g = createOutboundGate({
      db,
      clock,
      switches: createSwitchReader(db, clock, 0),
      config: config(),
    });
    expect((await g.check(create())).allowed).toBe(true);
    expect(await g.check(create({ scope: 'mvp_c_refunds' }))).toEqual({
      allowed: false,
      by: 'no_approval',
    });
    expect(await g.check(create({ approval_ref: 'DL-other' }))).toEqual({
      allowed: false,
      by: 'no_approval',
    });
  });
});

describe('the minted capability drives the approved transport', () => {
  const quiet: Logger = { log: () => undefined, child: () => quiet };
  const wire = (seen: WireRequest[]): Wire => ({
    async request(r) {
      seen.push(r);
      return { kind: 'response', status: 200, headers: {}, body: '{}' };
    },
  });
  const get: OutboundRequest = {
    operation: 'get_order',
    method: 'GET',
    path: '/v2/checkout/orders/ABC123',
    headers: { authorization: 'Bearer placeholder' },
    body: null,
    order_ref: null,
    amount_minor: null,
    scenario: null,
  };
  it('end to end: a minted capability sends; the switch off then blocks kill_switch', async () => {
    await addApproval();
    await switchOn();
    const g = scoped();
    const cap = await g.approvalCapability();
    expect(cap).not.toBeNull();
    const seen: WireRequest[] = [];
    const t = await createApprovedSandboxTransport({
      approval: cap!,
      scope: 'mvp_b_polling',
      clock,
      log: quiet,
      wire: wire(seen),
    });
    expect((await t.send(get)).kind).toBe('response');
    expect(seen).toHaveLength(1);
    await db.query(`UPDATE safety_switches SET "on" = false WHERE name = 'paypal_outbound'`);
    expect(await t.send(get)).toEqual({ kind: 'blocked', by: 'kill_switch' });
    expect(seen).toHaveLength(1);
  });
  it('a capability for one scope is refused by a transport built for another', async () => {
    await addApproval({ scope: 'mvp_c_refunds' });
    await switchOn();
    const cap = await scoped('mvp_c_refunds').approvalCapability();
    await expect(
      createApprovedSandboxTransport({
        approval: cap!,
        scope: 'mvp_b_polling',
        clock,
        log: quiet,
        wire: wire([]),
      }),
    ).rejects.toMatchObject({ name: 'SandboxSealedError' });
  });
  it('an approval row that expires mid-run blocks the next call', async () => {
    await addApproval({ until: '2026-10-22T10:30:00Z' });
    await switchOn();
    const cap = await scoped().approvalCapability();
    const seen: WireRequest[] = [];
    const t = await createApprovedSandboxTransport({
      approval: cap!,
      scope: 'mvp_b_polling',
      clock,
      log: quiet,
      wire: wire(seen),
    });
    expect((await t.send(get)).kind).toBe('response');
    clock.set('2026-10-22T10:30:01.000Z');
    expect(await t.send(get)).toEqual({ kind: 'blocked', by: 'no_approval' });
    expect(seen).toHaveLength(1);
  });
});
