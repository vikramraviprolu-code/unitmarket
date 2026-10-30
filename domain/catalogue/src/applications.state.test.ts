// PUB-APPLY (docs/specs/pub-apply-public-application.md): the public application. PGlite with the base seed.
// submitApplication needs no actor and creates an applicant record only: a publishers row with status
// applied, no payee, no offers, no money or access rows. The server derives the slug, the name is checked,
// a global cap of 200 pending applicants answers busy, a filled honeypot stores nothing, a name that equals an
// existing publisher is stored with a DUPLICATE NAME note, and there is one audit row per submission.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  APPLICATION_CAP,
  DUPLICATE_NOTE_PREFIX,
  SLUG_PATTERN,
  applicationStatus,
  decideApplicant,
  listApplicants,
  submitApplication,
} from './applicants';
import { listAuthorisedOffers } from './read';
import { offersWorld } from './write-support';
import type { OffersWorld } from './write-support';

let w: OffersWorld;
beforeAll(async () => {
  w = await offersWorld();
});
afterAll(async () => {
  await w.db.close();
});

let seq = 0;
const nonce = (): string => {
  seq += 1;
  return seq.toString(16).padStart(12, '0');
};
const GOOD = {
  display_name: 'Tidewater Review',
  country: 'GB',
  note: 'https://tidewater.example, we publish local sea reports',
};
const submit = (o: Record<string, unknown> = {}) =>
  submitApplication(w.deps(), { ...GOOD, ref_nonce: nonce(), ...o } as Parameters<
    typeof submitApplication
  >[1]);
const q = async <T>(sql: string, p: unknown[] = []): Promise<T[]> =>
  (await w.db.query<T>(sql, p)).rows;
const n = async (table: string): Promise<number> =>
  Number((await w.db.query<{ c: string }>(`SELECT count(*) AS c FROM ${table}`)).rows[0]!.c);
const MONEY = [
  'orders',
  'order_units',
  'ledger_entries',
  'approvals',
  'entitlements',
  'offers',
  'refund_requests',
];
const slugOf = (r: Awaited<ReturnType<typeof submit>>): string => {
  if (!r.ok) throw new Error(r.error.code);
  return r.value.reference;
};

