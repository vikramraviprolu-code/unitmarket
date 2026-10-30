// PUB-APPLY adversarial (docs/specs/pub-apply-public-application.md): the one public write under attack.
// An anonymous caller can leave an application and nothing else: no account, no sign in, no payee, no offer.
// Mass submission hits the per-address limit; oversize bodies, unknown fields, a missing or foreign origin and
// bad shapes are refused and store nothing; a filled honeypot looks like success and stores nothing; script text
// is stored inert and the operator page renders it as text; the operator routes still refuse anonymous callers;
// no answer carries an internal id and the raw address is never stored.
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createSession } from '@umsbx/security';
import { bootRefundWorld } from './refund-support';
import type { RefundWorld } from './refund-support';
import { ORIGIN, call } from './support';

vi.mock('server-only', () => ({}));

type Handler = (
  req: Request,
  ctx?: { params: Promise<Record<string, string>> },
) => Promise<Response>;

let w: RefundWorld;
const logs: string[] = [];
let apply: typeof import('./app/api/applications/route');
let addRoute: typeof import('./app/api/ops/publishers/applicants/route');
let decideRoute: typeof import('./app/api/ops/publishers/applicants/decision/route');
let sessionRoute: typeof import('./app/api/session/route');
beforeAll(async () => {
  w = await bootRefundWorld({ UMS_TRUSTED_PROXIES: '1' }, { log_sink: (l) => logs.push(l) });
  apply = await import('./app/api/applications/route');
  addRoute = await import('./app/api/ops/publishers/applicants/route');
  decideRoute = await import('./app/api/ops/publishers/applicants/decision/route');
  sessionRoute = await import('./app/api/session/route');
});
afterAll(async () => {
  await w.app.close();
});
beforeEach(async () => {
  await w.app.db.query('DELETE FROM rate_buckets');
});

let addr = 0;
const freshAddr = (): string => {
  addr += 1;
  return `198.51.100.${String(addr)}`;
};
let seq = 0;
const good = (o: Record<string, unknown> = {}) => {
  seq += 1;
  return {
    display_name: `Applicant Press ${String(seq)}`,
    country: 'GB',
    note: 'https://press.example, we publish local reports',
    website: '',
    ...o,
  };
};
const post = (
  body: unknown,
  o: { ip?: string; headers?: Record<string, string>; cookie?: string } = {},
): Promise<Response> =>
  apply.POST(
    new Request(`${ORIGIN}/api/applications`, {
      method: 'POST',
      headers: {
        origin: ORIGIN,
        'content-type': 'application/json',
        'x-forwarded-for': o.ip ?? freshAddr(),
        ...(o.cookie === undefined ? {} : { cookie: o.cookie }),
        ...(o.headers ?? {}),
      },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    }),
    { params: Promise.resolve({}) },
  );
const q = async <T>(sql: string, p: unknown[] = []): Promise<T[]> =>
  (await w.app.db.query<T>(sql, p)).rows;
const countOf = async (sql: string): Promise<number> => Number((await q<{ c: string }>(sql))[0]!.c);
const pubs = () => countOf('SELECT count(*) AS c FROM publishers');
const audits = () => countOf('SELECT count(*) AS c FROM audit_log');
const MONEY =
  'SELECT (SELECT count(*) FROM orders) + (SELECT count(*) FROM order_units) + (SELECT count(*) FROM ledger_entries) + (SELECT count(*) FROM approvals) + (SELECT count(*) FROM entitlements) + (SELECT count(*) FROM refund_requests) + (SELECT count(*) FROM offers) + (SELECT count(*) FROM payee_change_requests) AS c';
const REFERENCE = /^[a-z0-9]+(-[a-z0-9]+)*-[0-9a-f]{12}$/;

