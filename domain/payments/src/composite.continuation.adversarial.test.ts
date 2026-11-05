// DP-2b (MVP-D): adversarial cases of the background paths of a pack: many actors at once, a process
// that dies between the captures, a decline racing a capture, the one writer of orders.status, and
// the lock order of the new transactions. PGlite serialises statements, so these prove the gates and
// the re-checks, not Postgres lock behaviour (ASM-55: the real-Postgres race tests are separate).
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import type { Logger, PaymentsDeps, ProviderEvent, SqlExecutor } from '@umsbx/contracts';
import {
  beginCheckout,
  checkInvariants,
  handleWebhook,
  onBuyerReturn,
  reconcileOrder,
  recoverOnStartup,
  runDue,
} from './index';
import { captureOnce } from './capture';
import { loadOrder, loadProviderOrders } from './store';
import {
  BUYER_A,
  approved,
  awaiting,
  count,
  makeWorld,
  place,
  providerOrdersOf,
} from './ops/support';
import type { Awaiting, OpsWorld } from './ops/support';

let w: OpsWorld;

/** A world whose log records every error event: a swallowed failure in a pass must fail the test, not hide in it. */
const logged: string[] = [];
async function world(): Promise<OpsWorld> {
  const x = await makeWorld();
  const log: Logger = {
    log: (e) => {
      if (e.level === 'error') logged.push(`${e.msg} ${JSON.stringify(e.fields)}`);
    },
    child: () => log,
  };
  x.deps = { ...x.deps, log };
  return x;
}
afterEach(async () => {
  expect(logged.splice(0)).toEqual([]);
  expect(w.paypal.violations).toEqual([]);
  await w.close();
});

const PACK = { offers: ['ofr_1', 'ofr_3'] };
const H = 3_600_000;
const ret = (ref: string, d: PaymentsDeps = w.deps) =>
  onBuyerReturn(d, { order_ref: ref, actor: BUYER_A });
const poIds = (a: Awaiting): string[] =>
  a.provider_orders.map((p) => p.provider_order_id as string);
const states = async (order_id: string): Promise<string[]> =>
  (await providerOrdersOf(w, order_id)).map((p) => p.state);
const orderStatus = async (id: string) =>
  (await w.rows<{ status: string }>('SELECT status FROM orders WHERE id = $1', [id]))[0]!.status;
const capCalls = () => w.paypal.calls.filter((c) => c.op === 'capture');
/** Executed captures at PayPal, by PayPal order: the fake records the key of the capture it performed. */
const executed = (a: Awaiting): (string | null)[] =>
  poIds(a).map((id) => w.paypal.orders.get(id)!.capture_request_id);
let seq = 0;
const ev = (o: Partial<ProviderEvent> = {}): ProviderEvent => {
  seq += 1;
  return {
    event_id: `WH-ADV-${seq}`,
    transmission_id: `txa-${seq}`,
    type: 'PAYMENT.CAPTURE.COMPLETED',
    provider_order_id: null,
    capture_id: null,
    refund_id: null,
    occurred_at: w.clock.now().toISOString(),
    ...o,
  };
};
const deliver = (e: ProviderEvent) =>
  handleWebhook(w.deps, {
    verdict: { kind: 'verified', event: e },
    transmission_id: e.transmission_id,
    received_at: w.clock.now().toISOString(),
  });

/** The process dies at the status read of PO2, the 4th read of the return: PO1 captured, PO2 approved. */
async function crashBetweenCaptures(): Promise<Awaited<ReturnType<typeof approved>>> {
  const a = await approved(w, PACK);
  const base = w.paypal.count('get');
  w.paypal.beforeGet = async () => {
    if (w.paypal.count('get') === base + 4) {
      w.paypal.beforeGet = null;
      throw new Error('process died between the captures');
    }
  };
  await expect(ret(a.order_ref)).rejects.toThrow('died between the captures');
  w.paypal.beforeGet = null;
  return a;
}

