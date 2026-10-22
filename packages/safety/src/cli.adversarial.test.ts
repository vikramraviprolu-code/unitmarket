import { describe, expect, it } from 'vitest';
import { migrate, openDatabase } from '@umsbx/db';
import { createAuditSink } from '@umsbx/obs';
import { fakeClock, seededIds } from '@umsbx/runtime';
import { checkOperatorTerminal, runApprove, runStop } from './index';

describe('operator CLIs (SOP 2)', () => {
  it('CLI refuses without a TTY and with CI set', () => {
    expect(checkOperatorTerminal({ isTTY: false, env: {} })).toEqual({
      ok: false,
      error: 'not_a_tty',
    });
    expect(checkOperatorTerminal({ isTTY: true, env: { CI: 'true' } })).toEqual({
      ok: false,
      error: 'ci_set',
    });
    expect(checkOperatorTerminal({ isTTY: undefined, env: {} }).ok).toBe(false);
    expect(checkOperatorTerminal({ isTTY: true, env: { CI: '' } }).ok).toBe(true);
    expect(checkOperatorTerminal({ isTTY: true, env: {} }).ok).toBe(true);
  });

  it('runApprove and runStop do nothing without a TTY, with CI set', async () => {
    const d = await openDatabase({ kind: 'pglite-memory' });
    const clock = fakeClock('2026-10-22T10:00:00Z');
    await migrate(d, clock);
    const ids = seededIds('cli');
    const audit = createAuditSink(ids, clock);
    const input = {
      approval_ref: 'DL-1',
      scope: 'mvp_b_polling',
      operations: ['create_order' as const],
      max_amount_minor: 2000,
      max_calls_per_day: 300,
      valid_until: '2026-10-30T00:00:00Z',
      approved_by: 'owner',
    };
    let asked = 0;
    const ask = async () => {
      asked++;
      return 'mvp_b_polling';
    };
    for (const tty of [
      { isTTY: false, env: {} },
      { isTTY: true, env: { CI: '1' } },
    ]) {
      const a = await runApprove({
        db: d,
        clock,
        ids,
        audit,
        tty,
        ask,
        write: () => undefined,
        by: { kind: 'system' },
        input,
      });
      expect(a.ok).toBe(false);
      const s = await runStop({ db: d, clock, audit, tty, by: { kind: 'system' }, reason: 'x' });
      expect(s.ok).toBe(false);
    }
    expect(asked).toBe(0);
    expect((await d.query('SELECT 1 FROM outbound_approvals')).rows).toHaveLength(0);
    expect((await d.query('SELECT 1 FROM audit_log')).rows).toHaveLength(0);
    await d.close();
  });

  it('runApprove refuses a wrong scope name and writes nothing; right name writes one row and audit', async () => {
    const d = await openDatabase({ kind: 'pglite-memory' });
    const clock = fakeClock('2026-10-22T10:00:00Z');
    await migrate(d, clock);
    const ids = seededIds('cli2');
    const audit = createAuditSink(ids, clock);
    const tty = { isTTY: true, env: {} };
    const input = {
      approval_ref: 'DL-1',
      scope: 'mvp_b_polling',
      operations: ['create_order' as const, 'get_order' as const],
      max_amount_minor: 2000,
      max_calls_per_day: 300,
      valid_until: '2026-10-30T00:00:00Z',
      approved_by: 'owner',
    };
    const base = {
      db: d,
      clock,
      ids,
      audit,
      tty,
      write: () => undefined,
      by: { kind: 'system' as const },
      input,
    };
    expect(await runApprove({ ...base, ask: async () => 'nope' })).toEqual({
      ok: false,
      error: 'scope_not_confirmed',
    });
    expect((await d.query('SELECT 1 FROM outbound_approvals')).rows).toHaveLength(0);
    expect(await runApprove({ ...base, ask: async () => 'mvp_b_polling' })).toEqual({
      ok: true,
      value: { approval_ref: 'DL-1' },
    });
    expect((await d.query('SELECT 1 FROM outbound_approvals')).rows).toHaveLength(1);
    expect((await d.query('SELECT 1 FROM audit_log')).rows).toHaveLength(1);
    // append-only: a second row with the same ref is refused, never an update
    expect(await runApprove({ ...base, ask: async () => 'mvp_b_polling' })).toEqual({
      ok: false,
      error: 'duplicate_ref',
    });
    // bad input is refused before asking
    expect(
      (
        await runApprove({
          ...base,
          ask: async () => 'mvp_b_polling',
          input: { ...input, approval_ref: 'DL-2', operations: [] },
        })
      ).ok,
    ).toBe(false);
    await d.close();
  });

  it('runStop turns paypal_outbound off with a reason and audits it', async () => {
    const d = await openDatabase({ kind: 'pglite-memory' });
    const clock = fakeClock('2026-10-22T10:00:00Z');
    await migrate(d, clock);
    const audit = createAuditSink(seededIds('cli3'), clock);
    await d.query(`UPDATE safety_switches SET "on" = true WHERE name = 'paypal_outbound'`);
    const tty = { isTTY: true, env: {} };
    expect(
      (await runStop({ db: d, clock, audit, tty, by: { kind: 'system' }, reason: '' })).ok,
    ).toBe(false);
    expect(
      (await runStop({ db: d, clock, audit, tty, by: { kind: 'system' }, reason: 'drill' })).ok,
    ).toBe(true);
    const r = await d.query<{ on: boolean }>(
      `SELECT "on" FROM safety_switches WHERE name='paypal_outbound'`,
    );
    expect(r.rows[0]?.on).toBe(false);
    expect((await d.query('SELECT 1 FROM audit_log')).rows).toHaveLength(1);
    await d.close();
  });
});