describe('an anonymous application', () => {
  it('stores one applied publisher and answers only a reference, with no cookie and no internal id', async () => {
    const before = [await pubs(), await audits(), await countOf(MONEY)];
    const res = await post(good({ display_name: 'Fresh Harbour Press' }));
    expect(res.status).toBe(200);
    expect(res.headers.get('set-cookie')).toBeNull();
    const text = await res.clone().text();
    expect(text).not.toMatch(/pub_|aud_|opr_|buy_|ofr_/);
    const body = (await res.json()) as { reference: string };
    expect(Object.keys(body)).toEqual(['reference']);
    expect(body.reference).toMatch(REFERENCE);
    expect(body.reference.startsWith('fresh-harbour-press-')).toBe(true);
    const row = (
      await q<Record<string, unknown>>(
        'SELECT status, paypal_merchant_id, payee_verified_at FROM publishers WHERE slug = $1',
        [body.reference],
      )
    )[0]!;
    expect(row).toMatchObject({
      status: 'applied',
      paypal_merchant_id: null,
      payee_verified_at: null,
    });
    expect([await pubs(), await audits(), await countOf(MONEY)]).toEqual([
      before[0]! + 1,
      before[1]! + 1,
      before[2],
    ]);
    expect(await w.app.engine.applicationStatus({ ref: body.reference })).toBe('pending');
  });

  it('creates no account: the reference is not a persona, no passcode opens it, no session row appears', async () => {
    const body = (await (await post(good())).json()) as { reference: string };
    const sessionsBefore = await countOf('SELECT count(*) AS c FROM sessions');
    for (const passcode of ['', 'x', 'sandbox passcode for tests']) {
      const res = await call(sessionRoute.POST as Handler, {
        url: '/api/session',
        method: 'POST',
        body: { persona: body.reference, passcode: passcode === '' ? 'x' : passcode },
        headers: { 'x-forwarded-for': freshAddr() },
      });
      expect(res.status).toBe(401);
      expect(res.headers.get('set-cookie')).toBeNull();
    }
    expect(await countOf('SELECT count(*) AS c FROM sessions')).toBe(sessionsBefore);
  });

  it('ignores any cookie it is sent: a buyer, a publisher or an operator session gains and changes nothing', async () => {
    const pubSession = await createSession(w.app.security, {
      kind: 'publisher',
      publisher_id: (await q<{ id: string }>("SELECT id FROM publishers WHERE slug = 'harbour-ledger'"))[0]!.id,
    });
    for (const cookie of [
      w.A.cookie,
      w.op.cookie,
      pubSession.cookie.split(';')[0]!,
      'ums_session=garbage',
    ]) {
      const res = await post(good(), { cookie });
      expect(res.status).toBe(200);
      expect(res.headers.get('set-cookie')).toBeNull();
      const ref = ((await res.json()) as { reference: string }).reference;
      const rows = await q<{ status: string; actor_kind: string }>(
        `SELECT p.status, a.actor_kind FROM publishers p JOIN audit_log a ON a.target = p.id
          WHERE p.slug = $1 AND a.action = 'publisher.application_submitted'`,
        [ref],
      );
      expect(rows).toEqual([{ status: 'applied', actor_kind: 'system' }]);
    }
  });

  it('never stores or logs the raw address', async () => {
    const ip = '203.0.113.77';
    const res = await post(good({ display_name: 'Address Check Press' }), { ip });
    expect(res.status).toBe(200);
    const dump = JSON.stringify([
      await q('SELECT * FROM rate_buckets'),
      await q('SELECT * FROM audit_log'),
      await q('SELECT * FROM publishers'),
      logs,
    ]);
    expect(dump).not.toContain(ip);
  });
});

describe('per address limits', () => {
  it('allows 5 applications an hour per address, then answers 429, while another address still works', async () => {
    const ip = freshAddr();
    const before = await pubs();
    for (let i = 0; i < 5; i += 1) expect((await post(good(), { ip })).status, String(i)).toBe(200);
    const sixth = await post(good(), { ip });
    expect(sixth.status).toBe(429);
    expect(sixth.headers.get('retry-after')).not.toBeNull();
    expect(await pubs()).toBe(before + 5);
    expect((await post(good(), { ip: freshAddr() })).status).toBe(200);
  });

  it('a honeypot request spends the same allowance, so a bot cannot probe for free', async () => {
    const ip = freshAddr();
    for (let i = 0; i < 5; i += 1)
      expect((await post(good({ website: 'http://spam.example' }), { ip })).status).toBe(200);
    expect((await post(good(), { ip })).status).toBe(429);
  });

  it('the route also limits every kind of request (refused ones too) at 20 an hour per address', async () => {
    const ip = freshAddr();
    const seen: number[] = [];
    for (let i = 0; i < 22; i += 1) seen.push((await post({ display_name: 'x' }, { ip })).status);
    expect(seen.slice(0, 20).every((s) => s === 422)).toBe(true);
    expect(seen.slice(20)).toEqual([429, 429]);
  });
});

