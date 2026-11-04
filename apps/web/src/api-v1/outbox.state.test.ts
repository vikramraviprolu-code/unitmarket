// API-W0 (F1): the event outbox adapter. append(tx, event) validates the payload against the schema of
// its type and inserts into event_outbox in the caller's transaction, so the event commits or rolls back
// with the change it describes. Delivery is lane C and is not here.
import { beforeAll, describe, expect, it, vi } from 'vitest';
import type { Database, EventOutbox } from '@umsbx/contracts';
import { bootPackApp } from '../composite-support';
import { createEventOutbox } from './outbox';
import { expectOffline } from './offline-guard';

vi.mock('server-only', () => ({}));
vi.mock('node:net', async (orig) => (await import('./offline-guard')).netMock(await orig()));
vi.mock('node:dns', async (orig) => (await import('./offline-guard')).dnsMock(await orig()));
expectOffline();

let db: Database;
let outbox: EventOutbox;
let nowIso: string;

beforeAll(async () => {
  const app = await bootPackApp();
  db = app.db;
  nowIso = '2026-11-04T10:00:00.000Z';
  outbox = createEventOutbox({ ids: app.security.ids, clock: { now: () => new Date(nowIso) } });
});

const PAID = {
  order_id: 'ord_w0',
  buyer_id: 'buy_w0',
  total: { currency: 'USD', minor: 40 },
  paid_at: '2026-11-04T10:00:00.000Z',
};
const rows = async () =>
  (
    await db.query<{ id: string; type: string; payload: unknown; occurred_at: unknown }>(
      'SELECT id, type, payload, occurred_at FROM event_outbox ORDER BY occurred_at, id',
    )
  ).rows;

describe('append', () => {
  it('inserts one row with an evt_ id, the type, the payload and the clock time', async () => {
    const before = (await rows()).length;
    const id = await db.transaction((tx) =>
      outbox.append(tx, { type: 'order.paid', payload: PAID }),
    );
    expect(id).toMatch(/^evt_[0-9a-z]{26}$/);
    const all = await rows();
    expect(all).toHaveLength(before + 1);
    const row = all.find((r) => r.id === id)!;
    expect(row.type).toBe('order.paid');
    expect(typeof row.payload === 'string' ? JSON.parse(row.payload) : row.payload).toEqual(PAID);
    expect(new Date(row.occurred_at as string).toISOString()).toBe(nowIso);
  });

  it('rolls back with the caller transaction', async () => {
    const before = (await rows()).length;
    await expect(
      db.transaction(async (tx) => {
        await outbox.append(tx, { type: 'order.paid', payload: PAID });
        throw new Error('the order failed');
      }),
    ).rejects.toThrow('the order failed');
    expect(await rows()).toHaveLength(before);
  });

  it('commits with the caller transaction, together with another write', async () => {
    const before = (await rows()).length;
    await db.transaction(async (tx) => {
      await tx.query('SELECT 1');
      await outbox.append(tx, { type: 'order.paid', payload: { ...PAID, order_id: 'ord_w0b' } });
      await outbox.append(tx, {
        type: 'settlement.completed',
        payload: { pass_id: 'pass_w0', checked: 3, fixed: 0, completed_at: nowIso },
      });
    });
    expect(await rows()).toHaveLength(before + 2);
  });

  it('refuses a payload that does not match its type, and writes nothing', async () => {
    const before = (await rows()).length;
    const bad: unknown[] = [
      {},
      { ...PAID, total: { currency: 'USD', minor: -1 } },
      { ...PAID, email: 'someone@example.test' },
      { order_id: 'ord_w0' },
    ];
    for (const payload of bad) {
      await expect(
        db.transaction((tx) => outbox.append(tx, { type: 'order.paid', payload })),
        JSON.stringify(payload),
      ).rejects.toThrow(/event payload/);
    }
    expect(await rows()).toHaveLength(before);
  });

  it('refuses an unknown type, and a payload that is right for another type', async () => {
    const before = (await rows()).length;
    await expect(
      db.transaction((tx) => outbox.append(tx, { type: 'payout.sent' as never, payload: PAID })),
    ).rejects.toThrow(/event type/);
    await expect(
      db.transaction((tx) => outbox.append(tx, { type: 'refund.completed', payload: PAID })),
    ).rejects.toThrow(/event payload/);
    expect(await rows()).toHaveLength(before);
  });

  it('the error does not echo the payload (no values in messages)', async () => {
    const secretish = { ...PAID, buyer_id: 'buy_w0', note: 'person@example.test' };
    const err = await db
      .transaction((tx) => outbox.append(tx, { type: 'order.paid', payload: secretish }))
      .catch((e: Error) => e);
    expect((err as Error).message).not.toContain('person@example.test');
  });

  it('keeps events in order: same time, ids break the tie, and the table is append-only', async () => {
    const a = await db.transaction((tx) =>
      outbox.append(tx, { type: 'order.paid', payload: { ...PAID, order_id: 'ord_a' } }),
    );
    const b = await db.transaction((tx) =>
      outbox.append(tx, { type: 'order.paid', payload: { ...PAID, order_id: 'ord_b' } }),
    );
    expect(a).not.toBe(b);
    await expect(
      db.query(`UPDATE event_outbox SET type = 'sale.recorded' WHERE id = $1`, [a]),
    ).rejects.toThrow(/append-only/);
    await expect(db.query('DELETE FROM event_outbox WHERE id = $1', [b])).rejects.toThrow(
      /append-only/,
    );
  });
});
