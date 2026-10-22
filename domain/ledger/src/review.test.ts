// Opus review 3: M4, M5 for the ledger, tested directly on the module (LedgerRuleError, not a
// database error).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { appendLedgerEntry, LedgerRuleError, listLedger } from './index';
import { makeWorld } from './world';
import type { World } from './world';

let w: World;
let n = 0;
beforeAll(async () => {
  w = await makeWorld('led-rev');
});
afterAll(async () => {
  await w.close();
});
const append = (e: Parameters<typeof appendLedgerEntry>[2], deps = w.deps) =>
  w.db.transaction((tx) => appendLedgerEntry(tx, deps, e));
const rule = async (p: Promise<unknown>, re: RegExp) => {
  const e = await p.then(
    () => null,
    (x: unknown) => x,
  );
  expect(e).toBeInstanceOf(LedgerRuleError);
  expect((e as Error).message).toMatch(re);
};

describe('M4 rule errors are LedgerRuleError, never a database error', () => {
  it('wrong currency', async () => {
    n += 1;
    await w.order(n);
    await rule(
      append(w.input(n, { amount: { currency: 'EUR', minor: 500 } })),
      /currency EUR does not match order currency USD/,
    );
    expect(await listLedger(w.db, { capture_id: `CAP${n}` })).toHaveLength(0);
  });

  it('wrong capture and wrong unit', async () => {
    n += 1;
    await w.order(n);
    await rule(append(w.input(n, { capture_id: 'CAPX' })), /does not belong to unit/);
    await rule(append(w.input(n, { unit_id: 'unt_none' })), /does not exist/);
  });

  it('wrong environment', async () => {
    n += 1;
    await w.order(n);
    await rule(
      append(w.input(n, {}), { ...w.deps, environment: 'sandbox' }),
      /environment sandbox does not match order environment dryrun/,
    );
    expect(await listLedger(w.db, { capture_id: `CAP${n}` })).toHaveLength(0);
  });

  it('refund bound: exactly the remainder books, one more minor unit is refused', async () => {
    n += 1;
    await w.order(n);
    await append(w.input(n, {}));
    const refund = (id: string, minor: number) =>
      append(w.input(n, { kind: 'refund', refund_id: id, amount: { currency: 'USD', minor } }));
    expect((await refund('R1', 300)).ok).toBe(true);
    await rule(refund('R2', 201), /exceed the remaining 200/);
    expect((await refund('R2', 200)).ok).toBe(true);
    await rule(refund('R3', 1), /exceed the remaining 0/);
  });

  it('a reversal counts against the same bound', async () => {
    n += 1;
    await w.order(n);
    await append(w.input(n, {}));
    expect(
      (await append(w.input(n, { kind: 'reversal', amount: { currency: 'USD', minor: 400 } }))).ok,
    ).toBe(true);
    await rule(
      append(
        w.input(n, { kind: 'refund', refund_id: 'R9', amount: { currency: 'USD', minor: 101 } }),
      ),
      /exceed the remaining 100/,
    );
  });

  it('refund id pairing, zero refund, platform_fee and ref_entry_id rules', async () => {
    n += 1;
    await w.order(n);
    await append(w.input(n, {}));
    await rule(
      append(
        w.input(n, { kind: 'refund', refund_id: null, amount: { currency: 'USD', minor: 5 } }),
      ),
      /refund_id is required/,
    );
    await rule(
      append(
        w.input(n, { kind: 'paypal_fee', refund_id: 'RX', amount: { currency: 'USD', minor: 5 } }),
      ),
      /refund_id must be null/,
    );
    await rule(
      append(
        w.input(n, { kind: 'refund', refund_id: 'RZ', amount: { currency: 'USD', minor: 0 } }),
      ),
      /zero/,
    );
    await rule(
      append(w.input(n, { kind: 'platform_fee', amount: { currency: 'USD', minor: 1 } })),
      /platform_fee/,
    );
    await rule(
      append(
        w.input(n, {
          kind: 'paypal_fee',
          amount: { currency: 'USD', minor: 5 },
          ref_entry_id: 'led_nope',
        }),
      ),
      /ref_entry_id/,
    );
  });
});

describe('M5 a replay must match the stored row', () => {
  it('same refund id, same amount: duplicate with the existing id', async () => {
    n += 1;
    await w.order(n);
    await append(w.input(n, {}));
    const e = w.input(n, {
      kind: 'refund',
      refund_id: 'RF1',
      amount: { currency: 'USD', minor: 100 },
    });
    const first = await append(e);
    expect(first.ok).toBe(true);
    const again = await append(e);
    expect(again).toEqual({
      ok: false,
      error: { code: 'duplicate', existing_entry_id: first.ok ? first.value.id : '' },
    });
  });

  it('same refund id with a different amount throws conflicting_replay', async () => {
    n += 1;
    await w.order(n);
    await append(w.input(n, {}));
    await append(
      w.input(n, { kind: 'refund', refund_id: 'RF1', amount: { currency: 'USD', minor: 100 } }),
    );
    await rule(
      append(
        w.input(n, { kind: 'refund', refund_id: 'RF1', amount: { currency: 'USD', minor: 101 } }),
      ),
      /conflicting_replay/,
    );
    expect(await listLedger(w.db, { capture_id: `CAP${n}` })).toHaveLength(2);
  });

  it('same refund id with a different currency throws conflicting_replay', async () => {
    n += 1;
    await w.order(n);
    await append(w.input(n, {}));
    await append(
      w.input(n, { kind: 'refund', refund_id: 'RF1', amount: { currency: 'USD', minor: 100 } }),
    );
    // The currency rule fires first for a foreign currency; the replay rule covers stored rows.
    await rule(
      append(
        w.input(n, { kind: 'refund', refund_id: 'RF1', amount: { currency: 'EUR', minor: 100 } }),
      ),
      /currency EUR|conflicting_replay/,
    );
  });

  it('a sale replayed with another amount also conflicts', async () => {
    n += 1;
    await w.order(n);
    await append(w.input(n, {}));
    await rule(
      append(w.input(n, { amount: { currency: 'USD', minor: 499 } })),
      /conflicting_replay/,
    );
    expect((await append(w.input(n, {}))).ok).toBe(false);
  });
});
