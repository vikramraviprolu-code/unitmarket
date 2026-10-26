// BU-9 (hotfix): a checkout that waited 24 h for the buyer, whose PayPal order PayPal no longer knows
// (HTTP 404 = not_found), must be closed, not read again on every pass. The owner's sandbox run sent
// about 115 get_order calls in 100 s for such orders. Rules under test (docs/specs/jobs-abandon-not-found.md):
// not_found on a single-route order abandons it (units declined, prepared operations failed), unless a
// capture operation is `sent` or `unknown`, or a unit has a capture; blocked and unreadable answers keep
// the order; a pack (more than one PayPal order) is left as it was. Real PGlite, scripted PayPal.
import { afterEach, describe, expect, it } from 'vitest';
import { nextDueAt, runDue } from './index';
import { approved, awaiting, makeWorld, orderStatus, place } from './ops/support';
import type { Awaiting, OpsWorld } from './ops/support';
import { insertOperation } from './store';

let w: OpsWorld;
afterEach(async () => {
  expect(w.paypal.violations).toEqual([]);
  await w.close();
});
const H = 3_600_000;
const DAY = 24 * H;
const PASS = { max_items: 10 } as const;
const ZERO = { processed: 0, still_unknown: 0, expired: 0, abandoned: 0 };

/** PayPal no longer knows this order: every read of it answers 404 = not_found. */
const gone = (provider_order_id: string): void => {
  expect(w.paypal.orders.delete(provider_order_id)).toBe(true);
};
const reads = (provider_order_id: string): number =>
  w.paypal.calls.filter((c) => c.op === 'get' && c.provider_order_id === provider_order_id).length;
const unitStates = (order_id: string): Promise<string[]> =>
  w
    .rows<{ status: string }>('SELECT status FROM order_units WHERE order_id = $1 ORDER BY id', [
      order_id,
    ])
    .then((r) => r.map((x) => x.status));
const poStates = (order_id: string): Promise<string[]> =>
  w
    .rows<{ state: string }>(
      'SELECT state FROM provider_orders WHERE order_id = $1 ORDER BY position',
      [order_id],
    )
    .then((r) => r.map((x) => x.state));
const moneyStates = (order_id: string): Promise<string[]> =>
  w
    .rows<{ money_state: string }>(
      `SELECT e.money_state FROM entitlements e JOIN order_units u ON u.id = e.unit_id
        WHERE u.order_id = $1 ORDER BY e.id`,
      [order_id],
    )
    .then((r) => r.map((x) => x.money_state));
const alertCount = async (order_id: string): Promise<number> =>
  Number(
    (
      await w.rows<{ n: string }>('SELECT count(*)::int AS n FROM alerts WHERE order_id = $1', [
        order_id,
      ])
    )[0]!.n,
  );

/** A capture operation of the order in the given state, as a crashed or timed-out capture leaves it. */
async function captureOp(
  a: Awaiting,
  state: 'prepared' | 'sent' | 'unknown',
  position = 1,
): Promise<string> {
  const at = w.clock.now().toISOString();
  const later = new Date(w.clock.now().getTime() + 2 * H).toISOString();
  const ref = (
    await w.rows<{ id: string }>(
      'SELECT id FROM provider_orders WHERE order_id = $1 AND position = $2',
      [a.order_id, position],
    )
  )[0]!.id;
  const id = w.deps.ids.next('opr');
  await w.db.transaction((tx) =>
    insertOperation(tx, {
      id,
      order_id: a.order_id,
      kind: 'capture',
      state,
      request_id: `umsK-${a.order_ref}-${state}`,
      // sent and prepared need a lease; unknown needs next_retry_at and the end of its window
      lease_until: state === 'unknown' ? null : later,
      reconcile_until: state === 'unknown' ? later : null,
      // an unknown operation that is not due yet: only the abandonment sweep looks at the order
      next_retry_at: state === 'unknown' ? later : null,
      at,
      provider_order_ref: ref,
    }),
  );
  if (state !== 'prepared') {
    await w.rows('UPDATE operations SET first_sent_at = $2 WHERE id = $1', [id, at]);
  }
  return id;
}