describe('many actors at once', () => {
  it('return, poll, sweep and webhook at once: one capture per PayPal order', async () => {
    w = await world();
    const a = await approved(w, PACK);
    const seen: string[] = [];
    w.paypal.beforeGet = async () => {
      seen.push(await orderStatus(a.order_id));
    };
    await Promise.all([
      ret(a.order_ref),
      ret(a.order_ref),
      ret(a.order_ref),
      runDue(w.deps, { max_items: 10 }),
      runDue(w.deps, { max_items: 10 }),
      runDue(w.deps, { max_items: 10, allow: 'money_only' }),
      reconcileOrder(w.deps, { order_id: a.order_id, trigger: 'poll' }),
      deliver(ev({ type: 'CHECKOUT.ORDER.APPROVED', provider_order_id: poIds(a)[0]! })),
      deliver(ev({ provider_order_id: poIds(a)[1]! })),
    ]);
    w.paypal.beforeGet = null;
    await runDue(w.deps, { max_items: 10 });
    for (const id of poIds(a)) {
      expect(capCalls().filter((c) => c.provider_order_id === id)).toHaveLength(1);
    }
    expect(executed(a)).toEqual([`umsK-${a.order_ref}-p1`, `umsK-${a.order_ref}-p2`]);
    expect(await states(a.order_id)).toEqual(['captured', 'captured']);
    expect(await orderStatus(a.order_id)).toBe('paid');
    expect(await count(w, 'ledger_entries', "kind = 'sale'")).toBe(2);
    expect((await checkInvariants(w.db)).filter((i) => !i.ok)).toEqual([]);
  });

  it('after the first capture was sent, the status never goes back to awaiting_buyer, whoever acts', async () => {
    w = await world();
    const a = await crashBetweenCaptures();
    const seen: string[] = [];
    w.paypal.beforeGet = async () => {
      seen.push(await orderStatus(a.order_id));
    };
    await Promise.all([
      ret(a.order_ref),
      ret(a.order_ref),
      runDue(w.deps, { max_items: 10 }),
      runDue(w.deps, { max_items: 10 }),
      runDue(w.deps, { max_items: 10, allow: 'money_only' }),
      reconcileOrder(w.deps, { order_id: a.order_id, trigger: 'poll' }),
      deliver(ev({ provider_order_id: poIds(a)[1]! })),
      deliver(ev({ provider_order_id: poIds(a)[0]! })),
    ]);
    w.paypal.beforeGet = null;
    expect(seen.length).toBeGreaterThan(0);
    expect(seen).not.toContain('awaiting_buyer');
    expect(capCalls().filter((c) => c.provider_order_id === poIds(a)[1])).toHaveLength(1);
    expect(executed(a)).toEqual([`umsK-${a.order_ref}-p1`, `umsK-${a.order_ref}-p2`]);
    expect(await orderStatus(a.order_id)).toBe('paid');
    expect(await count(w, 'ledger_entries', "kind = 'sale'")).toBe(2);
  });
});