describe('submitApplication', () => {
  it('creates an applied publisher with no payee, no offers, no money rows, and one audit row', async () => {
    const before = await Promise.all(MONEY.map(n));
    const pubs = await n('publishers');
    const r = await submit({ ref_nonce: 'a1b2c3d4e5f6' });
    const slug = slugOf(r);
    expect(slug).toBe('tidewater-review-a1b2c3d4e5f6');
    expect(await n('publishers')).toBe(pubs + 1);
    const p = (
      await q<Record<string, unknown>>(
        'SELECT id, status, paypal_merchant_id, payee_verified_at, payee_shared, display_name, country FROM publishers WHERE slug = $1',
        [slug],
      )
    )[0]!;
    expect(p).toMatchObject({
      status: 'applied',
      paypal_merchant_id: null,
      payee_verified_at: null,
      payee_shared: false,
      display_name: 'Tidewater Review',
      country: 'GB',
    });
    expect(await n('offers')).toBe(before[MONEY.indexOf('offers')]);
    expect(await Promise.all(MONEY.map(n))).toEqual(before);
    const audits = await q<{
      actor_kind: string;
      actor_id: string | null;
      reason: string;
      target: string;
      detail: unknown;
    }>(
      "SELECT actor_kind, actor_id, reason, target, detail FROM audit_log WHERE action = 'publisher.application_submitted'",
    );
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      actor_kind: 'system',
      actor_id: null,
      target: p['id'],
      reason: GOOD.note,
    });
    expect(JSON.stringify(audits[0]!.detail)).toContain('anonymous');
    // The decision table and the operator's own add action are untouched.
    expect(await n('publisher_applicant_decisions')).toBe(0);
    expect(
      await q("SELECT 1 FROM audit_log WHERE action = 'publisher.applicant_added'"),
    ).toHaveLength(0);
  });

  it('needs no actor and the result carries only the reference, never an internal id', async () => {
    const r = await submit();
    expect(r.ok).toBe(true);
    if (r.ok) expect(Object.keys(r.value)).toEqual(['reference']);
    expect(JSON.stringify(r)).not.toMatch(/pub_/);
  });

  it('derives a slug from the name: ascii, lowercase, single hyphens, 3 to 40 chars, never colliding', async () => {
    const cases: Array<[string, RegExp]> = [
      ['Tidewater  &  Co.', /^tidewater-co-[0-9a-f]{12}$/],
      ['  --Odd__Name!!  ', /^odd-name-[0-9a-f]{12}$/],
      ['Café Noir', /^cafe-noir-[0-9a-f]{12}$/],
      ['株式会社', /^applicant-[0-9a-f]{12}$/],
      ['A'.repeat(80), /^a{27}-[0-9a-f]{12}$/],
      ['Alpha Beta Gamma Delta Epsilon Zeta', /^alpha-beta-gamma-delta-epsi-[0-9a-f]{12}$/],
    ];
    for (const [name, re] of cases) {
      const slug = slugOf(await submit({ display_name: name }));
      expect(slug, name).toMatch(re);
      expect(slug).toMatch(SLUG_PATTERN);
      expect(slug.length).toBeGreaterThanOrEqual(3);
      expect(slug.length).toBeLessThanOrEqual(40);
    }
    // The same name twice gives two applicants with two slugs.
    const a = slugOf(await submit({ display_name: 'Same Name Press' }));
    const b = slugOf(await submit({ display_name: 'Same Name Press' }));
    expect(a).not.toBe(b);
  });

  it('refuses a nonce that is not 12 lowercase hex characters, and a reused one', async () => {
    for (const bad of ['', 'abc', 'G'.repeat(12), 'A1B2C3D4E5F6', 'a'.repeat(13)]) {
      expect(await submit({ ref_nonce: bad }), bad).toEqual({
        ok: false,
        error: { code: 'invalid_input' },
      });
    }
    const pubs = await n('publishers');
    const fixed = '00000000beef';
    expect((await submit({ ref_nonce: fixed })).ok).toBe(true);
    expect(await submit({ ref_nonce: fixed })).toEqual({ ok: false, error: { code: 'busy' } });
    expect(await n('publishers')).toBe(pubs + 1);
  });

  it('validates name, country and note, and stores nothing when refused', async () => {
    const pubs = await n('publishers');
    const audits = await n('audit_log');
    for (const bad of [
      { display_name: 'x' },
      { display_name: 'y'.repeat(81) },
      { display_name: '   ' },
      { display_name: 'Bad\nname' },
      { display_name: 'Bad\u0000name' },
      { display_name: 'Bad‮name' },
      { display_name: '<script>alert(1)</script>' },
      { display_name: 'Fine > name' },
      { display_name: 'Fine < name' },
      { country: 'gb' },
      { country: 'GBR' },
      { country: 'G1' },
      { country: '' },
      { note: 'no' },
      { note: 'n'.repeat(201) },
      { note: '   ' },
      { note: 'line\nbreak' },
      { note: 'nul\u0000byte' },
      { display_name: 42 },
      { note: null },
      { country: undefined },
    ]) {
      expect(await submit(bad), JSON.stringify(bad)).toEqual({
        ok: false,
        error: { code: 'invalid_input' },
      });
    }
    expect(await n('publishers')).toBe(pubs);
    expect(await n('audit_log')).toBe(audits);
  });

  it('stores script text in the note inert: the exact text, no change of status or any other row', async () => {
    const text = '<script>alert(1)</script> reach me at https://x.example';
    const slug = slugOf(await submit({ display_name: 'Inert Text Gazette', note: text }));
    const list = (await listApplicants(w.db, w.operator))!;
    const mine = list.find((a) => a.slug === slug)!;
    expect(mine.note).toBe(text);
    expect(mine.state).toBe('pending');
  });

  it('prefixes the stored note with DUPLICATE NAME when the name equals a publisher, in any case', async () => {
    for (const name of [
      'Harbour Ledger Review (fictional)',
      'HARBOUR LEDGER REVIEW (FICTIONAL)',
      ' harbour ledger review (fictional) ',
    ]) {
      const slug = slugOf(await submit({ display_name: name }));
      const mine = (await listApplicants(w.db, w.operator))!.find((a) => a.slug === slug)!;
      expect(mine.note, name).toBe(`${DUPLICATE_NOTE_PREFIX}${GOOD.note}`);
      expect(DUPLICATE_NOTE_PREFIX).toBe('DUPLICATE NAME: ');
    }
    // A name that equals an earlier applicant also counts.
    const slug = slugOf(await submit({ display_name: 'tidewater review' }));
    const mine = (await listApplicants(w.db, w.operator))!.find((a) => a.slug === slug)!;
    expect(mine.note?.startsWith(DUPLICATE_NOTE_PREFIX)).toBe(true);
    // A new name has no prefix.
    const fresh = slugOf(await submit({ display_name: 'Brand New Quarterly' }));
    expect((await listApplicants(w.db, w.operator))!.find((a) => a.slug === fresh)!.note).toBe(
      GOOD.note,
    );
  });

  it('a submitted applicant is not on sale and appears in the operator list as pending from the public form', async () => {
    const slug = slugOf(await submit({ display_name: 'Listed Press' }));
    const listed = await listAuthorisedOffers(w.db, { corridor_id: 'us-usd', limit: 500 });
    expect(listed.some((v) => v.offer.id.includes('listed-press'))).toBe(false);
    const mine = (await listApplicants(w.db, w.operator))!.find((a) => a.slug === slug)!;
    expect(mine).toMatchObject({ state: 'pending', source: 'public', country: 'GB' });
  });

  it('operator decisions work on a public application unchanged', async () => {
    const slug = slugOf(await submit({ display_name: 'Decide Me Weekly' }));
    const id = (await q<{ id: string }>('SELECT id FROM publishers WHERE slug = $1', [slug]))[0]!
      .id;
    expect(
      await decideApplicant(w.deps(), w.operator, {
        publisher_id: id,
        decision: 'approve',
        reason: 'Checked their site',
      }),
    ).toEqual({ ok: true, value: { state: 'active' } });
    expect(await applicationStatus(w.db, slug)).toBe('approved');
  });
});

