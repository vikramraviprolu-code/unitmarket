// Opus review 3 findings H1, M1, M2, L8 for the access clock. PGlite database.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { CoreDeps, SqlExecutor } from '@umsbx/contracts';
import { grantCredit, markAccessReady, recordDeliveryEvent, sweepWindows } from './index';
import { FIVE_DAYS_MS, HASH, makeWorld, START } from './world';
import type { World } from './world';

const H = 3_600_000;
const D = 24 * H;
let w: World;
beforeAll(async () => {
  w = await makeWorld('rev');
});
afterAll(async () => {
  await w.close();
});
beforeEach(async () => {
  await w.reset();
  w.clock.set(START);
});

const evidence = { capture_id: 'CAP1', content_sha256: HASH, link_probe: 'ok' as const };
const ready = (id: string) =>
  w.db.transaction((tx) => markAccessReady(tx, w.deps, { entitlement_id: id, evidence }));
type Kind = Parameters<typeof recordDeliveryEvent>[1]['kind'];
const delivery = (id: string, kind: Kind, link_id: string | null = null) =>
  recordDeliveryEvent(w.deps, {
    entitlement_id: id,
    kind,
    link_id,
    source: 'system',
    evidence: {},
  });
const kinds = async (id: string) =>
  (
    await w.db.query<{ kind: string }>(
      'SELECT kind FROM access_events WHERE entitlement_id = $1 ORDER BY at, seq',
      [id],
    )
  ).rows.map((r) => r.kind);

describe('H1 repeatable delivery events on a real link', () => {
  it('download, failure, then a second download on the same link resumes the window', async () => {
    const id = await w.rawEntitlement(1);
    await w.rawLink('lnk_1', id);
    await ready(id);
    await delivery(id, 'download_completed', 'lnk_1');
    w.clock.advance(D);
    expect((await delivery(id, 'delivery_failed', 'lnk_1')).state).toBe('paused');
    w.clock.advance(3 * H);
    const r = await delivery(id, 'download_completed', 'lnk_1');
    expect(r).toMatchObject({ state: 'running', credit_ms: 3 * H, paused_at: null });
    expect(r.inserted).toBe(true);
  });

  it('a second outage on the same link is credited as well', async () => {
    const id = await w.rawEntitlement(1);
    await w.rawLink('lnk_1', id);
    await ready(id);
    await delivery(id, 'delivery_failed', 'lnk_1');
    w.clock.advance(2 * H);
    await delivery(id, 'delivery_restored', 'lnk_1');
    w.clock.advance(H);
    expect((await delivery(id, 'delivery_failed', 'lnk_1')).state).toBe('paused');
    w.clock.advance(4 * H);
    const r = await delivery(id, 'delivery_restored', 'lnk_1');
    expect(r).toMatchObject({ state: 'running', credit_ms: 6 * H });
  });

  it('link_issued is once per link and reports inserted false on the replay', async () => {
    const id = await w.rawEntitlement(1);
    await w.rawLink('lnk_1', id);
    await ready(id);
    expect((await delivery(id, 'link_issued', 'lnk_1')).inserted).toBe(true);
    expect((await delivery(id, 'link_issued', 'lnk_1')).inserted).toBe(false);
    expect((await kinds(id)).filter((k) => k === 'link_issued')).toHaveLength(1);
  });

  it('property: over a deterministic sequence on real links only link_issued is deduplicated', async () => {
    const id = await w.rawEntitlement(1);
    await w.rawLink('lnk_1', id);
    await w.rawLink('lnk_2', id);
    await ready(id);
    const pool: Kind[] = [
      'link_issued',
      'download_completed',
      'download_aborted',
      'reader_rendered',
      'reader_beacon',
      'delivery_failed',
      'delivery_restored',
    ];
    let s = 12345;
    const next = () => (s = (Math.imul(s, 1664525) + 1013904223) >>> 0);
    let expected = 0;
    const issued = new Set<string>();
    for (let i = 0; i < 60; i += 1) {
      const kind = pool[next() % pool.length]!;
      const link = next() % 2 === 0 ? 'lnk_1' : 'lnk_2';
      w.clock.advance(60_000);
      const r = await delivery(id, kind, link);
      const fresh = kind !== 'link_issued' || !issued.has(link);
      if (kind === 'link_issued') issued.add(link);
      expect(r.inserted, `${i} ${kind} ${link}`).toBe(fresh);
      if (fresh) expected += 1;
    }
    const stored = (await kinds(id)).filter((k) => k !== 'access_ready');
    expect(stored).toHaveLength(expected);
    expect(stored.length).toBeGreaterThan(40);
  });
});

