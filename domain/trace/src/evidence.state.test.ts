// INT-TR1 / TR1.5: the evidence pack of one unit. A checker with only node:crypto recomputes every hash and
// link from the pack alone; one edited canon or row_hash breaks the check. A canary scan finds no name,
// email, address or User-Agent, and no table outside the source_rows allow-list.
import { createHash } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { evidencePack, sealPreviousDay, SOURCE_ROW_TABLES } from './index';
import type { EvidencePack } from './index';
import { CANARY, CTX, as, freshDb, ins, scan, seedWorld } from './test-support';
import type { Db } from './test-support';

const sha = (s: string): string => createHash('sha256').update(s, 'utf8').digest('hex');

/** The documented offline steps, written out as code. Returns the first problem, or null. */
export function checkPack(p: EvidencePack): string | null {
  let prev = '0'.repeat(64);
  let seq = p.chain.from_seq - 1;
  for (const e of p.events) {
    if (e.seq !== seq + 1) return `seq gap before ${e.seq}`;
    seq = e.seq;
    if (sha(e.canon) !== e.row_hash) return `row_hash differs at seq ${e.seq}`;
    const c = JSON.parse(e.canon) as { prev_hash: string; seq: number; chain_key: string };
    if (c.chain_key !== p.chain.key || c.seq !== e.seq)
      return `canon names another row at seq ${e.seq}`;
    if (e.seq === 1 ? c.prev_hash !== prev : c.prev_hash !== prev)
      return `prev_hash differs at seq ${e.seq}`;
    prev = e.row_hash;
  }
  if (p.chain.from_seq !== 1) return 'chain does not start at seq 1';
  const last = p.events.at(-1)!;
  if (last.seq !== p.chain.to_seq) return 'to_seq is not the last event';
  if (
    p.seal !== undefined &&
    (p.seal.head.chain_key !== p.chain.key ||
      p.seal.head.seq !== last.seq ||
      p.seal.head.row_hash !== last.row_hash)
  )
    return 'the last event is not the head the seal names';
  return null;
}

let db: Db;
beforeAll(async () => {
  db = await freshDb();
  await seedWorld(db);
}, 60_000);
afterAll(async () => {
  await db.close();
});

describe('the pack', () => {
  it('is null for an unknown unit', async () => {
    expect(await evidencePack(db, { unit_id: 'unt_nope' })).toBeNull();
  });
  it('before any seal covers the chain it runs to the current head and says sealed: false', async () => {
    const p = (await evidencePack(db, { unit_id: 'unt_a' }))!;
    expect(p.unit_id).toBe('unt_a');
    expect(p.order_ref).toBe('ref_1');
    expect(p.sealed).toBe(false);
    expect(p.seal).toBeUndefined();
    expect(p.chain).toEqual({ key: 'ord:ord_1', from_seq: 1, to_seq: p.events.length });
    expect(checkPack(p)).toBeNull();
    expect(p.verify_steps.length).toBeGreaterThanOrEqual(4);
    for (const s of p.verify_steps) expect(s).not.toMatch(/[–—]/);
  });
  it('after a seal it runs to the sealed head, names the seal, and leaves out later events', async () => {
    await sealPreviousDay(db, { now: () => new Date('2026-11-05T00:10:00Z') });
    const before = (await evidencePack(db, { unit_id: 'unt_a' }))!;
    expect(before.sealed).toBe(true);
    expect(before.seal!.day).toBe('2026-11-04');
    expect(before.seal!.root_hash).toMatch(/^[a-f0-9]{64}$/);
    expect(before.seal!.prev_root_hash).toBe('0'.repeat(64));
    expect(checkPack(before)).toBeNull();
    const late = as(db, CTX.job('pass'), '2026-11-05T01:00:00Z');
    await ins(
      late,
      'ledger_entries',
      {
        id: 'led_late2',
        unit_id: 'unt_a',
        capture_id: 'CAPA',
        kind: 'paypal_fee',
        amount_minor: 3,
        currency: 'USD',
        refund_id: null,
        ref_entry_id: null,
        environment: 'dryrun',
      },
      '2026-11-05T01:00:00Z',
    );
    const after = (await evidencePack(db, { unit_id: 'unt_a' }))!;
    expect(after.events.length).toBe(before.events.length);
    expect(after.chain.to_seq).toBe(before.chain.to_seq);
    expect(checkPack(after)).toBeNull();
  });
});

