// PUB-E2 adversarial (docs/specs/pub-e2-applicants.md): the two applicant routes under attack. A publisher,
// a buyer and an anonymous caller cannot add or decide; an operator without the second factor gets
// mfa_required; CSRF, mass assignment, guessed ids, duplicate slugs and the status rules hold; a refused
// call changes nothing, a successful one leaves one audit row, and money tables never move.
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { errorOf } from './refund-support';
import { bootPayeeWorld } from './payee-support';
import type { PayeeWebWorld } from './payee-support';
import { call } from './support';
import type { Session } from './support';

vi.mock('server-only', () => ({}));

type Handler = (
  req: Request,
  ctx?: { params: Promise<Record<string, string>> },
) => Promise<Response>;

let w: PayeeWebWorld;
let addRoute: typeof import('./app/api/ops/publishers/applicants/route');
let decideRoute: typeof import('./app/api/ops/publishers/applicants/decision/route');
beforeAll(async () => {
  w = await bootPayeeWorld();
  addRoute = await import('./app/api/ops/publishers/applicants/route');
  decideRoute = await import('./app/api/ops/publishers/applicants/decision/route');
});
afterAll(async () => {
  await w.app.close();
});
beforeEach(async () => {
  await w.app.db.query('DELETE FROM rate_buckets');
});

const send = (
  h: unknown,
  url: string,
  session: Session | null,
  body: unknown,
  o: { csrf?: boolean } = {},
): Promise<Response> =>
  call(h as Handler, {
    url,
    method: 'POST',
    body,
    session,
    ...(o.csrf === undefined ? {} : { csrf: o.csrf }),
  });
const add = (session: Session | null, body: unknown, o: { csrf?: boolean } = {}) =>
  send(addRoute.POST, '/api/ops/publishers/applicants', session, body, o);
const decide = (session: Session | null, body: unknown, o: { csrf?: boolean } = {}) =>
  send(decideRoute.POST, '/api/ops/publishers/applicants/decision', session, body, o);

let seq = 0;
const goodAdd = () => {
  seq += 1;
  return {
    slug: `applicant-${String(seq)}`,
    display_name: `Applicant ${String(seq)}`,
    country: 'GB',
    reason: 'Operator added after a call',
  };
};
const q = async <T>(sql: string, p: unknown[] = []): Promise<T[]> =>
  (await w.app.db.query<T>(sql, p)).rows;
const countOf = async (sql: string): Promise<number> => Number((await q<{ c: string }>(sql))[0]!.c);
const pubs = () => countOf('SELECT count(*) AS c FROM publishers');
const audits = () =>
  countOf("SELECT count(*) AS c FROM audit_log WHERE action LIKE 'publisher.applicant_%'");
const decisions = () => countOf('SELECT count(*) AS c FROM publisher_applicant_decisions');
const statusOf = async (id: string): Promise<string> =>
  (await q<{ status: string }>('SELECT status FROM publishers WHERE id = $1', [id]))[0]!.status;
const MONEY =
  'SELECT (SELECT count(*) FROM orders) + (SELECT count(*) FROM order_units) + (SELECT count(*) FROM ledger_entries) + (SELECT count(*) FROM approvals) + (SELECT count(*) FROM entitlements) + (SELECT count(*) FROM refund_requests) AS c';
const newApplicant = async (): Promise<string> => {
  const res = await add(w.refund.op, goodAdd());
  expect(res.status).toBe(200);
  const body = (await res.json()) as { publisher_id: string };
  return body.publisher_id;
};