describe('a process that dies between the captures', () => {
  type Crash = (a: Awaiting) => Promise<void>;
  const crashes: [string, (a: Awaiting) => Promise<void>, Crash][] = [
    [
      'PO2 capture never reaches PayPal',
      async () => {
        const base = w.paypal.count('get');
        w.paypal.beforeGet = async () => {
          if (w.paypal.count('get') === base + 4) {
            w.paypal.beforeGet = null;
            w.faults.dieBeforeCapture = true;
          }
        };
      },
      async (a) => {
        await expect(ret(a.order_ref)).rejects.toThrow('died before the capture');
        w.faults.dieBeforeCapture = false;
      },
    ],
    [
      'PO2 capture happens, the process dies before the answer is recorded',
      async () => {
        const base = w.paypal.count('get');
        w.paypal.beforeGet = async () => {
          if (w.paypal.count('get') === base + 4) {
            w.paypal.beforeGet = null;
            w.paypal.crashAfterCapture = true;
          }
        };
      },
      async (a) => {
        await expect(ret(a.order_ref)).rejects.toThrow('process died after the capture');
        w.paypal.crashAfterCapture = false;
      },
    ],
    [
      'PO1 capture happens, the process dies before the answer is recorded',
      async () => {
        w.paypal.crashAfterCapture = true;
      },
      async (a) => {
        await expect(ret(a.order_ref)).rejects.toThrow('process died after the capture');
        w.paypal.crashAfterCapture = false;
      },
    ],
    [
      'the process dies at the status read of PO2',
      async () => {
        const base = w.paypal.count('get');
        w.paypal.beforeGet = async () => {
          if (w.paypal.count('get') === base + 4) {
            w.paypal.beforeGet = null;
            throw new Error('process died between the captures');
          }
        };
      },
      async (a) => {
        await expect(ret(a.order_ref)).rejects.toThrow('died between the captures');
      },
    ],
  ];
  it.each(crashes)(
    '%s: terminal within 2 passes after the lease ends',
    async (_name, arm, crash) => {
      w = await world();
      const a = await approved(w, PACK);
      await arm(a);
      await crash(a);
      w.paypal.beforeGet = null;
      w.clock.advance(61_000); // the lease of the dead call is over
      let passes = 0;
      for (; passes < 2; passes += 1) {
        await runDue(w.deps, { max_items: 10 });
        if ((await orderStatus(a.order_id)) === 'paid') break;
        w.clock.advance(31_000);
      }
      expect(await orderStatus(a.order_id)).toBe('paid');
      expect(await states(a.order_id)).toEqual(['captured', 'captured']);
      // each PayPal order was captured once at PayPal, whatever was resent
      expect(executed(a)).toEqual([`umsK-${a.order_ref}-p1`, `umsK-${a.order_ref}-p2`]);
      expect(await count(w, 'ledger_entries', "kind = 'sale'")).toBe(2);
      expect((await checkInvariants(w.db)).filter((i) => !i.ok)).toEqual([]);
    },
  );
});

describe('the PayPal calls of a crash between the captures', () => {
  it('PO2 capture never reaches PayPal: read first, the same key once, read back, nothing else', async () => {
    w = await world();
    const a = await approved(w, PACK);
    const base = w.paypal.count('get');
    w.paypal.beforeGet = async () => {
      if (w.paypal.count('get') === base + 4) {
        w.paypal.beforeGet = null;
        w.faults.dieBeforeCapture = true;
      }
    };
    await expect(ret(a.order_ref)).rejects.toThrow('died before the capture');
    w.faults.dieBeforeCapture = false;
    w.clock.advance(61_000);
    await runDue(w.deps, { max_items: 10 });
    await runDue(w.deps, { max_items: 10 });
    const name = (id: string | null) =>
      id === poIds(a)[0] ? 'PO1' : id === poIds(a)[1] ? 'PO2' : '-';
    expect(
      w.paypal.calls.map((c) =>
        `${c.op} ${name(c.provider_order_id)} ${c.request_id ?? ''}`.trim(),
      ),
    ).toEqual([
      `create - umsC-${a.order_ref}-p1`,
      `create - umsC-${a.order_ref}-p2`,
      'get PO1', // the return: PO1 and PO2 read for the pass
      'get PO2',
      `capture PO1 umsK-${a.order_ref}-p1`,
      'get PO1', // PO1 read back
      'get PO2', // PO2 status read: the process dies after the capture is sent
      `capture PO2 umsK-${a.order_ref}-p2`,
      'get PO2', // the next pass reads first ...
      `capture PO2 umsK-${a.order_ref}-p2`, // ... then sends the same key once ...
      'get PO2', // ... and reads back
    ]);
  });
});

