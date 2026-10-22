// MVP-A acceptance A-20 and A-21 (adversarial): one buyer cannot read another buyer's order,
// entitlement, link, receipt or case; the data-access functions refuse a missing or wrong actor;
// the ledger, receipts, approvals, access events and audit log refuse UPDATE and DELETE.
// Expected results are the text of docs/design/mvp-plan.md. Offline only.
import { getEntitlementForBuyer } from '@umsbx/entitlements';
import { issueLink } from '@umsbx/delivery';
import { getLibrary } from '@umsbx/library';
import { beginCheckout, onBuyerReturn } from '@umsbx/payments';
import { getReceiptForBuyer } from '@umsbx/receipts';
import { listCasesForBuyer, openCase } from '@umsbx/recovery';
import { describe, expect, it } from 'vitest';
import type { Actor } from '@umsbx/contracts';
import { BUYER_A, BUYER_B, buy, makeWorld, one, placeAndCheckout } from './world';

describe('A-20 buyer_isolation', () => {
  it("buyer B asking for buyer A's order, entitlement, link, receipt or case gets nothing", async () => {
    const w = await makeWorld();
    const a = await buy(w, BUYER_A, 'tide-tables');
    const e = await one<{ id: string }>(w, 'SELECT id FROM entitlements LIMIT 1');

    // order
    const ret = await onBuyerReturn(w.deps, { order_ref: a.order_ref, actor: BUYER_B });
    expect(ret.ok).toBe(false);
    if (!ret.ok) expect(ret.error.code).toBe('not_found');
    const co = await beginCheckout(w.deps, { order_id: a.order_id, actor: BUYER_B });
    expect(co.ok).toBe(false);
    if (!co.ok) expect(co.error.code).toBe('not_found');
    // entitlement
    expect(
      await getEntitlementForBuyer(w.td.db, { entitlement_id: e.id, buyer_id: 'buy_B' }),
    ).toBeNull();
    expect(
      await getEntitlementForBuyer(w.td.db, { entitlement_id: e.id, buyer_id: 'buy_A' }),
    ).not.toBeNull();
    // link
    const link = await issueLink(w.deps, { entitlement_id: e.id, actor: BUYER_B });
    expect(link.ok).toBe(false);
    if (!link.ok) expect(link.error.code).toBe('not_found');
    // receipt
    expect(
      await getReceiptForBuyer(w.td.db, { order_id: a.order_id, buyer_id: 'buy_B' }),
    ).toBeNull();
    expect(
      await getReceiptForBuyer(w.td.db, { order_id: a.order_id, buyer_id: 'buy_A' }),
    ).not.toBeNull();
    // library
    expect(await getLibrary(w.td.db, { buyer_id: 'buy_B', now: w.td.clock.now() })).toEqual([]);
    // case
    const mine = await openCase(w.td, {
      kind: 'delivery_failed',
      order_id: a.order_id,
      entitlement_id: e.id,
      opened_by: 'buyer',
      actor: BUYER_A,
    });
    expect(mine.ok).toBe(true);
    const theirs = await openCase(w.td, {
      kind: 'delivery_failed',
      order_id: a.order_id,
      entitlement_id: e.id,
      opened_by: 'buyer',
      actor: BUYER_B,
    });
    expect(theirs.ok).toBe(false);
    expect(await listCasesForBuyer(w.td.db, { buyer_id: 'buy_B' })).toEqual([]);
  });

  it('the data-access functions refuse a missing, non-buyer or malformed actor', async () => {
    const w = await makeWorld();
    const a = await buy(w, BUYER_A, 'tide-tables');
    const e = await one<{ id: string }>(w, 'SELECT id FROM entitlements LIMIT 1');
    const others: Actor[] = [
      { kind: 'publisher', publisher_id: 'pub_x' },
      { kind: 'operator', operator_id: 'opr_demo', mfa: false },
      { kind: 'system', reason: 'sweep' } as unknown as Actor,
    ];
    for (const actor of others) {
      const link = await issueLink(w.deps, { entitlement_id: e.id, actor });
      expect(link.ok).toBe(false);
      const ret = await onBuyerReturn(w.deps, { order_ref: a.order_ref, actor });
      expect(ret.ok).toBe(false);
    }
    // no actor at all (a caller that forgot to pass one)
    await expect(
      issueLink(w.deps, { entitlement_id: e.id, actor: undefined as unknown as Actor }),
    ).rejects.toThrow();
    // The check is only meaningful while the library is not empty: buyer A's own read has rows.
    expect((await getLibrary(w.td.db, { buyer_id: 'buy_A' })).length).toBeGreaterThan(0);
    expect(await getLibrary(w.td.db, { buyer_id: undefined as unknown as string })).toEqual([]);
    expect(await getLibrary(w.td.db, { buyer_id: '' })).toEqual([]);
    expect(
      await getEntitlementForBuyer(w.td.db, { entitlement_id: e.id, buyer_id: '' }),
    ).toBeNull();
  });

  it("an order that is open for buyer A is invisible to buyer B's checkout", async () => {
    const w = await makeWorld();
    const a = await placeAndCheckout(w, BUYER_A, 'tide-tables');
    const co = await beginCheckout(w.deps, { order_id: a.order_id, actor: BUYER_B });
    expect(co.ok).toBe(false);
  });
});

