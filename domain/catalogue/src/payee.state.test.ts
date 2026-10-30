// PUB-A2 state tests: the payee request and the operator decision, on a migrated in-memory database.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { decidePayeeRequest, listOpenRequests, payeeView, requestPayeeChange } from './index';
import { MERCH_NEW, MERCH_OLD, count, payeeWorld, publisherRow } from './payee-support';
import type { PayeeWorld } from './payee-support';

let w: PayeeWorld;
beforeAll(async () => {
  w = await payeeWorld();
});
afterAll(async () => {
  await w.db.close();
});

const ask = async (merchant_id = MERCH_NEW, note = 'We moved banks.') => {
  const r = await requestPayeeChange(w.deps('dryrun'), w.actorA, { merchant_id, note });
  if (!r.ok) throw new Error(`request refused: ${r.error.code}`);
  return r.value.request_id;
};

describe('requestPayeeChange', () => {
  it('stores the request and changes nothing else', async () => {
    const before = await publisherRow(w.db, w.pubA);
    const id = await ask();
    const row = (
      await w.db.query<{ publisher_id: string; requested_merchant_id: string; note: string }>(
        'SELECT publisher_id, requested_merchant_id, note FROM payee_change_requests WHERE id = $1',
        [id],
      )
    ).rows[0]!;
    expect(row).toEqual({
      publisher_id: w.pubA,
      requested_merchant_id: MERCH_NEW,
      note: 'We moved banks.',
    });
    expect(await publisherRow(w.db, w.pubA)).toEqual(before);
    expect(await count(w.db, 'SELECT count(*) AS c FROM payee_decisions')).toBe(0);
  });

  it('refuses a merchant id that is not 13 capital letters and digits', async () => {
    for (const bad of ['short', 'lowercase0000', 'TOOLONGMERCHANT1', 'HAS SPACE 0000', '']) {
      const r = await requestPayeeChange(w.deps('dryrun'), w.actorA, {
        merchant_id: bad,
        note: 'x',
      });
      expect(r).toEqual({ ok: false, error: { code: 'invalid_merchant_id' } });
    }
  });

  it('refuses the id the publisher already has', async () => {
    const r = await requestPayeeChange(w.deps('dryrun'), w.actorA, {
      merchant_id: MERCH_OLD,
      note: 'same',
    });
    expect(r).toEqual({ ok: false, error: { code: 'same_as_current' } });
  });

  it('writes one audit row with the last 4 of the new and the current id only', async () => {
    const id = await ask('REQUESTAUDIT1');
    const row = (
      await w.db.query<{ detail: Record<string, unknown>; actor_kind: string }>(
        "SELECT detail, actor_kind FROM audit_log WHERE action = 'payee.change_requested' AND target = $1",
        [id],
      )
    ).rows[0]!;
    expect(row.actor_kind).toBe('publisher');
    expect(row.detail).toEqual({ requested_last4: 'DIT1', current_last4: 'NT01' });
  });
});

describe('payeeView', () => {
  it('shows last 4, the verification time and the history newest first', async () => {
    const v = (await payeeView(w.db, w.actorA))!;
    expect(v.last4).toBe('NT01');
    expect(v.verified_at).not.toBeNull();
    expect(v.history.length).toBeGreaterThanOrEqual(2);
    expect(v.history.every((h) => h.state === 'open')).toBe(true);
    const times = v.history.map((h) => h.created_at);
    expect([...times].sort().reverse()).toEqual(times);
    expect(JSON.stringify(v)).not.toContain(MERCH_OLD);
    expect(JSON.stringify(v)).not.toContain(MERCH_NEW);
  });

  it('is null for any actor that is not a publisher', async () => {
    expect(await payeeView(w.db, w.buyer)).toBeNull();
    expect(await payeeView(w.db, w.opMfa)).toBeNull();
    expect(await payeeView(w.db, { kind: 'system' })).toBeNull();
  });
});

