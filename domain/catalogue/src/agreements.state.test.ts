// AGREE-1 (docs/specs/agree-1-agreement-record.md): the seeded, read-only acceptance record. PGlite with
// the base seed and the supplement. The seed is the only writer; a publisher reads only its own record;
// an applicant has none.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { addApplicant } from './applicants';
import { listAgreements, ownAgreement, seedAgreements } from './agreements';
import { offersWorld } from './write-support';
import type { OffersWorld } from './write-support';

let w: OffersWorld;
beforeAll(async () => {
  w = await offersWorld();
});
afterAll(async () => {
  await w.db.close();
});

const SLUGS = ['harbour-ledger', 'quayside-gazette', 'northfield-quarterly'];
const input = (v = 'v1') => ({
  terms_version: v,
  accepted_by_label: 'Demo publisher contact',
  publisher_slugs: SLUGS,
});
const seed = (v = 'v1') => seedAgreements(w.db, w.clock, w.deps().ids, input(v));
const n = async (): Promise<number> =>
  Number(
    (await w.db.query<{ c: string }>('SELECT count(*) AS c FROM publisher_agreements')).rows[0]!.c,
  );

describe('seedAgreements', () => {
  it('gives each demo publisher one record at the given version, and a second run adds nothing', async () => {
    expect(await seed()).toBe(3);
    expect(await n()).toBe(3);
    expect(await seed()).toBe(0);
    expect(await n()).toBe(3);
    const mine = await ownAgreement(w.db, w.harbour);
    expect(mine).toEqual({
      publisher_id: w.pubId['harbour-ledger'],
      terms_version: 'v1',
      accepted_at: '2026-10-21T10:00:00.000Z',
      accepted_by_label: 'Demo publisher contact',
      method: 'seeded_demo',
    });
  });

  it('does not seed over an existing record when the version is bumped, so the change shows', async () => {
    expect(await seed('v2')).toBe(0);
    expect(await n()).toBe(3);
    expect((await ownAgreement(w.db, w.quayside))?.terms_version).toBe('v1');
  });

  it('gives an applicant no record, even if its slug is listed, and an unknown slug nothing', async () => {
    const a = await addApplicant(w.deps(), w.operator, {
      slug: 'tidewater-review',
      display_name: 'Tidewater Review',
      country: 'GB',
      reason: 'Met at the fair',
    });
    if (!a.ok) throw new Error(a.error.code);
    await seedAgreements(w.db, w.clock, w.deps().ids, {
      ...input(),
      publisher_slugs: [...SLUGS, 'tidewater-review', 'nobody-here'],
    });
    expect(await n()).toBe(3);
    expect(await ownAgreement(w.db, { kind: 'publisher', publisher_id: a.value.publisher_id })).toBe(
      null,
    );
  });
});

describe('reads', () => {
  it('a publisher sees only its own record; other actors see none', async () => {
    const h = await ownAgreement(w.db, w.harbour);
    const q = await ownAgreement(w.db, w.quayside);
    expect(h?.publisher_id).toBe(w.pubId['harbour-ledger']);
    expect(q?.publisher_id).toBe(w.pubId['quayside-gazette']);
    expect(await ownAgreement(w.db, w.buyer)).toBe(null);
    expect(await ownAgreement(w.db, w.operator)).toBe(null);
    expect(await ownAgreement(w.db, w.system)).toBe(null);
  });

  it('the operator list needs the second factor and gives the latest record per publisher', async () => {
    expect(await listAgreements(w.db, w.harbour)).toBe(null);
    expect(await listAgreements(w.db, { kind: 'operator', operator_id: 'opr_v', mfa: false })).toBe(
      null,
    );
    const all = await listAgreements(w.db, w.operator);
    expect(all?.map((x) => x.publisher_id).sort()).toEqual(Object.values(w.pubId).sort());
  });

  it('the record cannot be changed or removed through the database', async () => {
    await expect(w.db.query("UPDATE publisher_agreements SET terms_version = 'v9'")).rejects.toThrow();
    await expect(w.db.query('DELETE FROM publisher_agreements')).rejects.toThrow();
  });
});