describe('A-21 ledger_append_only', () => {
  const denied = async (w: Awaited<ReturnType<typeof makeWorld>>, sql: string) => {
    let message = '';
    try {
      await w.td.db.query(sql);
    } catch (error) {
      message = String((error as Error).message);
    }
    // A syntax or column error must not pass for a protection: the trigger's own words are needed.
    return /is not allowed: (the table is append-only|rows are switched off)|can only be updated to set used_at|is immutable except used_at|is already used and cannot change/i.test(
      message,
    )
      ? message
      : `OTHER: ${message}`;
  };

  it('UPDATE and DELETE on ledger, receipts, approvals, access events and audit log raise', async () => {
    const w = await makeWorld();
    await buy(w, BUYER_A, 'tide-tables');
    for (const table of ['ledger_entries', 'receipts', 'approvals', 'access_events', 'audit_log']) {
      const present = Number((await one<{ c: string }>(w, `SELECT count(*) AS c FROM ${table}`)).c);
      expect(present, `${table} has no rows to protect`).toBeGreaterThan(0);
    }
    const updates: Record<string, string> = {
      ledger_entries: 'UPDATE ledger_entries SET amount_minor = amount_minor + 1',
      receipts: "UPDATE receipts SET sha256 = repeat('a', 64)",
      approvals: "UPDATE approvals SET expires_at = expires_at + interval '1 day'",
      access_events: "UPDATE access_events SET kind = 'revoked'",
      audit_log: "UPDATE audit_log SET action = 'x'",
    };
    for (const [table, sql] of Object.entries(updates)) {
      expect(await denied(w, sql), `UPDATE ${table} was allowed`).toMatch(/^(?!OTHER).+/s);
      expect(await denied(w, `DELETE FROM ${table}`), `DELETE ${table} was allowed`).toMatch(
        /^(?!OTHER).+/s,
      );
      expect(await denied(w, `TRUNCATE ${table} CASCADE`), `TRUNCATE ${table} was allowed`).toMatch(
        /^(?!OTHER).+/s,
      );
    }
    const amount = await one<{ s: string | number }>(
      w,
      "SELECT sum(amount_minor) AS s FROM ledger_entries WHERE kind = 'sale'",
    );
    expect(Number(amount.s)).toBe(40);
  });

  it('the outbound approval rows are append-only too', async () => {
    const w = await makeWorld();
    await w.td.db.query(
      `INSERT INTO outbound_approvals (id, approval_ref, scope, operations, max_amount_minor, max_calls_per_day, valid_until, approved_by, created_at, updated_at)
       VALUES ('oap_gate1', 'gate-ref-1', 'gate', ARRAY['create_order'], 100, 1, '2026-12-01T00:00:00Z', 'owner', '2026-10-21T10:00:00Z', '2026-10-21T10:00:00Z')`,
    );
    expect(await denied(w, 'UPDATE outbound_approvals SET max_calls_per_day = 99')).toMatch(
      /^(?!OTHER).+/s,
    );
    expect(await denied(w, 'DELETE FROM outbound_approvals')).toMatch(/^(?!OTHER).+/s);
  });
});
