// BR-4 adversarial: the refund deadline cannot be skipped by stripping the terms, by a caller's clock,
// by a short or missing reason, by a missing second factor, or by repeating the request; and the
// override reason never reaches the journal in any form but its sha256 (the audit row holds the text,
// the journal holds the hash). Real PGlite, scripted PayPal.
import { afterEach, describe, expect, it } from 'vitest';
import type { Id } from '@umsbx/contracts';
import { requestRefund } from './index';
import {
  OPERATOR,
  makeWorld,
  paid,
  rewriteSnapshot,
  setClockFacts,
  withAudit,
} from './ops/support';
import type { OpsWorld } from './ops/support';

let w: OpsWorld;
afterEach(async () => {
  expect(w.paypal.violations).toEqual([]);
  await w.close();
});

const DAY = 86_400_000;
const START = '2026-11-01T10:00:00.000Z';
const at = (iso: string, ms: number) => new Date(new Date(iso).getTime() + ms).toISOString();
const DEADLINE = at(START, 7 * DAY);
const CANARY = 'CANARY-OVERRIDE-REASON-7f3a9c';

async function lateSale() {
  w = await makeWorld();
  const a = await paid(w);
  await setClockFacts(w, a.order_id, {
    access_started_at: START,
    captured_verified_at: at(START, -DAY),
  });
  const unit = (
    await w.rows<{ id: string }>('SELECT id FROM order_units WHERE order_id = $1', [a.order_id])
  )[0]!;
  w.clock.set(at(DEADLINE, 2 * DAY));
  return { a, unit_id: unit.id as Id };
}
type Extra = Record<string, unknown>;
function ask(unit_id: Id, extra: Extra = {}, actor: unknown = OPERATOR) {
  return requestRefund(withAudit(w), {
    unit_id,
    amount: null,
    reason: 'goodwill',
    actor,
    ...extra,
  } as never);
}
const requests = () => w.rows<{ id: string }>('SELECT id FROM refund_requests');
const overrides = () =>
  w.rows<{ id: string }>("SELECT id FROM audit_log WHERE action = 'refund_outside_window'");

describe('a stripped or damaged terms block is never read as "no deadline"', () => {
  it('a version 2 snapshot without terms is refused', async () => {
    const { a, unit_id } = await lateSale();
    await rewriteSnapshot(w, a.order_id, (s) => {
      return Object.fromEntries(Object.entries(s).filter(([k]) => k !== 'terms'));
    });
    expect(await ask(unit_id)).toEqual({ ok: false, error: { code: 'refund_window_closed' } });
    expect(await requests()).toEqual([]);
  });

  it('a version 2 snapshot without terms is refused even inside what would have been the window', async () => {
    const { a, unit_id } = await lateSale();
    await rewriteSnapshot(w, a.order_id, (s) => {
      return Object.fromEntries(Object.entries(s).filter(([k]) => k !== 'terms'));
    });
    w.clock.set(at(START, DAY));
    expect(await ask(unit_id)).toEqual({ ok: false, error: { code: 'refund_window_closed' } });
  });

  it('terms with a value outside the safe range are refused', async () => {
    const { a, unit_id } = await lateSale();
    await rewriteSnapshot(w, a.order_id, (s) => {
      const terms = s['terms'] as { values: Record<string, number> };
      return {
        ...s,
        terms: { ...terms, values: { ...terms.values, 'refund.request_window': 400 } },
      };
    });
    w.clock.set(at(START, DAY));
    expect(await ask(unit_id)).toEqual({ ok: false, error: { code: 'refund_window_closed' } });
  });

  it('a version 1 label with terms left in place is refused, not read as version 1', async () => {
    const { a, unit_id } = await lateSale();
    await rewriteSnapshot(w, a.order_id, (s) => ({ ...s, snapshot_version: '1' }));
    expect(await ask(unit_id)).toEqual({ ok: false, error: { code: 'refund_window_closed' } });
  });

  it('an unknown snapshot version is refused', async () => {
    const { a, unit_id } = await lateSale();
    await rewriteSnapshot(w, a.order_id, (s) => ({ ...s, snapshot_version: '9' }));
    expect(await ask(unit_id)).toEqual({ ok: false, error: { code: 'refund_window_closed' } });
  });

  it('an operator may still override a damaged block, with a reason and an audit row', async () => {
    const { a, unit_id } = await lateSale();
    await rewriteSnapshot(w, a.order_id, (s) => {
      return Object.fromEntries(Object.entries(s).filter(([k]) => k !== 'terms'));
    });
    expect((await ask(unit_id, { override_reason: 'terms block damaged, buyer paid' })).ok).toBe(
      true,
    );
    expect(await overrides()).toHaveLength(1);
  });
});

describe('the caller cannot choose the time', () => {
  it('an extra time field in the input is ignored; only the server clock counts', async () => {
    const { unit_id } = await lateSale();
    for (const key of ['at', 'now', 'requested_at', 'created_at', 'clock', 'buyer_time']) {
      expect(await ask(unit_id, { [key]: at(START, DAY) })).toEqual({
        ok: false,
        error: { code: 'refund_window_closed' },
      });
    }
    expect(await requests()).toEqual([]);
  });

  it('a case row stamped in the future is not a case opened in time', async () => {
    const { a, unit_id } = await lateSale();
    await w.insert('recovery_cases', {
      id: 'cas_skew',
      kind: 'refund_requested',
      state: 'open',
      order_id: a.order_id,
      entitlement_id: null,
      buyer_id: 'buy_A',
      opened_by: 'buyer',
      sla_due_at: at(START, 9 * DAY),
      credit_ms: 0,
      buyer_message: 'asked',
      created_at: at(DEADLINE, 400 * DAY),
      updated_at: at(DEADLINE, 400 * DAY),
    });
    expect(await ask(unit_id)).toEqual({ ok: false, error: { code: 'refund_window_closed' } });
  });
});