describe('who may add or decide', () => {
  it('an operator without the second factor gets 403 mfa_required and nothing changes', async () => {
    const before = [await pubs(), await audits()];
    const res = await add(w.refund.demo, goodAdd());
    expect(res.status).toBe(403);
    expect((await errorOf(res)).code).toBe('mfa_required');
    const id = await newApplicant();
    const res2 = await decide(w.refund.demo, {
      publisher_id: id,
      decision: 'approve',
      reason: 'Looks fine',
    });
    expect(res2.status).toBe(403);
    expect((await errorOf(res2)).code).toBe('mfa_required');
    expect(await statusOf(id)).toBe('applied');
    expect([await pubs(), await audits()]).toEqual([before[0]! + 1, before[1]! + 1]);
  });

  it('a publisher session, a buyer session and no session cannot add or decide, not even themselves', async () => {
    const id = await newApplicant();
    const before = [await pubs(), await audits(), await decisions()];
    for (const s of [w.pub['harbour-ledger'], w.pub['northfield-quarterly'], w.refund.A]) {
      expect((await add(s, goodAdd())).status).toBe(403);
      expect(
        (await decide(s, { publisher_id: id, decision: 'approve', reason: 'Self serve' })).status,
      ).toBe(403);
      expect(
        (
          await decide(s, {
            publisher_id: w.pubId['harbour-ledger'],
            decision: 'reject',
            reason: 'Self serve',
          })
        ).status,
      ).toBe(403);
    }
    expect((await add(null, goodAdd())).status).toBe(401);
    expect(
      (await decide(null, { publisher_id: id, decision: 'approve', reason: 'Self serve' })).status,
    ).toBe(401);
    expect(await statusOf(id)).toBe('applied');
    expect([await pubs(), await audits(), await decisions()]).toEqual(before);
  });

  it('the page data refuses a publisher, a buyer and a system actor; an operator without MFA may read (OPS-A.7)', async () => {
    for (const actor of [
      { kind: 'publisher', publisher_id: w.pubId['harbour-ledger'] },
      w.refund.actorA,
      { kind: 'system' },
    ] as const) {
      expect((await w.app.engine.opsApplicants.list(actor)).ok).toBe(false);
    }
    expect(
      (
        await w.app.engine.opsApplicants.list({
          kind: 'operator',
          operator_id: 'opr_x',
          mfa: false,
        })
      ).ok,
    ).toBe(true);
  });
});

describe('the shape of the call', () => {
  it('a missing CSRF token is 403 csrf on both routes', async () => {
    const id = await newApplicant();
    const before = await pubs();
    const a = await add(w.refund.op, goodAdd(), { csrf: false });
    expect(a.status).toBe(403);
    expect((await errorOf(a)).code).toBe('csrf');
    const d = await decide(
      w.refund.op,
      { publisher_id: id, decision: 'approve', reason: 'Fine fine' },
      { csrf: false },
    );
    expect(d.status).toBe(403);
    expect((await errorOf(d)).code).toBe('csrf');
    expect(await pubs()).toBe(before);
    expect(await statusOf(id)).toBe('applied');
  });

  it('mass assignment: any extra field is refused by the strict shape and nothing is stored', async () => {
    const id = await newApplicant();
    const before = [await pubs(), await audits()];
    for (const extra of [
      { status: 'active' },
      { paypal_merchant_id: 'AAAAAAAAAAAAA' },
      { payee_verified_at: '2026-10-30T00:00:00.000Z' },
      { payee_shared: true },
      { id: 'pub_chosen' },
      { persona: 'publisher-harbour-ledger' },
    ]) {
      const a = await add(w.refund.op, { ...goodAdd(), ...extra });
      expect(a.status, JSON.stringify(extra)).toBe(422);
      expect((await errorOf(a)).code).toBe('invalid_input');
      const d = await decide(w.refund.op, {
        publisher_id: id,
        decision: 'approve',
        reason: 'Fine fine',
        ...extra,
      });
      expect(d.status, JSON.stringify(extra)).toBe(422);
    }
    expect([await pubs(), await audits()]).toEqual(before);
    expect(await statusOf(id)).toBe('applied');
  });

  it('bad slug, name, country and reason are 422 and store nothing', async () => {
    const before = await pubs();
    for (const bad of [
      { slug: 'Upper' },
      { slug: 'a b' },
      { slug: 'ab' },
      { slug: 'a'.repeat(41) },
      { slug: '../etc' },
      { slug: '' },
      { display_name: 'x' },
      { display_name: 'y'.repeat(81) },
      { country: 'gb' },
      { country: 'USA' },
      { reason: 'no' },
      { reason: 'z'.repeat(201) },
      { reason: '   ' },
      { slug: 5 },
    ]) {
      const res = await add(w.refund.op, { ...goodAdd(), ...bad });
      expect(res.status, JSON.stringify(bad)).toBe(422);
    }
    expect(await pubs()).toBe(before);
  });

  it('only approve and reject are accepted and the reason is 3 to 200 characters', async () => {
    const id = await newApplicant();
    for (const bad of [
      { decision: 'active' },
      { decision: 'suspended' },
      { decision: '' },
      { reason: 'x' },
      { reason: 'y'.repeat(201) },
      { reason: '   ' },
      { publisher_id: '' },
      { publisher_id: 5 },
    ]) {
      const res = await decide(w.refund.op, {
        publisher_id: id,
        decision: 'approve',
        reason: 'Fine fine',
        ...bad,
      });
      expect(res.status, JSON.stringify(bad)).toBe(422);
    }
    expect(await statusOf(id)).toBe('applied');
    expect(await decisions()).toBeGreaterThanOrEqual(0);
  });

  it('an oversized body is 413', async () => {
    expect((await add(w.refund.op, { ...goodAdd(), reason: 'z'.repeat(3000) })).status).toBe(413);
    expect(
      (
        await decide(w.refund.op, {
          publisher_id: 'p',
          decision: 'approve',
          reason: 'z'.repeat(3000),
        })
      ).status,
    ).toBe(413);
  });
});

