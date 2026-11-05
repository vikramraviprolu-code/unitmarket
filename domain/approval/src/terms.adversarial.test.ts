// BR-3: a stored snapshot cannot escape or alter its terms. A version 2 snapshot without terms, terms outside
// their safe range, edited values or an edited digest are all snapshot_tampered at verify.
import { afterEach, describe, expect, it } from 'vitest';
import { ApprovalSnapshotSchema } from '@umsbx/contracts';
import type { Result } from '@umsbx/contracts';
import { contentHash, requestApproval, verifyApproval } from './index';
import { BUYER_A, CONSENT, addQuote, makeHarness, type Harness } from './test-fixtures';

let h: Harness;
afterEach(async () => {
  await h.db.close();
});
function value<T, E>(r: Result<T, E>): T {
  if (!r.ok) throw new Error(`expected ok, got ${JSON.stringify(r.error)}`);
  return r.value;
}
const TAMPERED = { ok: false, error: { code: 'snapshot_tampered', http: 403 } };

async function granted() {
  h = await makeHarness();
  await addQuote(h.db, { id: 'quo_1', offer_id: 'ofr_1' });
  return value(
    await requestApproval(h.deps, {
      actor: BUYER_A,
      selection: { kind: 'quote', quote_id: 'quo_1' },
      consent: CONSENT,
    }),
  );
}
const verify = (g: { approval_id: string; token: string }) =>
  verifyApproval(h.db, h.deps, { approval_id: g.approval_id, token: g.token, actor: BUYER_A });

async function editRow(sql: string, params: unknown[]) {
  // Test-only: the immutability trigger is bypassed to simulate an attacker with DB write access.
  await h.db.exec('ALTER TABLE approvals DISABLE TRIGGER approvals_guard');
  await h.db.query(sql, params);
  await h.db.exec('ALTER TABLE approvals ENABLE TRIGGER approvals_guard');
}
type Loose = Record<string, unknown> & {
  terms?: { values: Record<string, unknown>; digest: string };
};

describe('terms tampering (BR-3)', () => {
  it('a version 2 snapshot without terms is refused at parse', async () => {
    const g = await granted();
    const bare = structuredClone(g.snapshot) as unknown as Loose;
    delete bare.terms;
    expect(ApprovalSnapshotSchema.safeParse(bare).success).toBe(false);
  });

  it('a version 2 snapshot without terms is refused at verify, even with a matching hash (no deadline escape)', async () => {
    const g = await granted();
    const bare = structuredClone(g.snapshot) as unknown as Loose;
    delete bare.terms;
    // The attacker recomputes the hash: the schema still refuses, so it is snapshot_tampered, not "no deadline".
    await editRow('UPDATE approvals SET snapshot = $1::jsonb, content_hash = $2 WHERE id = $3', [
      JSON.stringify(bare),
      contentHash(bare as never),
      g.approval_id,
    ]);
    expect(await verify(g)).toEqual(TAMPERED);
  });

  it('a snapshot downgraded to version 1 to drop its terms is refused', async () => {
    const g = await granted();
    const old = structuredClone(g.snapshot) as unknown as Loose;
    delete old.terms;
    old['snapshot_version'] = '1';
    await editRow('UPDATE approvals SET snapshot = $1::jsonb WHERE id = $2', [
      JSON.stringify(old),
      g.approval_id,
    ]);
    // A version 1 body parses, but its hash no longer matches the stored version 2 hash.
    expect(await verify(g)).toEqual(TAMPERED);
  });

  it('terms values outside their safe range are refused at parse', async () => {
    const g = await granted();
    for (const bad of [
      { 'refund.request_window': 31 },
      { 'refund.request_window': -1 },
      { 'access.window': 0 },
      { 'mandate.max_days': 91 },
      { 'refund.request_window': 7.5 },
    ]) {
      const s = structuredClone(g.snapshot) as unknown as Loose;
      Object.assign(s.terms!.values, bad);
      expect(ApprovalSnapshotSchema.safeParse(s).success).toBe(false);
    }
  });

  it('edited terms.values (hash unchanged) fail verify with snapshot_tampered', async () => {
    const g = await granted();
    const s = structuredClone(g.snapshot) as unknown as Loose;
    s.terms!.values['refund.request_window'] = 1;
    await editRow('UPDATE approvals SET snapshot = $1::jsonb WHERE id = $2', [
      JSON.stringify(s),
      g.approval_id,
    ]);
    expect(await verify(g)).toEqual(TAMPERED);
  });

  it('an edited terms.digest (hash unchanged) fails verify with snapshot_tampered', async () => {
    const g = await granted();
    const s = structuredClone(g.snapshot) as unknown as Loose;
    s.terms!.digest = 'd'.repeat(64);
    await editRow('UPDATE approvals SET snapshot = $1::jsonb WHERE id = $2', [
      JSON.stringify(s),
      g.approval_id,
    ]);
    expect(await verify(g)).toEqual(TAMPERED);
  });

  it('values changed and the hash recomputed: the digest no longer matches the values, so verify refuses', async () => {
    const g = await granted();
    const s = structuredClone(g.snapshot) as unknown as Loose;
    s.terms!.values['refund.request_window'] = 1; // digest left as it was
    await editRow('UPDATE approvals SET snapshot = $1::jsonb, content_hash = $2 WHERE id = $3', [
      JSON.stringify(s),
      contentHash(s as never),
      g.approval_id,
    ]);
    expect(await verify(g)).toEqual(TAMPERED);
  });

  it('an untouched snapshot still verifies', async () => {
    const g = await granted();
    expect((await verify(g)).ok).toBe(true);
  });
});
