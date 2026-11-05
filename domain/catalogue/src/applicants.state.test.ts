// PUB-E2 (docs/specs/pub-e2-applicants.md): add, approve and reject an applicant. PGlite with the base
// seed. An applicant is a publishers row with status applied, no payee and no offers. Approval makes it
// active; a rejection keeps the row applied and records a decision. Suspended stays suspended. Money and
// access tables are never touched. One audit row per change.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { addApplicant, decideApplicant, listApplicants } from './applicants';
import { listAuthorisedOffers } from './read';
import { setPublisherStatus } from './status';
import { offersWorld } from './write-support';
import type { OffersWorld } from './write-support';

let w: OffersWorld;
beforeAll(async () => {
  w = await offersWorld();
});
afterAll(async () => {
  await w.db.close();
});

const NEW = { slug: 'tidewater-review', display_name: 'Tidewater Review', country: 'GB' };
const add = (o: Partial<typeof NEW & { reason: string }> = {}) =>
  addApplicant(w.deps(), w.operator, { ...NEW, reason: 'Met at the fair', ...o });
const row = async (id: string) =>
  (
    await w.db.query<Record<string, unknown>>(
      'SELECT status, paypal_merchant_id, payee_verified_at, payee_shared, slug, country FROM publishers WHERE id = $1',
      [id],
    )
  ).rows[0];
const audits = async (like: string) =>
  (
    await w.db.query<{ actor_id: string; target: string; reason: string }>(
      'SELECT actor_id, target, reason FROM audit_log WHERE action LIKE $1 ORDER BY created_at, id',
      [like],
    )
  ).rows;
const n = async (table: string): Promise<number> =>
  Number((await w.db.query<{ c: string }>(`SELECT count(*) AS c FROM ${table}`)).rows[0]!.c);
const MONEY = ['orders', 'order_units', 'ledger_entries', 'approvals', 'entitlements', 'offers'];

describe('addApplicant', () => {
  it('creates an applied publisher with no payee and no offers, and one audit row', async () => {
    const before = await Promise.all(MONEY.map(n));
    const r = await add();
    if (!r.ok) throw new Error(r.error.code);
    const id = r.value.publisher_id;
    expect(id.startsWith('pub_')).toBe(true);
    expect(await row(id)).toMatchObject({
      status: 'applied',
      paypal_merchant_id: null,
      payee_verified_at: null,
      payee_shared: false,
      slug: 'tidewater-review',
      country: 'GB',
    });
    expect(
      Number(
        (
          await w.db.query<{ c: string }>(
            'SELECT count(*) AS c FROM offers WHERE publisher_id = $1',
            [id],
          )
        ).rows[0]!.c,
      ),
    ).toBe(0);
    expect(await audits('publisher.applicant_added')).toEqual([
      { actor_id: 'opr_vikram', target: id, reason: 'Met at the fair' },
    ]);
    expect(await Promise.all(MONEY.map(n))).toEqual(before);
  });

  it('refuses a duplicate slug, also one that differs only by case, and adds nothing', async () => {
    const pubs = await n('publishers');
    for (const slug of ['tidewater-review', 'harbour-ledger']) {
      const r = await add({ slug });
      expect(r).toEqual({ ok: false, error: { code: 'slug_taken' } });
    }
    expect(await add({ slug: 'Harbour-Ledger' })).toEqual({
      ok: false,
      error: { code: 'invalid_slug' },
    });
    expect(await n('publishers')).toBe(pubs);
  });

  it('validates slug, name, country and reason', async () => {
    for (const slug of [
      'ab',
      'a'.repeat(41),
      'has space',
      '-lead',
      'trail-',
      'dou--ble',
      'under_score',
      'ünï',
    ]) {
      expect(await add({ slug }), slug).toEqual({ ok: false, error: { code: 'invalid_slug' } });
    }
    for (const bad of [
      { display_name: 'x' },
      { display_name: 'y'.repeat(81) },
      { display_name: '   ' },
      { display_name: 'Bad\nname' },
      { country: 'gb' },
      { country: 'GBR' },
      { country: '' },
      { reason: 'no' },
      { reason: 'r'.repeat(201) },
      { reason: '   ' },
    ]) {
      expect(await add({ slug: 'valid-slug', ...bad }), JSON.stringify(bad)).toEqual({
        ok: false,
        error: { code: 'invalid_input' },
      });
    }
    expect(await row('x')).toBeUndefined();
  });

  it('refuses a publisher, a buyer, a system actor and an operator without the second factor', async () => {
    const call = (a: Parameters<typeof addApplicant>[1]) =>
      addApplicant(w.deps(), a, { ...NEW, slug: 'never-added', reason: 'Attempt here' });
    expect(await call(w.harbour)).toEqual({ ok: false, error: { code: 'not_operator' } });
    expect(await call(w.buyer)).toEqual({ ok: false, error: { code: 'not_operator' } });
    expect(await call(w.system)).toEqual({ ok: false, error: { code: 'not_operator' } });
    expect(await call({ kind: 'operator', operator_id: 'opr_x', mfa: false })).toEqual({
      ok: false,
      error: { code: 'mfa_required' },
    });
    expect(
      (await w.db.query('SELECT 1 FROM publishers WHERE slug = $1', ['never-added'])).rows,
    ).toHaveLength(0);
  });

  it('an applicant is not on sale and is not listed among authorised offers', async () => {
    const listed = await listAuthorisedOffers(w.db, { corridor_id: 'us-usd', limit: 500 });
    expect(listed.some((v) => v.offer.id.includes('tidewater'))).toBe(false);
  });
});