describe('applicationStatus', () => {
  it('answers pending, approved, rejected and unknown, from the reference alone', async () => {
    const a = slugOf(await submit({ display_name: 'Status Pending' }));
    expect(await applicationStatus(w.db, a)).toBe('pending');
    const b = slugOf(await submit({ display_name: 'Status Rejected' }));
    const bid = (await q<{ id: string }>('SELECT id FROM publishers WHERE slug = $1', [b]))[0]!.id;
    await decideApplicant(w.deps(), w.operator, {
      publisher_id: bid,
      decision: 'reject',
      reason: 'Not a fit now',
    });
    expect(await applicationStatus(w.db, b)).toBe('rejected');
  });

  it('answers unknown for a missing reference, a seeded publisher, an operator added applicant, and bad shapes', async () => {
    expect(await applicationStatus(w.db, 'no-such-applicant-000000000000')).toBe('unknown');
    expect(await applicationStatus(w.db, 'harbour-ledger')).toBe('unknown');
    const pid = (await operatorAdds('operator-made-applicant')).publisher_id;
    expect(pid.startsWith('pub_')).toBe(true);
    expect(await applicationStatus(w.db, 'operator-made-applicant')).toBe('unknown');
    for (const bad of [
      '',
      ' ',
      "x' OR '1'='1",
      'UPPER-CASE',
      'a'.repeat(41),
      'a/b',
      '%',
      'pub_x',
    ]) {
      expect(await applicationStatus(w.db, bad), bad).toBe('unknown');
    }
  });
});

// The operator's own add path, to prove its records are not answered as applications.
async function operatorAdds(slug: string): Promise<{ publisher_id: string }> {
  const { addApplicant } = await import('./applicants');
  const r = await addApplicant(w.deps(), w.operator, {
    slug,
    display_name: 'Operator Made',
    country: 'GB',
    reason: 'Added by hand',
  });
  if (!r.ok) throw new Error(r.error.code);
  return r.value;
}

describe('the global cap', () => {
  it('answers busy when the pending applicants reach the cap, and stores nothing', async () => {
    expect(APPLICATION_CAP).toBe(200);
    const pending = async (): Promise<number> =>
      (await listApplicants(w.db, w.operator))!.filter((a) => a.state === 'pending').length;
    const have = await pending();
    const stamp = '2026-10-30T00:00:00.000Z';
    for (let i = 0; i < APPLICATION_CAP - have; i += 1) {
      await w.db.query(
        `INSERT INTO publishers (id, slug, display_name, country, status, created_at, updated_at)
         VALUES ($1, $2, $3, 'GB', 'applied', $4, $4)`,
        [
          `pub_fill${String(i).padStart(4, '0')}`,
          `fill-${String(i)}-abc`,
          `Filler ${String(i)}`,
          stamp,
        ],
      );
    }
    expect(await pending()).toBe(APPLICATION_CAP);
    const pubs = await n('publishers');
    const audits = await n('audit_log');
    expect(await submit({ display_name: 'One Too Many' })).toEqual({
      ok: false,
      error: { code: 'busy' },
    });
    expect(await n('publishers')).toBe(pubs);
    expect(await n('audit_log')).toBe(audits);
    // A rejected applicant no longer counts as pending, so one more fits.
    await w.db.query(
      `INSERT INTO publisher_applicant_decisions (id, publisher_id, decision, operator_id, reason, created_at, updated_at)
       VALUES ('aud_fill', 'pub_fill0000', 'rejected', 'opr_vikram', 'Not a fit now', $1, $1)`,
      [stamp],
    );
    expect((await submit({ display_name: 'Fits Now' })).ok).toBe(true);
    expect(await submit({ display_name: 'Full Again' })).toEqual({
      ok: false,
      error: { code: 'busy' },
    });
  });
});