describe('the rules', () => {
  it('a duplicate slug is 409 slug_taken and a seeded slug cannot be reused', async () => {
    const body = goodAdd();
    expect((await add(w.refund.op, body)).status).toBe(200);
    const before = await pubs();
    const dup = await add(w.refund.op, { ...body, display_name: 'Someone Else' });
    expect(dup.status).toBe(409);
    expect((await errorOf(dup)).code).toBe('slug_taken');
    const seeded = await add(w.refund.op, { ...goodAdd(), slug: 'harbour-ledger' });
    expect(seeded.status).toBe(409);
    expect(await pubs()).toBe(before);
  });

  it('a guessed id is 404 not_found and creates nothing', async () => {
    const before = [await decisions(), await audits()];
    for (const publisher_id of ['pub_guess', 'pub_00000000000000000000000000', "x' OR 1=1 --"]) {
      const res = await decide(w.refund.op, {
        publisher_id,
        decision: 'approve',
        reason: 'Guessing',
      });
      expect(res.status).toBe(404);
      expect((await errorOf(res)).code).toBe('not_found');
    }
    expect([await decisions(), await audits()]).toEqual(before);
  });

  it('applied becomes active on approve, with no login, no payee and no offers', async () => {
    const id = await newApplicant();
    const moneyBefore = await countOf(MONEY);
    const res = await decide(w.refund.op, {
      publisher_id: id,
      decision: 'approve',
      reason: 'Checked their site',
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ state: 'active' });
    expect(await statusOf(id)).toBe('active');
    const row = (
      await q<Record<string, unknown>>(
        'SELECT paypal_merchant_id, payee_verified_at FROM publishers WHERE id = $1',
        [id],
      )
    )[0];
    expect(row).toEqual({ paypal_merchant_id: null, payee_verified_at: null });
    expect(await countOf(`SELECT count(*) AS c FROM offers WHERE publisher_id = '${id}'`)).toBe(0);
    expect(await countOf(MONEY)).toBe(moneyBefore);
    // an approved applicant is still not a persona: the list is the fixed composition list
    expect(w.app.engine.personas().some((x) => x.includes('applicant'))).toBe(false);
    // and the decision cannot be repeated
    const again = await decide(w.refund.op, {
      publisher_id: id,
      decision: 'reject',
      reason: 'Changed my mind',
    });
    expect(again.status).toBe(409);
    expect(await statusOf(id)).toBe('active');
  });

  it('reject keeps the row applied, is final, and a second answer is 409', async () => {
    const id = await newApplicant();
    const res = await decide(w.refund.op, {
      publisher_id: id,
      decision: 'reject',
      reason: 'Not a fit right now',
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ state: 'rejected' });
    expect(await statusOf(id)).toBe('applied');
    for (const decision of ['approve', 'reject']) {
      const again = await decide(w.refund.op, { publisher_id: id, decision, reason: 'Second try' });
      expect(again.status).toBe(409);
      expect((await errorOf(again)).code).toBe('already_decided');
    }
    expect(await statusOf(id)).toBe('applied');
  });

  it('active and suspended publishers are not_allowed; suspended stays suspended', async () => {
    const sres = await call(
      (await import('./app/api/ops/publishers/status/route')).POST as Handler,
      {
        url: '/api/ops/publishers/status',
        method: 'POST',
        session: w.refund.op,
        body: {
          publisher_id: w.pubId['quayside-gazette'],
          status: 'suspended',
          reason: 'Under review',
        },
      },
    );
    expect(sres.status).toBe(200);
    for (const [pid, expected] of [
      [w.pubId['quayside-gazette'], 'suspended'],
      [w.pubId['harbour-ledger'], 'active'],
    ] as const) {
      for (const decision of ['approve', 'reject']) {
        const res = await decide(w.refund.op, { publisher_id: pid, decision, reason: 'Try it' });
        expect(res.status).toBe(409);
        expect((await errorOf(res)).code).toBe('not_allowed');
      }
      expect(await statusOf(pid)).toBe(expected);
    }
  });

  it('the status route still refuses to activate an applicant', async () => {
    const id = await newApplicant();
    const res = await call(
      (await import('./app/api/ops/publishers/status/route')).POST as Handler,
      {
        url: '/api/ops/publishers/status',
        method: 'POST',
        session: w.refund.op,
        body: { publisher_id: id, status: 'active', reason: 'Skip approval' },
      },
    );
    expect(res.status).toBe(409);
    expect(await statusOf(id)).toBe('applied');
  });
});