describe('a stale awaiting_buyer order whose PayPal order is gone (not_found)', () => {
  it('(a) one pass abandons it: order abandoned, units declined, access denied, no capture, no alert; the next passes make no read', async () => {
    w = await makeWorld();
    const a = await awaiting(w);
    gone(a.provider_order_id);
    w.tick(DAY + 1000);

    const first = await runDue(w.deps, PASS);
    expect(first).toEqual({ ...ZERO, processed: 1, abandoned: 1 });
    expect(reads(a.provider_order_id)).toBe(1);
    expect(await orderStatus(w, a.order_id)).toBe('abandoned');
    expect(await poStates(a.order_id)).toEqual(['abandoned']);
    expect(await unitStates(a.order_id)).toEqual(['declined']);
    expect(await moneyStates(a.order_id)).toEqual(['denied']);
    expect(w.paypal.count('capture')).toBe(0);
    expect(await alertCount(a.order_id)).toBe(0);

    for (let i = 0; i < 5; i += 1) {
      w.tick(1000);
      expect(await runDue(w.deps, PASS)).toEqual(ZERO);
    }
    expect(reads(a.provider_order_id)).toBe(1); // never read again
    expect(await nextDueAt(w.db, w.deps.config)).toBeNull(); // and nothing is overdue any more
  });

  it('(a) it writes one log line with the order_ref and no PayPal id or secret', async () => {
    w = await makeWorld();
    const a = await awaiting(w);
    gone(a.provider_order_id);
    w.tick(DAY + 1000);
    const lines: { msg: string; level: string; fields: Record<string, unknown> }[] = [];
    const log = {
      log: (e: { msg: string; level: string; fields: Record<string, unknown> }) => {
        lines.push(e);
      },
      child: () => log,
    };
    await runDue({ ...w.deps, log }, PASS);
    const mine = lines.filter((l) => l.msg === 'payments.due.abandoned_not_found');
    expect(mine).toHaveLength(1);
    expect(mine[0]!.fields).toEqual({ order_ref: a.order_ref });
    expect(JSON.stringify(lines)).not.toContain(a.provider_order_id);
  });

  it('(a) a prepared capture operation of the order is failed with the order (declined)', async () => {
    w = await makeWorld();
    const a = await awaiting(w);
    gone(a.provider_order_id);
    w.tick(DAY + 1000);
    const id = await captureOp(a, 'prepared');
    expect((await runDue(w.deps, PASS)).abandoned).toBe(1);
    expect(await orderStatus(w, a.order_id)).toBe('abandoned');
    expect(
      (
        await w.rows<{ state: string; failure_reason: string }>(
          'SELECT state, failure_reason FROM operations WHERE id = $1',
          [id],
        )
      )[0],
    ).toEqual({ state: 'failed', failure_reason: 'declined' });
  });

  it('(a) before 24 h nothing is read and nothing is abandoned', async () => {
    w = await makeWorld();
    const a = await awaiting(w);
    gone(a.provider_order_id);
    w.tick(DAY - 1000);
    expect(await runDue(w.deps, PASS)).toEqual(ZERO);
    expect(reads(a.provider_order_id)).toBe(0);
    expect(await orderStatus(w, a.order_id)).toBe('awaiting_buyer');
  });

  it('(a) the outbound switch off: no read, so nothing is abandoned on an assumption', async () => {
    w = await makeWorld();
    const a = await awaiting(w);
    gone(a.provider_order_id);
    w.switches.paypal_outbound = false;
    w.tick(DAY + 1000);
    expect(await runDue(w.deps, PASS)).toEqual(ZERO);
    expect(reads(a.provider_order_id)).toBe(0);
    expect(await orderStatus(w, a.order_id)).toBe('awaiting_buyer');
  });

  it('(a) a money_only pass does no abandonment, with or without the order', async () => {
    w = await makeWorld();
    const a = await awaiting(w);
    gone(a.provider_order_id);
    w.tick(DAY + 1000);
    expect(await runDue(w.deps, { ...PASS, allow: 'money_only' })).toEqual(ZERO);
    expect(reads(a.provider_order_id)).toBe(0);
    expect(await orderStatus(w, a.order_id)).toBe('awaiting_buyer');
  });

  it('(a) only the gone order is touched by the new rule: an unapproved one PayPal knows is abandoned by the old rule, an approved one is still captured', async () => {
    w = await makeWorld();
    const lost = await awaiting(w);
    const known = await awaiting(w, { buyer_id: 'buy_B' });
    const approvedKnown = await approved(w, { offers: ['ofr_2'] });
    gone(lost.provider_order_id);
    w.tick(DAY + 1000);
    const r = await runDue(w.deps, PASS);
    expect(r.abandoned).toBe(2); // the gone one, and the known one that nobody approved
    expect(reads(known.provider_order_id)).toBe(1);
    expect(await orderStatus(w, lost.order_id)).toBe('abandoned');
    expect(await orderStatus(w, known.order_id)).toBe('abandoned');
    expect(w.paypal.count('capture')).toBe(1);
    expect(await orderStatus(w, approvedKnown.order_id)).toBe('paid');
  });
});