describe('L8 event order uses a sequence column', () => {
  it('seq grows with insertion order, also for events at the same instant', async () => {
    const id = await w.rawEntitlement(1);
    await ready(id);
    await delivery(id, 'delivery_failed');
    await delivery(id, 'delivery_restored');
    await delivery(id, 'delivery_failed');
    const rows = await w.db.query<{ seq: string | number; kind: string }>(
      'SELECT seq, kind FROM access_events WHERE entitlement_id = $1 ORDER BY seq',
      [id],
    );
    const seqs = rows.rows.map((r) => Number(r.seq));
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
    expect(new Set(seqs).size).toBe(seqs.length);
    expect(rows.rows.map((r) => r.kind)).toEqual([
      'access_ready',
      'delivery_failed',
      'delivery_restored',
      'delivery_failed',
    ]);
  });

  it('loadEvents orders by at, seq (no ctid)', async () => {
    const src = await import('node:fs').then((fs) =>
      fs.readFileSync(new URL('./events.ts', import.meta.url), 'utf8'),
    );
    expect(src).toContain('ORDER BY at, seq');
    expect(src).not.toContain('ctid');
  });
});

describe('M1 credit after the window ended', () => {
  const by = { kind: 'operator' as const, operator_id: 'opr_1', mfa: true };
  it('is refused with window_ended', async () => {
    const id = await w.rawEntitlement(1);
    await ready(id);
    w.clock.advance(FIVE_DAYS_MS + D);
    const r = await w.db.transaction((tx) =>
      grantCredit(tx, w.deps, { entitlement_id: id, credit_ms: 24 * H, case_id: 'cas_1', by }),
    );
    expect(r).toEqual({ ok: false, error: { code: 'window_ended' } });
    expect(await kinds(id)).toEqual(['access_ready']);
  });
});

describe('M2 sweep lock order: entitlement before window', () => {
  it('the id scan takes no lock, entitlements lock first, then the window row', async () => {
    const ids: string[] = [];
    for (const n of [1, 2]) {
      const id = await w.rawEntitlement(n);
      await ready(id);
      ids.push(id);
    }
    w.clock.advance(FIVE_DAYS_MS + H);
    const log: string[] = [];
    const spy = (tx: SqlExecutor): SqlExecutor =>
      ({
        query: (sql: string, params?: unknown[]) => {
          log.push(sql.replace(/\s+/g, ' ').trim());
          return tx.query(sql, params);
        },
      }) as SqlExecutor;
    const deps = {
      ...w.deps,
      db: {
        ...w.db,
        transaction: (fn: (tx: SqlExecutor) => Promise<unknown>) =>
          w.db.transaction((tx) => fn(spy(tx))),
      },
    } as unknown as CoreDeps;
    expect(await sweepWindows(deps, { max_items: 10 })).toEqual({ ended: 2 });
    const locks = log.filter((q) => /FOR UPDATE/.test(q));
    expect(locks.length).toBeGreaterThan(0);
    const firstWindowLock = locks.findIndex((q) => /FROM access_windows/.test(q) || /OF w/.test(q));
    const firstEntLock = locks.findIndex((q) => /FROM entitlements/.test(q));
    expect(firstEntLock).toBe(0);
    expect(firstWindowLock === -1 || firstWindowLock > firstEntLock).toBe(true);
    expect(log[0]).not.toMatch(/FOR UPDATE/);
    expect(locks[0]).toMatch(/SKIP LOCKED/);
  });
});