describe('the override reason', () => {
  it.each([
    ['empty', ''],
    ['one character', 'x'],
    ['two characters', 'ab'],
    ['only spaces', '      '],
    ['201 characters', 'x'.repeat(201)],
  ])('%s is refused and nothing is stored', async (_name, reason) => {
    const { unit_id } = await lateSale();
    expect(await ask(unit_id, { override_reason: reason })).toEqual({
      ok: false,
      error: { code: 'refund_window_closed' },
    });
    expect(await requests()).toEqual([]);
    expect(await overrides()).toEqual([]);
  });

  it.each([
    ['three characters', 'abc'],
    ['200 characters', 'x'.repeat(200)],
    ['three characters between spaces', '  abc  '],
  ])('%s is accepted', async (_name, reason) => {
    const { unit_id } = await lateSale();
    expect((await ask(unit_id, { override_reason: reason })).ok).toBe(true);
    expect(await overrides()).toHaveLength(1);
  });

  it('a value that is not a string is refused', async () => {
    const { unit_id } = await lateSale();
    for (const bad of [123, null, {}, ['abc'], true]) {
      expect(await ask(unit_id, { override_reason: bad })).toEqual({
        ok: false,
        error: { code: 'refund_window_closed' },
      });
    }
    expect(await requests()).toEqual([]);
  });

  it('a session without the second factor is refused before the window is read', async () => {
    const { unit_id } = await lateSale();
    const r = await ask(
      unit_id,
      { override_reason: 'ticket 4411 goodwill' },
      { kind: 'operator', operator_id: 'opr_1', mfa: false },
    );
    expect(r).toEqual({ ok: false, error: { code: 'mfa_required' } });
    expect(await requests()).toEqual([]);
    expect(await overrides()).toEqual([]);
  });

  it('a buyer, a publisher and the system cannot override', async () => {
    const { unit_id } = await lateSale();
    for (const actor of [
      { kind: 'buyer', buyer_id: 'buy_A' },
      { kind: 'publisher', publisher_id: 'pub_1' },
      { kind: 'system' },
    ]) {
      expect(await ask(unit_id, { override_reason: 'ticket 4411 goodwill' }, actor)).toEqual({
        ok: false,
        error: { code: 'not_operator' },
      });
    }
    expect(await requests()).toEqual([]);
  });

  it('a second request while the first is open writes one audit row, not two', async () => {
    const { unit_id } = await lateSale();
    expect((await ask(unit_id, { override_reason: 'ticket 4411 goodwill' })).ok).toBe(true);
    for (let n = 0; n < 3; n += 1) {
      expect(await ask(unit_id, { override_reason: 'ticket 4411 goodwill' })).toEqual({
        ok: false,
        error: { code: 'refund_in_flight' },
      });
    }
    expect(await overrides()).toHaveLength(1);
    expect(await requests()).toHaveLength(1);
  });
});

describe('the override reason in the journal', () => {
  const dump = async (table: string): Promise<string> =>
    (
      await w.db.query<{ t: string }>(
        `SELECT coalesce(string_agg(x::text, E'\\n'), '') AS t FROM ${table} x`,
      )
    ).rows[0]!.t;

  it('is in the audit row as text and in trace_events only as its sha256', async () => {
    const { unit_id } = await lateSale();
    expect((await ask(unit_id, { override_reason: CANARY })).ok).toBe(true);
    const audit = (
      await w.rows<{ id: string; reason: string }>(
        "SELECT id, reason FROM audit_log WHERE action = 'refund_outside_window'",
      )
    )[0]!;
    expect(audit.reason).toBe(CANARY);
    for (const table of ['trace_events', 'trace_context', 'trace_heads', 'trace_seals']) {
      const text = await dump(table);
      expect(text, table).not.toContain(CANARY);
      expect(text, table).not.toMatch(/canary-override/i);
    }
    const sha = (
      await w.db.query<{ h: string }>("SELECT encode(sha256(convert_to($1, 'UTF8')), 'hex') AS h", [
        CANARY,
      ])
    ).rows[0]!.h;
    const events = await w.rows<{ body: { hashed: Record<string, [string, string]> } }>(
      "SELECT body FROM trace_events WHERE source_table = 'audit_log' AND source_id = $1",
      [audit.id],
    );
    expect(events.length).toBeGreaterThan(0);
    expect(events[0]!.body.hashed['reason']![1]).toBe(sha);
  });

  it('the refund request row never carries the override reason', async () => {
    const { unit_id } = await lateSale();
    expect((await ask(unit_id, { override_reason: CANARY })).ok).toBe(true);
    const rows = await w.rows<{ reason: string }>('SELECT reason FROM refund_requests');
    expect(rows.map((r) => r.reason)).toEqual(['goodwill']);
    expect(await dump('refund_requests')).not.toContain(CANARY);
  });
});