describe('(b) not_found, but money may be in flight: the order is kept', () => {
  for (const state of ['sent', 'unknown'] as const) {
    it(`a capture operation in state ${state}: not abandoned, units untouched, no alert, no capture sent`, async () => {
      w = await makeWorld();
      const a = await awaiting(w);
      gone(a.provider_order_id);
      w.tick(DAY + 1000);
      await captureOp(a, state); // made after the wait: its lease and its poll time are still ahead

      const r = await runDue(w.deps, PASS);
      expect(r.abandoned).toBe(0);
      expect(r.processed).toBe(0);
      expect(await orderStatus(w, a.order_id)).toBe('awaiting_buyer');
      expect(await poStates(a.order_id)).toEqual(['awaiting_buyer']);
      expect(await unitStates(a.order_id)).toEqual(['expected']);
      expect(await moneyStates(a.order_id)).not.toContain('denied');
      expect(
        (
          await w.rows<{ state: string }>(
            "SELECT state FROM operations WHERE order_id = $1 AND kind = 'capture'",
            [a.order_id],
          )
        )[0]!.state,
      ).toBe(state);
      expect(w.paypal.count('capture')).toBe(0);
      expect(await alertCount(a.order_id)).toBe(0);
    });
  }

  it('a capture operation unknown and due now: the reconciler reads it, the sweep keeps the order, nothing is abandoned over three passes', async () => {
    w = await makeWorld();
    const a = await awaiting(w);
    gone(a.provider_order_id);
    w.tick(DAY + 1000);
    const id = await captureOp(a, 'unknown');
    await w.rows('UPDATE operations SET next_retry_at = $2 WHERE id = $1', [
      id,
      w.clock.now().toISOString(),
    ]);
    for (let i = 0; i < 3; i += 1) {
      expect((await runDue(w.deps, PASS)).abandoned).toBe(0);
      w.tick(1000);
    }
    expect(await orderStatus(w, a.order_id)).toBe('awaiting_buyer');
    expect(await unitStates(a.order_id)).toEqual(['expected']);
    expect(
      (await w.rows<{ state: string }>('SELECT state FROM operations WHERE id = $1', [id]))[0]!
        .state,
    ).toBe('unknown'); // still the reconciler's: polled on its own schedule, never failed here
    expect(w.paypal.count('capture')).toBe(0);
  });

  for (const state of ['capture_requested', 'capture_claimed', 'unresolved', 'captured'] as const) {
    it(`a PayPal order row already in state ${state} (an older writer left orders.status behind): not abandoned`, async () => {
      w = await makeWorld();
      const a = await awaiting(w);
      gone(a.provider_order_id);
      w.tick(DAY + 1000);
      await w.rows('UPDATE provider_orders SET state = $2 WHERE order_id = $1', [
        a.order_id,
        state,
      ]);
      expect((await runDue(w.deps, PASS)).abandoned).toBe(0);
      expect(await orderStatus(w, a.order_id)).toBe('awaiting_buyer');
      expect(await unitStates(a.order_id)).toEqual(['expected']);
    });
  }

  it('a unit that already carries a capture: not abandoned (money has arrived)', async () => {
    w = await makeWorld();
    const a = await awaiting(w);
    await w.rows(
      `UPDATE order_units SET status = 'captured_verified', capture_id = 'SBXTESTCAP00001',
              captured_verified_at = $2 WHERE order_id = $1`,
      [a.order_id, w.clock.now().toISOString()],
    );
    gone(a.provider_order_id);
    w.tick(DAY + 1000);
    expect((await runDue(w.deps, PASS)).abandoned).toBe(0);
    expect(await orderStatus(w, a.order_id)).toBe('awaiting_buyer');
    expect(await unitStates(a.order_id)).toEqual(['captured_verified']);
  });

  it('a unit with a capture id but no verification yet: not abandoned either', async () => {
    w = await makeWorld();
    const a = await awaiting(w);
    await w.rows(
      "UPDATE order_units SET status = 'pending', capture_id = 'SBXTESTCAP00002' WHERE order_id = $1",
      [a.order_id],
    );
    gone(a.provider_order_id);
    w.tick(DAY + 1000);
    expect((await runDue(w.deps, PASS)).abandoned).toBe(0);
    expect(await orderStatus(w, a.order_id)).toBe('awaiting_buyer');
    expect(await unitStates(a.order_id)).toEqual(['pending']);
  });

  it('the checks are made under the order lock: a capture that turns unknown while the read is out keeps the order', async () => {
    w = await makeWorld();
    const a = await awaiting(w);
    gone(a.provider_order_id);
    w.tick(DAY + 1000);
    // the capture goes out (and its answer is lost) between the read and the abandoning transaction
    w.paypal.beforeGet = async () => {
      w.paypal.beforeGet = null;
      await captureOp(a, 'unknown');
    };
    expect((await runDue(w.deps, PASS)).abandoned).toBe(0);
    expect(await orderStatus(w, a.order_id)).toBe('awaiting_buyer');
    expect(await unitStates(a.order_id)).toEqual(['expected']);
  });
});