describe('decidePayeeRequest in dry-run mode', () => {
  it('verify sets the payee, the decision, payee_shared false and one audit row', async () => {
    const id = await ask('VERIFYME00001');
    await w.db.query('UPDATE publishers SET payee_shared = false WHERE id = $1', [w.pubA]);
    w.clock.advance(60_000);
    const r = await decidePayeeRequest(w.deps('dryrun'), w.opMfa, {
      request_id: id,
      merchant_id_retyped: 'VERIFYME00001',
      decision: 'verified',
      reason: 'Checked with the publisher.',
    });
    expect(r).toEqual({ ok: true, value: { decision: 'verified' } });
    const pub = await publisherRow(w.db, w.pubA);
    expect(pub.paypal_merchant_id).toBe('VERIFYME00001');
    expect(pub.payee_shared).toBe(false);
    expect(new Date(pub.payee_verified_at as string).toISOString()).toBe(
      w.clock.now().toISOString(),
    );
    const d = (
      await w.db.query<{ decision: string; operator_id: string; reason: string }>(
        'SELECT decision, operator_id, reason FROM payee_decisions WHERE request_id = $1',
        [id],
      )
    ).rows;
    expect(d).toEqual([
      { decision: 'verified', operator_id: 'opr_vikram', reason: 'Checked with the publisher.' },
    ]);
    const a = (
      await w.db.query<{ detail: Record<string, unknown>; target: string }>(
        "SELECT detail, target FROM audit_log WHERE action = 'payee.verified'",
      )
    ).rows;
    expect(a).toHaveLength(1);
    expect(a[0]!.target).toBe(id);
    expect(a[0]!.detail).toMatchObject({ old_last4: 'NT01', new_last4: '0001' });
    expect(JSON.stringify(a[0]!.detail)).not.toContain('VERIFYME');
    expect(JSON.stringify(a[0]!.detail)).not.toContain(MERCH_OLD);
    const v = (await payeeView(w.db, w.actorA))!;
    expect(v.last4).toBe('0001');
    expect(v.history.find((h) => h.request_id === id)?.state).toBe('verified');
  });

  it('reject writes the decision and changes nothing else', async () => {
    const id = await ask('REJECTME00002');
    const before = await publisherRow(w.db, w.pubA);
    const r = await decidePayeeRequest(w.deps('dryrun'), w.opMfa, {
      request_id: id,
      merchant_id_retyped: '',
      decision: 'rejected',
      reason: 'Could not confirm it.',
    });
    expect(r).toEqual({ ok: true, value: { decision: 'rejected' } });
    expect(await publisherRow(w.db, w.pubA)).toEqual(before);
    expect(
      await count(
        w.db,
        "SELECT count(*) AS c FROM payee_decisions WHERE request_id = $1 AND decision = 'rejected'",
        [id],
      ),
    ).toBe(1);
    const v = (await payeeView(w.db, w.actorA))!;
    expect(v.history.find((h) => h.request_id === id)?.state).toBe('rejected');
  });

  it('refuses a retyped id that differs by one character and writes no decision', async () => {
    const id = await ask('MISMATCH00003');
    const before = await publisherRow(w.db, w.pubA);
    for (const typed of ['MISMATCH00004', 'mismatch00003', 'MISMATCH00003 ', '']) {
      const r = await decidePayeeRequest(w.deps('dryrun'), w.opMfa, {
        request_id: id,
        merchant_id_retyped: typed,
        decision: 'verified',
        reason: 'Checked.',
      });
      expect(r).toEqual({ ok: false, error: { code: 'id_mismatch' } });
    }
    expect(await publisherRow(w.db, w.pubA)).toEqual(before);
    expect(
      await count(w.db, 'SELECT count(*) AS c FROM payee_decisions WHERE request_id = $1', [id]),
    ).toBe(0);
  });

  it('refuses a second decision on one request (the unique key)', async () => {
    const id = await ask('TWICE00000004');
    const first = await decidePayeeRequest(w.deps('dryrun'), w.opMfa, {
      request_id: id,
      merchant_id_retyped: '',
      decision: 'rejected',
      reason: 'No.',
    });
    expect(first.ok).toBe(true);
    const second = await decidePayeeRequest(w.deps('dryrun'), w.opMfa, {
      request_id: id,
      merchant_id_retyped: 'TWICE00000004',
      decision: 'verified',
      reason: 'Changed my mind.',
    });
    expect(second).toEqual({ ok: false, error: { code: 'already_decided' } });
    expect(
      await count(w.db, 'SELECT count(*) AS c FROM payee_decisions WHERE request_id = $1', [id]),
    ).toBe(1);
    // The table itself also refuses a second row, whatever the code does.
    await expect(
      w.db.query(
        `INSERT INTO payee_decisions (id, request_id, decision, operator_id, reason, created_at, updated_at)
         VALUES ('pdc_raw_second', $1, 'verified', 'opr_x', 'raw', now(), now())`,
        [id],
      ),
    ).rejects.toThrow();
  });

  it('an unknown request id answers not_found', async () => {
    const r = await decidePayeeRequest(w.deps('dryrun'), w.opMfa, {
      request_id: 'prp_doesnotexist',
      merchant_id_retyped: MERCH_NEW,
      decision: 'verified',
      reason: 'Checked.',
    });
    expect(r).toEqual({ ok: false, error: { code: 'not_found' } });
  });
});

describe('listOpenRequests', () => {
  it('lists only requests without a decision, with the last 4 and never the full id', async () => {
    const id = await ask('LISTED0000005');
    const r = await listOpenRequests(w.db, w.opMfa);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const row = r.value.find((x) => x.request_id === id)!;
    expect(row.requested_last4).toBe('0005');
    expect(row.publisher_id).toBe(w.pubA);
    const decided = (
      await w.db.query<{ request_id: string }>('SELECT request_id FROM payee_decisions')
    ).rows.map((x) => x.request_id);
    for (const open of r.value) expect(decided).not.toContain(open.request_id);
    expect(JSON.stringify(r.value)).not.toContain('LISTED0000005');
  });
});

describe('decidePayeeRequest in sandbox mode (D-062, assumption 3)', () => {
  it('refuses verify with owner_command_required and changes nothing', async () => {
    const id = await ask('SANDBOX000006');
    const before = await publisherRow(w.db, w.pubA);
    const decisions = await count(w.db, 'SELECT count(*) AS c FROM payee_decisions');
    const r = await decidePayeeRequest(w.deps('sandbox'), w.opMfa, {
      request_id: id,
      merchant_id_retyped: 'SANDBOX000006',
      decision: 'verified',
      reason: 'Checked.',
    });
    expect(r).toEqual({ ok: false, error: { code: 'owner_command_required' } });
    expect(await publisherRow(w.db, w.pubA)).toEqual(before);
    expect(await count(w.db, 'SELECT count(*) AS c FROM payee_decisions')).toBe(decisions);
    const a = await count(
      w.db,
      "SELECT count(*) AS c FROM audit_log WHERE action = 'payee.verify_refused' AND target = $1",
      [id],
    );
    expect(a).toBe(1);
  });

  it('still lets an operator reject in sandbox mode', async () => {
    const id = await ask('SANDBOX000007');
    const r = await decidePayeeRequest(w.deps('sandbox'), w.opMfa, {
      request_id: id,
      merchant_id_retyped: '',
      decision: 'rejected',
      reason: 'Not now.',
    });
    expect(r).toEqual({ ok: true, value: { decision: 'rejected' } });
  });
});