describe('what a successful call leaves', () => {
  it('one audit row naming the operator and the reason per change, and no new money rows', async () => {
    const m = await countOf(MONEY);
    const a0 = await audits();
    const id = await newApplicant();
    expect(await audits()).toBe(a0 + 1);
    await decide(w.refund.op, { publisher_id: id, decision: 'approve', reason: 'Audit me please' });
    expect(await audits()).toBe(a0 + 2);
    const row = (
      await q<Record<string, unknown>>(
        "SELECT actor_kind, actor_id, action, target, reason FROM audit_log WHERE action = 'publisher.applicant_approved' AND target = $1",
        [id],
      )
    )[0];
    expect(row).toMatchObject({
      actor_kind: 'operator',
      actor_id: 'opr_vikram',
      target: id,
      reason: 'Audit me please',
    });
    expect(await countOf(MONEY)).toBe(m);
  });

  it('is rate limited to 20 changes an hour per operator on each route', async () => {
    let limited = 0;
    for (let i = 0; i < 22; i += 1) {
      const res = await add(w.refund.op2, goodAdd());
      if (res.status === 429) limited += 1;
    }
    expect(limited).toBeGreaterThanOrEqual(2);
  });
});

describe('the route files', () => {
  it('declare operator routes with CSRF, a per actor rate and a strict body', () => {
    expect(addRoute.routeMeta).toMatchObject({
      path: '/api/ops/publishers/applicants',
      method: 'POST',
      auth: 'operator',
      csrf: true,
    });
    expect(decideRoute.routeMeta).toMatchObject({
      path: '/api/ops/publishers/applicants/decision',
      method: 'POST',
      auth: 'operator',
      csrf: true,
    });
    for (const r of [addRoute.routeMeta, decideRoute.routeMeta])
      expect(r.rate).toMatchObject({ per: 'actor', limit: 20, window_ms: 3_600_000 });
    for (const rel of [
      './app/api/ops/publishers/applicants/route.ts',
      './app/api/ops/publishers/applicants/decision/route.ts',
    ]) {
      const src = readFileSync(new URL(rel, import.meta.url), 'utf8');
      expect(src).toContain('.strict()');
      expect(src).not.toContain('fail_safe_without_mfa');
    }
  });
});

describe('the page (source as text)', () => {
  const strip = (x: string): string => x.replace(/\/\/.*$/gm, '');
  const read = (rel: string): string => readFileSync(new URL(rel, import.meta.url), 'utf8');
  it('reads applicants only through the engine, uses its own copy module and has no inline style', () => {
    const page = strip(read('./app/ops/publishers/page.tsx'));
    expect(page).toMatch(/readOpsPublishers\(actor\)/); // INT-OPS-A: through composition/ops-sellers
    expect(page).toContain("from '../../../lib/ops-applicants-copy'");
    expect(page).toContain('ApplicantForms');
    expect(page).not.toMatch(/style=/);
    expect(page.replace(/maskedMerchant/g, '')).not.toMatch(/merchant/i);
  });
  it('the forms post to the two routes and carry only the shaped fields', () => {
    const form = strip(read('./app/ops/publishers/ApplicantForms.tsx'));
    expect(form).toContain("'/api/ops/publishers/applicants'");
    expect(form).toContain("'/api/ops/publishers/applicants/decision'");
    for (const f of ['slug', 'display_name', 'country', 'reason', 'publisher_id', 'decision'])
      expect(form).toContain(f);
    expect(form).not.toMatch(/style=/);
    expect(form).not.toMatch(/status:/);
  });
});