describe('refused requests store nothing', () => {
  it('refuses an oversize body (413), declared or real', async () => {
    const before = [await pubs(), await audits()];
    const big = good({ note: 'n'.repeat(5000) });
    expect((await post(big)).status).toBe(413);
    const declared = await post(good(), { headers: { 'content-length': '999999' } });
    expect(declared.status).toBe(413);
    expect([await pubs(), await audits()]).toEqual(before);
  });

  it('refuses unknown fields and mass assignment (422), whatever the value', async () => {
    const before = [await pubs(), await audits()];
    for (const extra of [
      { status: 'active' },
      { slug: 'harbour-ledger' },
      { slug: 'my-own-slug' },
      { publisher_id: 'pub_x' },
      { paypal_merchant_id: 'ABCDEFGHIJKLM' },
      { persona: 'publisher-harbour' },
      { role: 'operator' },
      { ref_nonce: '000000000000' },
      { ip_hash: 'abc' },
    ]) {
      const res = await post({ ...good(), ...extra });
      expect(res.status, JSON.stringify(extra)).toBe(422);
    }
    expect([await pubs(), await audits()]).toEqual(before);
  });

  it('refuses bad shapes: names, country, note, wrong types, arrays, not json', async () => {
    const before = [await pubs(), await audits()];
    const bodies: unknown[] = [
      good({ display_name: '<script>alert(1)</script>' }),
      good({ display_name: 'A<b>bold</b>' }),
      good({ display_name: 'x' }),
      good({ display_name: 'n'.repeat(81) }),
      good({ display_name: 'bad\u0000name' }),
      good({ country: 'gb' }),
      good({ country: 'GBR' }),
      good({ note: 'no' }),
      good({ note: 'n'.repeat(201) }),
      good({ display_name: ['a', 'b'] }),
      good({ display_name: { toString: 'x' } }),
      good({ website: 7 }),
      [],
      null,
      'not json at all',
      '',
    ];
    for (const b of bodies) {
      const res = await post(b);
      expect([400, 422], JSON.stringify(b)).toContain(res.status);
      const text = await res.text();
      expect(text).not.toMatch(/pub_|aud_|stack|at \w+ \(/);
    }
    expect([await pubs(), await audits()]).toEqual(before);
  });

  it('needs a matching origin: a missing or foreign origin gets 403 csrf', async () => {
    const before = [await pubs(), await audits()];
    for (const origin of [undefined, 'https://evil.example', 'null', 'http://localhost:3001']) {
      const headers: Record<string, string> = {
        'content-type': 'application/json',
        'x-forwarded-for': freshAddr(),
      };
      if (origin !== undefined) headers['origin'] = origin;
      const res = await apply.POST(
        new Request(`${ORIGIN}/api/applications`, {
          method: 'POST',
          headers,
          body: JSON.stringify(good()),
        }),
        { params: Promise.resolve({}) },
      );
      expect(res.status, String(origin)).toBe(403);
      expect(((await res.json()) as { error: { code: string } }).error.code).toBe('csrf');
    }
    expect([await pubs(), await audits()]).toEqual(before);
  });

  it('a GET is not served by the route', async () => {
    const res = await apply.POST(
      new Request(`${ORIGIN}/api/applications`, { method: 'GET' }),
      { params: Promise.resolve({}) },
    );
    expect(res.status).toBe(404);
  });
});

describe('the honeypot', () => {
  it('answers the normal success with a reference and stores nothing at all', async () => {
    const before = [await pubs(), await audits(), await countOf(MONEY)];
    const res = await post(good({ website: 'http://spam.example' }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { reference: string };
    expect(Object.keys(body)).toEqual(['reference']);
    expect(body.reference).toMatch(REFERENCE);
    expect([await pubs(), await audits(), await countOf(MONEY)]).toEqual(before);
    expect(await w.app.engine.applicationStatus({ ref: body.reference })).toBe('unknown');
  });
});

describe('script text', () => {
  it('is stored inert in the note and never executed or reshaped; the page renders text only', async () => {
    const note = '<img src=x onerror=alert(1)> <script>alert(1)</script> reach me at https://p.example';
    const res = await post(good({ display_name: 'Inert Note Press', note }));
    expect(res.status).toBe(200);
    const ref = ((await res.json()) as { reference: string }).reference;
    const listed = await w.app.engine.opsApplicants.list({
      kind: 'operator',
      operator_id: 'opr_vikram',
      mfa: true,
    });
    if (!listed.ok) throw new Error('list refused');
    const mine = listed.value.applicants.find((a) => a.slug === ref)!;
    expect(mine.note).toBe(note);
    const strip = (x: string): string => x.replace(/\/\/.*$/gm, '');
    const read = (rel: string): string => readFileSync(new URL(rel, import.meta.url), 'utf8');
    for (const f of [
      './app/ops/publishers/page.tsx',
      './app/apply/page.tsx',
      './app/apply/status/page.tsx',
      './app/apply/ApplyForm.tsx',
    ]) {
      const src = strip(read(f));
      expect(src, f).not.toMatch(/dangerouslySetInnerHTML|innerHTML|style=|eval\(/);
    }
    expect(strip(read('./app/ops/publishers/page.tsx'))).toContain('{a.note}');
  });
});

describe('the operator routes still refuse an anonymous caller', () => {
  it('add, decide and the page data refuse anonymous, buyer and publisher callers and change nothing', async () => {
    const ref = ((await (await post(good())).json()) as { reference: string }).reference;
    const id = (await q<{ id: string }>('SELECT id FROM publishers WHERE slug = $1', [ref]))[0]!.id;
    const before = [await pubs(), await audits(), await countOf('SELECT count(*) AS c FROM publisher_applicant_decisions')];
    const pubSession = await createSession(w.app.security, { kind: 'publisher', publisher_id: id });
    const sessions = [
      null,
      w.A,
      { cookie: pubSession.cookie.split(';')[0]!, csrf: pubSession.csrf_token },
    ];
    for (const s of sessions) {
      const added = await call(addRoute.POST as Handler, {
        url: '/api/ops/publishers/applicants',
        method: 'POST',
        session: s,
        body: { slug: 'sneaky-add', display_name: 'Sneaky', country: 'GB', reason: 'Trying it' },
      });
      expect([401, 403]).toContain(added.status);
      const decided = await call(decideRoute.POST as Handler, {
        url: '/api/ops/publishers/applicants/decision',
        method: 'POST',
        session: s,
        body: { publisher_id: id, decision: 'approve', reason: 'Approve myself' },
      });
      expect([401, 403]).toContain(decided.status);
    }
    expect(
      (await w.app.engine.opsApplicants.list({ kind: 'system' })).ok,
    ).toBe(false);
    expect((await q<{ status: string }>('SELECT status FROM publishers WHERE id = $1', [id]))[0]!.status).toBe('applied');
    expect([
      await pubs(),
      await audits(),
      await countOf('SELECT count(*) AS c FROM publisher_applicant_decisions'),
    ]).toEqual(before);
  });
});

describe('the status read', () => {
  it('answers pending, approved, rejected and unknown only, and unknown for an operator added applicant', async () => {
    const ref = ((await (await post(good())).json()) as { reference: string }).reference;
    const id = (await q<{ id: string }>('SELECT id FROM publishers WHERE slug = $1', [ref]))[0]!.id;
    expect(await w.app.engine.applicationStatus({ ref })).toBe('pending');
    const done = await w.app.engine.opsApplicants.decide({
      actor: { kind: 'operator', operator_id: 'opr_vikram', mfa: true },
      publisher_id: id,
      decision: 'approve',
      reason: 'Checked the site',
    });
    expect(done.ok).toBe(true);
    expect(await w.app.engine.applicationStatus({ ref })).toBe('approved');
    expect(await w.app.engine.applicationStatus({ ref: 'harbour-ledger' })).toBe('unknown');
    expect(await w.app.engine.applicationStatus({ ref: "' OR 1=1 --" })).toBe('unknown');
    expect(await w.app.engine.applicationStatus({ ref: 'x'.repeat(5000) })).toBe('unknown');
  });
});

describe('the route file (source as text)', () => {
  const strip = (x: string): string => x.replace(/\/\/.*$/gm, '');
  const src = strip(
    readFileSync(new URL('./app/api/applications/route.ts', import.meta.url), 'utf8'),
  );
  it('is public with a CSRF origin check, a strict body, a size cap and a limiter, and reads no cookie', () => {
    expect(src).toMatch(/auth: 'public'/);
    expect(src).toMatch(/csrf: true/);
    expect(src).toMatch(/\.strict\(\)/);
    expect(src).toMatch(/max_body_bytes: 2048/);
    expect(src).toMatch(/per: 'ip'/);
    expect(src).not.toMatch(/cookie/i);
    expect(src).not.toMatch(/process\.env|Date\.now|Math\.random/);
  });
});