describe('listApplicants', () => {
  it('lists applied rows as pending, and only for an operator with the second factor', async () => {
    const l = await listApplicants(w.db, w.operator);
    expect(l).not.toBeNull();
    expect(l!.map((a) => [a.slug, a.state])).toEqual([['tidewater-review', 'pending']]);
    expect(await listApplicants(w.db, w.harbour)).toBeNull();
    expect(await listApplicants(w.db, w.buyer)).toBeNull();
    expect(
      await listApplicants(w.db, { kind: 'operator', operator_id: 'opr_x', mfa: false }),
    ).toBeNull();
  });
});

describe('decideApplicant', () => {
  const id = async (slug: string): Promise<string> =>
    (await w.db.query<{ id: string }>('SELECT id FROM publishers WHERE slug = $1', [slug])).rows[0]!
      .id;
  const decide = (
    publisher_id: string,
    decision: 'approve' | 'reject',
    reason = 'Checked in person',
  ) => decideApplicant(w.deps(), w.operator, { publisher_id, decision, reason });

  it('approve makes the applicant active, records the decision, one audit row, money untouched', async () => {
    const pid = await id('tidewater-review');
    const before = await Promise.all(MONEY.map(n));
    // POB-P1: approval also returns the one time invite (checked in publisher-invites.state.test.ts)
    expect(await decide(pid, 'approve')).toMatchObject({ ok: true, value: { state: 'active' } });
    expect((await row(pid))!.status).toBe('active');
    const d = await w.db.query<Record<string, unknown>>(
      'SELECT decision, operator_id, reason FROM publisher_applicant_decisions WHERE publisher_id = $1',
      [pid],
    );
    expect(d.rows).toEqual([
      { decision: 'approved', operator_id: 'opr_vikram', reason: 'Checked in person' },
    ]);
    expect(await audits('publisher.applicant_approved')).toEqual([
      { actor_id: 'opr_vikram', target: pid, reason: 'Checked in person' },
    ]);
    expect(await Promise.all(MONEY.map(n))).toEqual(before);
    expect((await listApplicants(w.db, w.operator))!).toEqual([]);
  });

  it('a second decision on the same applicant is refused: already decided or not allowed', async () => {
    const pid = await id('tidewater-review');
    expect(await decide(pid, 'reject')).toEqual({ ok: false, error: { code: 'not_allowed' } });
    expect((await row(pid))!.status).toBe('active');
  });

  it('reject keeps the row applied, records the decision and lists it as rejected', async () => {
    const r = await add({ slug: 'second-applicant', display_name: 'Second Applicant' });
    if (!r.ok) throw new Error(r.error.code);
    expect(await decide(r.value.publisher_id, 'reject', 'Not a fit now')).toEqual({
      ok: true,
      value: { state: 'rejected' },
    });
    expect((await row(r.value.publisher_id))!.status).toBe('applied');
    const l = await listApplicants(w.db, w.operator);
    expect(l!.map((a) => [a.slug, a.state, a.decision_reason])).toEqual([
      ['second-applicant', 'rejected', 'Not a fit now'],
    ]);
    expect(await audits('publisher.applicant_rejected')).toHaveLength(1);
    // decided once: neither answer works again
    expect(await decide(r.value.publisher_id, 'approve')).toEqual({
      ok: false,
      error: { code: 'already_decided' },
    });
    expect(await decide(r.value.publisher_id, 'reject')).toEqual({
      ok: false,
      error: { code: 'already_decided' },
    });
    expect((await row(r.value.publisher_id))!.status).toBe('applied');
  });

  it('active and suspended publishers cannot be decided; suspended stays suspended', async () => {
    expect(await decide(w.pubId['harbour-ledger'], 'approve')).toEqual({
      ok: false,
      error: { code: 'not_allowed' },
    });
    expect(await decide(w.pubId['harbour-ledger'], 'reject')).toEqual({
      ok: false,
      error: { code: 'not_allowed' },
    });
    const s = await setPublisherStatus(w.deps(), w.operator, {
      publisher_id: w.pubId['quayside-gazette'],
      status: 'suspended',
      reason: 'Under review',
    });
    expect(s.ok).toBe(true);
    expect(await decide(w.pubId['quayside-gazette'], 'approve')).toEqual({
      ok: false,
      error: { code: 'not_allowed' },
    });
    expect(await decide(w.pubId['quayside-gazette'], 'reject')).toEqual({
      ok: false,
      error: { code: 'not_allowed' },
    });
    expect((await row(w.pubId['quayside-gazette']))!.status).toBe('suspended');
  });

  it('an unknown id is not_found; bad input and bad actors change nothing', async () => {
    expect(await decide('pub_guessed', 'approve')).toEqual({
      ok: false,
      error: { code: 'not_found' },
    });
    const r = await add({ slug: 'third-applicant', display_name: 'Third Applicant' });
    if (!r.ok) throw new Error(r.error.code);
    const pid = r.value.publisher_id;
    for (const bad of [
      { reason: 'no' },
      { reason: 'r'.repeat(201) },
      { reason: '  ' },
      { decision: 'activate' as never },
      { publisher_id: '' },
    ]) {
      const res = await decideApplicant(w.deps(), w.operator, {
        publisher_id: pid,
        decision: 'approve',
        reason: 'Fine reason',
        ...bad,
      });
      expect(res, JSON.stringify(bad)).toEqual({ ok: false, error: { code: 'invalid_input' } });
    }
    for (const a of [w.harbour, w.buyer, w.system]) {
      expect(
        await decideApplicant(w.deps(), a, {
          publisher_id: pid,
          decision: 'approve',
          reason: 'Nope nope',
        }),
      ).toEqual({ ok: false, error: { code: 'not_operator' } });
    }
    expect(
      await decideApplicant(
        w.deps(),
        { kind: 'operator', operator_id: 'opr_x', mfa: false },
        { publisher_id: pid, decision: 'approve', reason: 'Nope nope' },
      ),
    ).toEqual({ ok: false, error: { code: 'mfa_required' } });
    expect((await row(pid))!.status).toBe('applied');
    expect(await n('publisher_applicant_decisions')).toBe(2);
  });

  it('the decision table is append-only', async () => {
    await expect(
      w.db.query("UPDATE publisher_applicant_decisions SET reason = 'edited'"),
    ).rejects.toThrow();
    await expect(w.db.query('DELETE FROM publisher_applicant_decisions')).rejects.toThrow();
  });
});
