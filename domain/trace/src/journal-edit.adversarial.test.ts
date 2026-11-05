// INT-TR1 / architect note N1: a session that sets ums.trace to restore mode and then edits orders.status
// writes no journal row, and trace:verify reports it as drift. TR1 does not try to block it.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { verifyTrace } from '@umsbx/db';
import { freshDb, seedWorld } from './test-support';
import type { Db } from './test-support';

let db: Db;
beforeAll(async () => {
  db = await freshDb();
  await seedWorld(db);
}, 60_000);
afterAll(async () => {
  await db.close();
});

describe('an edit in restore mode', () => {
  it('is reported by verify as drift orders <id> status', async () => {
    expect((await verifyTrace(db)).findings).toEqual([]);
    await db.transaction(async (tx) => {
      await tx.query(`SELECT set_config('ums.trace', '{"mode":"restore"}', true)`);
      await tx.query(`UPDATE orders SET status = 'failed' WHERE id = 'ord_1'`);
    });
    const r = await verifyTrace(db);
    expect(r.findings.map((f) => f.detail)).toContain('drift orders ord_1 status');
  });
});