describe('tamper', () => {
  it('one edited canon or row_hash breaks the check', async () => {
    const p = (await evidencePack(db, { unit_id: 'unt_a' }))!;
    const a = structuredClone(p);
    a.events[2]!.canon = a.events[2]!.canon.replace('"seq"', '"seq" ');
    expect(checkPack(a)).toMatch(/row_hash differs at seq 3/);
    const b = structuredClone(p);
    b.events[4]!.row_hash = 'f'.repeat(64);
    expect(checkPack(b)).toMatch(/row_hash differs at seq 5/);
    const c = structuredClone(p);
    c.events.splice(3, 1);
    expect(checkPack(c)).toMatch(/seq gap/);
    const d = structuredClone(p);
    d.events[1]!.canon = d.events[1]!.canon.replace(
      /"prev_hash":"[a-f0-9]{64}"/,
      `"prev_hash":"${'1'.repeat(64)}"`,
    );
    d.events[1]!.row_hash = sha(d.events[1]!.canon);
    expect(checkPack(d)).toMatch(/prev_hash differs/);
  });
});

describe('what the pack holds', () => {
  it('has no name, email, address, User-Agent, free text or table outside the allow-list', async () => {
    const p = (await evidencePack(db, { unit_id: 'unt_a' }))!;
    const text = scan(p);
    for (const bad of [
      CANARY.buyerName,
      CANARY.buyerSub,
      CANARY.reason,
      CANARY.secret,
      CANARY.ip,
      CANARY.ua,
      '@',
      'ip_hash',
      'cccccccc',
      'trace_context',
      'buyer_accounts',
      'req_t1',
    ]) {
      expect(text, bad).not.toContain(bad);
    }
    expect(Object.keys(p.source_rows).sort()).toEqual([...SOURCE_ROW_TABLES].sort());
    expect([...SOURCE_ROW_TABLES].sort()).toEqual([
      'access_events',
      'entitlements',
      'ledger_entries',
      'order_units',
      'provider_calls',
      'receipts',
      'refund_requests',
    ]);
    expect(text).not.toMatch(/"?buyers"?:/);
  });
  it('limits each source table to its allowed columns', async () => {
    const p = (await evidencePack(db, { unit_id: 'unt_a' }))!;
    const keys = (t: string) =>
      new Set(p.source_rows[t as keyof typeof p.source_rows].flatMap((r) => Object.keys(r)));
    expect(keys('receipts')).toEqual(new Set(['version', 'sha256']));
    expect(keys('access_events')).toEqual(new Set(['kind', 'at']));
    expect(keys('refund_requests').has('reason')).toBe(false);
    expect(keys('entitlements')).toEqual(new Set(['money_state', 'access_state', 'licence_state']));
    expect(p.source_rows.order_units.length).toBe(1);
    expect(p.source_rows.refund_requests.length).toBe(1);
    expect(p.source_rows.access_events.length).toBe(1);
  });
  it('buyer_id appears as the opaque id inside canon only', async () => {
    const p = (await evidencePack(db, { unit_id: 'unt_a' }))!;
    const outside = JSON.stringify({
      ...p,
      events: p.events.map((e) => ({ seq: e.seq, row_hash: e.row_hash })),
    });
    expect(outside).not.toContain('buy_1');
    expect(p.events.some((e) => e.canon.includes('buy_1'))).toBe(true);
  });
});
