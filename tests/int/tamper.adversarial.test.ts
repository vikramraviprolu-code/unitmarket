// INT-E2E (item E2E.2): the tamper proof. On the in-memory database only: the test asserts the app's database is
// pglite-memory before any edit (the PG-1 throwaway, UMS_TEST_DB=postgres, is not allowed here). It builds its
// state with story steps S01 to S05 (so ledger rows and journal rows exist), then:
//   1. disables the user triggers of ledger_entries (the append-only guard and the journal capture, the
//      precedent of packages/db/src/export-sql.state.test.ts:489) and changes one row's amount_minor: the
//      in-process verifier exits 1 and names `drift ledger_entries <id> amount_minor` (other lines may appear);
//   2. restores the value while the triggers are still off and enables them again: verify exits 0;
//   3. does the same to one trace_events row's body: verify exits 1 and names that row's chain and seq;
//      restored, verify exits 0 again.
// The edits are the third kind of direct write the spec allows. Nothing here reaches a network.
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { STEPS, bootStory } from './story';
import type { Rig } from './story';
import { STORY_START, verifyInProcess } from './support';

vi.mock('server-only', () => ({}));

describe('INT-E2E tamper proof on the in-memory database', () => {
  let rig: Rig;
  let ledger: { id: string; amount_minor: number };
  beforeAll(async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.parse(STORY_START));
    rig = await bootStory();
    expect(rig.app.config.db.kind).toBe('pglite-memory');
    for (const s of STEPS.slice(0, 5)) await s.run(rig);
    const r = await rig.app.db.query<{ id: string; amount_minor: string | number }>(
      "SELECT id, amount_minor FROM ledger_entries WHERE kind = 'sale' ORDER BY id LIMIT 1",
    );
    expect(r.rows).toHaveLength(1);
    ledger = { id: r.rows[0]!.id, amount_minor: Number(r.rows[0]!.amount_minor) };
  }, 180_000);
  afterAll(async () => {
    await rig?.app.close();
    vi.useRealTimers();
  });

  it('starts clean: the database is in-memory and verify exits 0', async () => {
    expect(rig.app.config.db.kind).toBe('pglite-memory');
    const v = await verifyInProcess(rig.app);
    expect(v.lines.at(-1)).toBe('ok');
    expect(v.code).toBe(0);
  });

  it('a changed ledger amount is caught: verify exits 1 with drift ledger_entries <id> amount_minor', async () => {
    expect(rig.app.config.db.kind).toBe('pglite-memory');
    await rig.app.db.exec('ALTER TABLE ledger_entries DISABLE TRIGGER USER');
    await rig.app.db.query('UPDATE ledger_entries SET amount_minor = $2 WHERE id = $1', [
      ledger.id,
      ledger.amount_minor + 1,
    ]);
    const v = await verifyInProcess(rig.app);
    process.stdout.write(`\nINT-E2E tamper 1 (ledger amount)\n${v.lines.join('\n')}\n`);
    expect(v.code).toBe(1);
    expect(v.lines.some((l) => l.includes(`drift ledger_entries ${ledger.id} amount_minor`))).toBe(
      true,
    );
  });

  it('restored while the triggers are off, then re-enabled: verify exits 0', async () => {
    await rig.app.db.query('UPDATE ledger_entries SET amount_minor = $2 WHERE id = $1', [
      ledger.id,
      ledger.amount_minor,
    ]);
    await rig.app.db.exec('ALTER TABLE ledger_entries ENABLE TRIGGER USER');
    const v = await verifyInProcess(rig.app);
    process.stdout.write(`\nINT-E2E tamper 2 (restored)\n${v.lines.join('\n')}\n`);
    expect(v.code).toBe(0);
    // the guard is back: an edit is refused again
    await expect(
      rig.app.db.query('UPDATE ledger_entries SET amount_minor = amount_minor WHERE id = $1', [
        ledger.id,
      ]),
    ).rejects.toThrow();
  });

  it('a changed journal body is caught: verify exits 1 naming that chain and seq; restored, it exits 0', async () => {
    expect(rig.app.config.db.kind).toBe('pglite-memory');
    const row = (
      await rig.app.db.query<{ chain_key: string; seq: number; body: unknown }>(
        `SELECT chain_key, seq::int AS seq, body FROM trace_events
          WHERE source_table = 'orders' AND chain_key = $1 ORDER BY seq LIMIT 1`,
        [`ord:${rig.agentOrders[0]!.order_id}`],
      )
    ).rows[0]!;
    const original = JSON.stringify(row.body);
    await rig.app.db.exec('ALTER TABLE trace_events DISABLE TRIGGER USER');
    await rig.app.db.query(
      `UPDATE trace_events SET body = jsonb_set(body, '{n}', to_jsonb(999)) WHERE chain_key = $1 AND seq = $2`,
      [row.chain_key, row.seq],
    );
    const v = await verifyInProcess(rig.app);
    process.stdout.write(`\nINT-E2E tamper 3 (journal body)\n${v.lines.join('\n')}\n`);
    expect(v.code).toBe(1);
    expect(v.lines.some((l) => l.includes(`${row.chain_key} seq ${String(row.seq)}`))).toBe(true);

    await rig.app.db.query(
      'UPDATE trace_events SET body = $3::jsonb WHERE chain_key = $1 AND seq = $2',
      [row.chain_key, row.seq, original],
    );
    await rig.app.db.exec('ALTER TABLE trace_events ENABLE TRIGGER USER');
    const after = await verifyInProcess(rig.app);
    process.stdout.write(`\nINT-E2E tamper 3 (restored)\n${after.lines.join('\n')}\n`);
    expect(after.code).toBe(0);
  });
});