describe('a decline and a capture', () => {
  it('decline and capture race: exactly one wins', async () => {
    for (const order of [
      'capture first',
      'pass first',
      'capture after a turn',
      'pass after a turn',
    ]) {
      w = await world();
      const a = await crashBetweenCaptures();
      w.clock.advance(25 * H + 1); // the deadline has passed: a decline is allowed on a no-capture read
      const row = (await loadProviderOrders(w.db, a.order_id))[1]!;
      const ord = (await loadOrder(w.db, a.order_id))!;
      const doCapture = () => captureOnce(w.deps, ord, poIds(a)[1]!, null, row);
      const doPass = () => runDue(w.deps, { max_items: 10 });
      const turn = () => new Promise<void>((r) => setTimeout(r, 0));
      if (order === 'capture first') await Promise.all([doCapture(), doPass()]);
      else if (order === 'pass first') await Promise.all([doPass(), doCapture()]);
      else if (order === 'capture after a turn')
        await Promise.all([doPass(), turn().then(doCapture)]);
      else await Promise.all([doCapture(), turn().then(doPass)]);
      w.clock.advance(31_000);
      await runDue(w.deps, { max_items: 10 }); // let whatever is open settle
      const po2 = (await states(a.order_id))[1]!;
      const sent = capCalls().filter((c) => c.provider_order_id === poIds(a)[1]);
      if (po2 === 'declined') {
        // the decline won: no capture was sent for PO2 and nothing at PayPal was captured
        expect(sent, order).toHaveLength(0);
        expect(w.paypal.orders.get(poIds(a)[1]!)!.capture, order).toBeNull();
        expect(await orderStatus(a.order_id), order).toBe('paid_partial');
      } else {
        // the capture won: exactly one capture, and the PayPal order was not declined afterwards
        expect(po2, order).toBe('captured');
        expect(sent, order).toHaveLength(1);
        expect(w.paypal.orders.get(poIds(a)[1]!)!.capture, order).not.toBeNull();
        expect(await orderStatus(a.order_id), order).toBe('paid');
        expect(await count(w, 'ledger_entries', "kind = 'sale'"), order).toBe(2);
      }
      expect(
        (await checkInvariants(w.db)).filter((i) => !i.ok),
        order,
      ).toEqual([]);
      expect(w.paypal.violations).toEqual([]);
      await w.close();
    }
    w = await world();
  });

  it('a send that appears between the fresh read and the decline stops the decline (condition 1, re-checked under the lock)', async () => {
    w = await world();
    const a = await approved(w, PACK);
    w.paypal.queue.capture.push('real', {
      kind: 'payer_action',
      redirect_url: 'https://www.sandbox.paypal.com/checkoutnow?token=AGAIN',
      debug_id: 'D',
    });
    await ret(a.order_ref); // PO1 captured, PO2 reopened: approved, capture operation prepared
    expect(await states(a.order_id)).toEqual(['captured', 'approved']);
    w.paypal.void(poIds(a)[1]!);
    w.clock.advance(31_000);
    const real = w.paypal.getOrder.bind(w.paypal);
    let armed = true;
    w.paypal.getOrder = async (id, scenario) => {
      const r = await real(id, scenario);
      if (armed && id === poIds(a)[1]) {
        armed = false;
        // another actor sends PO2's capture right now: its operation is unknown (the answer is lost)
        await w.rows(
          `UPDATE operations SET state = 'unknown', next_retry_at = $2, reconcile_until = $2
            WHERE order_id = $1 AND kind = 'capture' AND provider_order_ref =
                  (SELECT id FROM provider_orders WHERE order_id = $1 AND position = 2)`,
          [a.order_id, new Date(w.clock.now().getTime() + H).toISOString()],
        );
      }
      return r;
    };
    await runDue(w.deps, { max_items: 10 });
    expect(await states(a.order_id)).toEqual(['captured', 'approved']); // not declined
    expect(
      await w.rows("SELECT 1 FROM alerts WHERE kind = 'partial_composite' AND order_id = $1", [
        a.order_id,
      ]),
    ).toEqual([]);
    // the PayPal order waits for the next round: an immediate second pass does not read it again
    const gets = w.paypal.calls.length;
    await runDue(w.deps, { max_items: 10 });
    expect(w.paypal.calls.length).toBe(gets);
  });

  it('a declined or frozen PayPal order is never captured, by any actor', async () => {
    w = await world();
    const a = await crashBetweenCaptures();
    w.paypal.void(poIds(a)[1]!);
    await runDue(w.deps, { max_items: 10 });
    expect(await states(a.order_id)).toEqual(['captured', 'declined']);
    // a second pack, whose PO2 will be held (frozen) instead
    const b = await crashBetweenCaptures2();
    w.paypal.tamperBy.set(poIds(b)[1]!, { payee: 'SBXEVILPAYEE' });
    await runDue(w.deps, { max_items: 10 });
    expect(await states(b.order_id)).toEqual(['captured', 'frozen']);
    w.paypal.tamperBy.delete(poIds(b)[1]!);

    // PayPal says "approved" again for the declined one; no actor sends a capture for either
    w.paypal.orders.get(poIds(a)[1]!)!.status = 'APPROVED';
    const row = (await loadProviderOrders(w.db, a.order_id))[1]!;
    const ord = (await loadOrder(w.db, a.order_id))!;
    expect(await captureOnce(w.deps, ord, poIds(a)[1]!, null, row)).toEqual({ kind: 'lost' });
    const rowB = (await loadProviderOrders(w.db, b.order_id))[1]!;
    const ordB = (await loadOrder(w.db, b.order_id))!;
    expect(await captureOnce(w.deps, ordB, poIds(b)[1]!, null, rowB)).toEqual({ kind: 'lost' });
    await ret(a.order_ref);
    await onBuyerReturn(w.deps, {
      order_ref: b.order_ref,
      actor: { kind: 'buyer', buyer_id: 'buy_B' },
    });
    w.clock.advance(2 * H);
    await runDue(w.deps, { max_items: 10 });
    await recoverOnStartup(w.restart());
    for (const [order, id] of [
      [a, poIds(a)[1]!],
      [b, poIds(b)[1]!],
    ] as const) {
      expect(capCalls().filter((c) => c.provider_order_id === id)).toHaveLength(0);
      expect(order.order_id).toBeTruthy();
    }
    expect(await states(a.order_id)).toEqual(['captured', 'declined']);
    expect(await states(b.order_id)).toEqual(['captured', 'frozen']);
  });
});