describe('(c) a read that proves nothing keeps the order', () => {
  const answers = [
    ['blocked by budget', { kind: 'blocked', by: 'budget' }],
    ['blocked by the kill switch', { kind: 'blocked', by: 'kill_switch' }],
    ['timeout', { kind: 'timeout' }],
    ['unavailable (5xx)', { kind: 'unavailable', retry_after_ms: null }],
    ['in progress', { kind: 'in_progress', debug_id: null }],
  ] as const;
  for (const [name, answer] of answers) {
    it(`${name}: skipped, order and units untouched, no alert; the next pass reads again`, async () => {
      w = await makeWorld();
      const a = await awaiting(w);
      w.tick(DAY + 1000);
      w.paypal.queue.get.push(answer as never);
      const r = await runDue(w.deps, PASS);
      expect([r.abandoned, r.processed]).toEqual([0, 0]);
      expect(await orderStatus(w, a.order_id)).toBe('awaiting_buyer');
      expect(await unitStates(a.order_id)).toEqual(['expected']);
      expect(await alertCount(a.order_id)).toBe(0);
      expect(reads(a.provider_order_id)).toBe(1);
      // the order is still overdue (its PayPal order exists, so the next read can settle it)
      expect(Date.parse((await nextDueAt(w.db, w.deps.config)) ?? '')).toBeLessThanOrEqual(
        w.clock.now().getTime(),
      );
      expect((await runDue(w.deps, PASS)).abandoned).toBe(1);
    });
  }
});

describe('(e) a pack (two PayPal orders) is left as it was', () => {
  const PACK = { offers: ['ofr_1', 'ofr_3'] };
  it('both PayPal orders gone: skipped, nothing abandoned or declined, one read per pass, order still overdue', async () => {
    w = await makeWorld();
    const a = await awaiting(w, PACK);
    expect(a.provider_orders).toHaveLength(2);
    for (const po of a.provider_orders) gone(po.provider_order_id as string);
    w.tick(DAY + 1000);
    for (let i = 0; i < 3; i += 1) {
      const r = await runDue(w.deps, PASS);
      expect(r).toEqual(ZERO);
      w.tick(1000);
    }
    expect(await orderStatus(w, a.order_id)).toBe('awaiting_buyer');
    expect(await poStates(a.order_id)).toEqual(['awaiting_buyer', 'awaiting_buyer']);
    expect(await unitStates(a.order_id)).toEqual(['expected', 'expected']);
    expect(await alertCount(a.order_id)).toBe(0);
    // the sweep reads one PayPal order per pass, as before
    expect(w.paypal.calls.filter((c) => c.op === 'get')).toHaveLength(3);
    expect(w.paypal.count('capture')).toBe(0);
  });

  it('a pack that PayPal still knows (nobody approved) is abandoned by the old rule, with its units declined', async () => {
    w = await makeWorld();
    const a = await awaiting(w, PACK);
    w.tick(DAY + 1000);
    expect((await runDue(w.deps, PASS)).abandoned).toBe(1);
    expect(await orderStatus(w, a.order_id)).toBe('abandoned');
    expect(await unitStates(a.order_id)).toEqual(['declined', 'declined']);
  });
});

describe('an order that never reached the buyer is unchanged', () => {
  it('created, create never sent: abandoned after 24 h with no call', async () => {
    w = await makeWorld();
    const p = await place(w);
    w.tick(DAY + 1000);
    expect((await runDue(w.deps, PASS)).abandoned).toBe(1);
    expect(await orderStatus(w, p.order_id)).toBe('abandoned');
    expect(w.paypal.calls).toHaveLength(0);
  });
});