/** A second pack of buyer B, crashed between its captures (for tests that need two). */
async function crashBetweenCaptures2(): Promise<Awaited<ReturnType<typeof approved>>> {
  const b = await approved(w, {
    ...PACK,
    buyer_id: 'buy_B',
    actor: { kind: 'buyer', buyer_id: 'buy_B' },
  });
  const base = w.paypal.count('get');
  w.paypal.beforeGet = async () => {
    if (w.paypal.count('get') === base + 4) {
      w.paypal.beforeGet = null;
      throw new Error('process died between the captures');
    }
  };
  await expect(
    onBuyerReturn(w.deps, { order_ref: b.order_ref, actor: { kind: 'buyer', buyer_id: 'buy_B' } }),
  ).rejects.toThrow('died between the captures');
  w.paypal.beforeGet = null;
  return b;
}

describe('orders.status has one writer', () => {
  it('source scan: no UPDATE orders SET status outside composite.ts', async () => {
    w = await world(); // for the afterEach check only
    const root = join(fileURLToPath(new URL('.', import.meta.url)), '..', '..');
    const files: string[] = [];
    const walk = (dir: string): void => {
      for (const name of readdirSync(dir)) {
        if (name === 'node_modules' || name === 'dist') continue;
        const p = join(dir, name);
        if (statSync(p).isDirectory()) walk(p);
        else if (/\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name)) files.push(p);
      }
    };
    walk(root);
    expect(files.length).toBeGreaterThan(20);
    // any UPDATE of orders whose SET list assigns status, over lines, in a plain or a template string
    const writer = /UPDATE\s+orders\s+SET\b[^;`'"]*?\bstatus\s*=/is;
    const offenders = files
      .filter((f) => !f.endsWith(join('payments', 'src', 'composite.ts')))
      // the test worlds (support.ts, ops/support.ts, and the trace seed in trace/src/support.ts) put orders in
      // states nothing else reaches; they are not product code
      .filter((f) => !/(payments[\\/]src[\\/](ops[\\/])?|trace[\\/]src[\\/])support\.ts$/.test(f))
      .filter((f) => writer.test(readFileSync(f, 'utf8')))
      .map((f) => relative(root, f));
    expect(offenders).toEqual([]);
    // and the one allowed writer is still there
    expect(writer.test(readFileSync(join(root, 'payments', 'src', 'composite.ts'), 'utf8'))).toBe(
      true,
    );
  });
});

// ---- lock order -------------------------------------------------------------------------------
const RANK: Record<string, number> = {
  orders: 1,
  provider_orders: 1.5,
  operations: 2,
  order_units: 3,
  refund_requests: 4,
  recovery_cases: 4.5,
  entitlements: 5,
  access_windows: 5,
  access_events: 5,
  access_links: 5,
  ledger_entries: 6,
  receipts: 6,
};
function lockTarget(sql: string): string | null {
  const s = sql.replace(/\s+/g, ' ').trim();
  const write = /^(?:UPDATE|INSERT INTO|DELETE FROM) (\w+)/i.exec(s);
  if (write !== null) return write[1]!.toLowerCase();
  if (!/ FOR UPDATE\b/i.test(s)) return null;
  const of = / FOR UPDATE OF (\w+)/i.exec(s);
  if (of !== null) {
    const hit = new RegExp(`(?:FROM|JOIN) (\\w+)(?: AS)? ${of[1]}\\b`, 'i').exec(s);
    return (hit?.[1] ?? of[1]!).toLowerCase();
  }
  return /FROM (\w+)/i.exec(s)?.[1]?.toLowerCase() ?? null;
}
function spy(d: PaymentsDeps, log: { table: string; sql: string }[][]): PaymentsDeps {
  return {
    ...d,
    db: {
      ...d.db,
      transaction: (fn) => {
        const rec: { table: string; sql: string }[] = [];
        log.push(rec);
        return d.db.transaction((tx) =>
          fn({
            query: (sql: string, params?: unknown[]) => {
              const t = lockTarget(sql);
              if (t !== null)
                rec.push({ table: t, sql: sql.replace(/\s+/g, ' ').trim().slice(0, 120) });
              return tx.query(sql, params);
            },
            exec: (sql: string) => tx.exec(sql),
          } as SqlExecutor),
        );
      },
    },
  };
}
function violations(log: { table: string; sql: string }[][]): string[] {
  const bad: string[] = [];
  for (const tx of log) {
    const held = new Map<number, string>();
    for (const l of tx) {
      const r = RANK[l.table];
      if (r === undefined || held.has(r)) continue;
      const above = [...held.entries()].filter(([k]) => k > r);
      if (above.length > 0) bad.push(`${l.table}(${r}) after rank ${above[0]![0]} by [${l.sql}]`);
      held.set(r, l.sql);
    }
  }
  return [...new Set(bad)];
}

describe('lock order', () => {
  it('lock order spy: the continuation, the decline, the retry, the create resend, the sweep, recovery and the webhook take orders, provider_orders, operations first', async () => {
    const log: { table: string; sql: string }[][] = [];
    const run = async (name: string, f: (d: PaymentsDeps) => Promise<void>): Promise<void> => {
      w = await world();
      const before = log.length;
      await f(spy(w.deps, log));
      expect(log.length, name).toBeGreaterThan(before);
      await w.close();
    };
    await run('continuation', async (d) => {
      await crashBetweenCaptures();
      await runDue(d, { max_items: 10 });
    });
    await run('decline', async (d) => {
      const a = await crashBetweenCaptures();
      w.paypal.void(poIds(a)[1]!);
      await runDue(d, { max_items: 10 });
      expect(await states(a.order_id)).toEqual(['captured', 'declined']);
    });
    await run('retry and reopen', async (d) => {
      const a = await approved(w, PACK);
      w.paypal.queue.capture.push({ kind: 'timeout' });
      await ret(a.order_ref);
      w.paypal.queue.capture.push({
        kind: 'payer_action',
        redirect_url: 'https://www.sandbox.paypal.com/checkoutnow?token=AGAIN',
        debug_id: 'D',
      });
      w.clock.advance(31_000);
      await runDue(d, { max_items: 10 });
    });
    await run('lost lease', async (d) => {
      const a = await approved(w, PACK);
      const base = w.paypal.count('get');
      w.paypal.beforeGet = async () => {
        if (w.paypal.count('get') === base + 4) {
          w.paypal.beforeGet = null;
          w.faults.dieBeforeCapture = true;
        }
      };
      await expect(ret(a.order_ref)).rejects.toThrow('died before the capture');
      w.faults.dieBeforeCapture = false;
      w.clock.advance(61_000);
      await runDue(d, { max_items: 10 });
      expect(await states(a.order_id)).toEqual(['captured', 'captured']);
    });
    await run('create resend and expiry', async (d) => {
      const p = await place(w, PACK);
      w.paypal.queue.create.push('real', { kind: 'timeout' });
      await beginCheckout(w.deps, { order_id: p.order_id, actor: BUYER_A });
      w.clock.advance(31_000);
      await runDue(d, { max_items: 10 });
      const q = await place(w, {
        ...PACK,
        buyer_id: 'buy_B',
        actor: { kind: 'buyer', buyer_id: 'buy_B' },
      });
      w.paypal.queue.create.push('real', { kind: 'timeout' });
      await beginCheckout(w.deps, {
        order_id: q.order_id,
        actor: { kind: 'buyer', buyer_id: 'buy_B' },
      });
      w.clock.advance(5 * H + 1_000);
      await runDue(d, { max_items: 10 });
    });
    await run('abandon sweep and window', async (d) => {
      const a = await awaiting(w, PACK);
      w.paypal.approve(poIds(a)[0]!);
      await ret(a.order_ref, d);
      w.clock.advance(H + 1);
      await runDue(d, { max_items: 10 });
      expect(await states(a.order_id)).toEqual(['abandoned', 'abandoned']);
    });
    await run('recovery, webhook, poll', async (d) => {
      const a = await crashBetweenCaptures();
      await handleWebhook(d, {
        verdict: { kind: 'verified', event: ev({ provider_order_id: poIds(a)[0]! }) },
        transmission_id: 'txa-lock',
        received_at: w.clock.now().toISOString(),
      });
      w.clock.advance(61_000);
      await recoverOnStartup(d);
      await reconcileOrder(d, { order_id: a.order_id, trigger: 'webhook' });
    });
    expect(log.length).toBeGreaterThan(20);
    expect(violations(log)).toEqual([]);
    // every transaction that locked provider_orders locked the order first
    for (const tx of log) {
      const tables = tx.map((l) => l.table);
      const o = tables.indexOf('orders');
      const p = tables.indexOf('provider_orders');
      if (p >= 0 && o >= 0) expect(p, tx.map((l) => l.sql).join(' | ')).toBeGreaterThan(o);
    }
    w = await world();
  });
});
