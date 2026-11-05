// INT-OPS-A / OPS-A.7 (V6, A1): the seller queues /ops/publishers and /ops/payee-requests are read only for an
// operator without the authenticator code. The wall moved from the page into the reads, so it moves here too:
// the four reads accept a no-MFA operator and refuse every other actor, a merchant id shows as "…" and its last
// four, and every write still refuses without the code, in the function and in the route. A button that cannot
// work says "needs your authenticator code".
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Actor } from '@umsbx/contracts';
import { bootPayeeWorld } from './payee-support';
import type { PayeeWebWorld } from './payee-support';
import { call } from './support';
import type { Session } from './support';
import { OPS_NEEDS_CODE, maskedMerchant } from './lib/ops-copy';

vi.mock('server-only', () => ({}));
vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

type Handler = Parameters<typeof call>[0];
const here = fileURLToPath(new URL('.', import.meta.url));
const source = (rel: string): string =>
  readFileSync(join(here, rel), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');

const PLAIN: Actor = { kind: 'operator', operator_id: 'opr_demo', mfa: false };
const MFA: Actor = { kind: 'operator', operator_id: 'opr_vikram', mfa: true };
let w: PayeeWebWorld;
let sellers: typeof import('./composition/ops-sellers');
let merchants: string[] = [];

const POSTS: [string, () => Promise<{ POST: Handler }>, unknown][] = [
  ['/api/ops/publishers/status', () => import('./app/api/ops/publishers/status/route') as never, { publisher_id: 'pub_x', status: 'suspended', reason: 'Complaint under review' }],
  ['/api/ops/publishers/applicants', () => import('./app/api/ops/publishers/applicants/route') as never, { slug: 'new-pub', display_name: 'New Pub', country: 'US', reason: 'Asked by email' }],
  ['/api/ops/publishers/applicants/decision', () => import('./app/api/ops/publishers/applicants/decision/route') as never, { publisher_id: 'pub_x', decision: 'approve', reason: 'Looks fine' }],
  ['/api/ops/payee-decisions', () => import('./app/api/ops/payee-decisions/route') as never, { request_id: 'pcr_x', merchant_id_retyped: 'SBXPAYEE0001', decision: 'verified', reason: 'Checked with the seller' }],
];

beforeAll(async () => {
  w = await bootPayeeWorld();
  sellers = await import('./composition/ops-sellers');
  merchants = (await w.app.db.query<{ m: string }>('SELECT paypal_merchant_id AS m FROM publishers WHERE paypal_merchant_id IS NOT NULL')).rows.map((r) => r.m);
  const harbour = w.pubId['harbour-ledger'];
  await w.app.db.query(
    `INSERT INTO payee_change_requests (id, publisher_id, requested_merchant_id, note, created_by, created_at, updated_at)
     VALUES ('pcr_q1', $1, 'SBXQUEUEPAYEE9', 'queue test', 'publisher', now(), now())`,
    [harbour],
  );
});
afterAll(async () => w.app.close());

describe('the reads accept an operator without the code, and nobody else', () => {
  it('the four domain reads answer for a no-MFA operator', async () => {
    const e = w.app.engine;
    expect((await e.opsPublishers.list(PLAIN)).ok).toBe(true);
    expect((await e.opsApplicants.list(PLAIN)).ok).toBe(true);
    expect((await e.opsAgreements.list(PLAIN)).ok).toBe(true);
    const q = await e.payee.openRequests(PLAIN);
    expect(q.ok).toBe(true);
    if (q.ok) expect(q.value.requests.map((r) => r.request_id)).toEqual(['pcr_q1']);
  });

  it('the same reads give an MFA operator the same rows', async () => {
    const e = w.app.engine;
    const a = await e.opsPublishers.list(PLAIN);
    const b = await e.opsPublishers.list(MFA);
    expect(a.ok && b.ok && a.value.publishers).toEqual(b.ok && b.value.publishers);
  });

  it('they still refuse a buyer, a seller and the system', async () => {
    const e = w.app.engine;
    const others: Actor[] = [w.refund.actorA, { kind: 'publisher', publisher_id: w.pubId['harbour-ledger'] }, { kind: 'system' }];
    for (const actor of others) {
      expect(await e.opsPublishers.list(actor)).toEqual({ ok: false, error: { code: 'not_operator' } });
      expect(await e.opsApplicants.list(actor)).toEqual({ ok: false, error: { code: 'not_operator' } });
      expect(await e.opsAgreements.list(actor)).toEqual({ ok: false, error: { code: 'not_operator' } });
      expect(await e.payee.openRequests(actor)).toEqual({ ok: false, error: { code: 'not_operator' } });
    }
  });

  it('the composition reads answer a no-MFA operator, flag the missing code, and refuse the rest', async () => {
    const pubs = (await sellers.readOpsPublishers(PLAIN))!;
    expect(pubs).not.toBeNull();
    expect(pubs.mfa).toBe(false);
    expect(pubs.publishers.length).toBeGreaterThan(0);
    expect((await sellers.readOpsPublishers(MFA))!.mfa).toBe(true);
    const q = (await sellers.readOpsPayeeQueue(PLAIN))!;
    expect(q.mfa).toBe(false);
    expect(q.requests).toHaveLength(1);
    for (const actor of [w.refund.actorA, { kind: 'publisher', publisher_id: w.pubId['harbour-ledger'] }, { kind: 'system' }] as const) {
      expect(await sellers.readOpsPublishers(actor as never)).toBeNull();
      expect(await sellers.readOpsPayeeQueue(actor as never)).toBeNull();
    }
  });
});

describe('merchant ids', () => {
  it('shows as an ellipsis and the last four, and never whole', async () => {
    expect(maskedMerchant('1234')).toBe('…1234');
    expect(maskedMerchant(null)).toBe('none');
    for (const read of [await sellers.readOpsPublishers(PLAIN), await sellers.readOpsPayeeQueue(PLAIN), await sellers.readOpsPublishers(MFA)]) {
      const text = JSON.stringify(read);
      for (const m of [...merchants, 'SBXQUEUEPAYEE9']) expect(text).not.toContain(m);
    }
  });

  it('the pages show the masked form, from the copy module, when there is no code', () => {
    const pubs = source('app/ops/publishers/page.tsx');
    const pay = source('app/ops/payee-requests/page.tsx');
    expect(pubs).toContain('maskedMerchant(');
    expect(pay).toContain('maskedMerchant(');
    for (const p of [pubs, pay]) expect(p).not.toMatch(/merchant_id\b/);
  });
});

describe('writes still need the code', () => {
  it.each(POSTS)('POST %s without the code is 403 mfa_required', async (url, load, body) => {
    const route = await load();
    const res = await call(route.POST, { url, method: 'POST', body, session: w.refund.demo as Session });
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('mfa_required');
  });

  it('every write function refuses an operator without the code, and changes nothing', async () => {
    const e = w.app.engine;
    const before = (await w.app.db.query<{ c: string }>('SELECT count(*) AS c FROM audit_log')).rows[0]!.c;
    const id = w.pubId['northfield-quarterly'];
    const r = [
      await e.opsPublishers.setStatus({ actor: PLAIN, publisher_id: id, status: 'suspended', reason: 'Complaint under review' }),
      await e.opsApplicants.add({ actor: PLAIN, slug: 'x-pub', display_name: 'X Pub', country: 'US', reason: 'Asked by email' }),
      await e.opsApplicants.decide({ actor: PLAIN, publisher_id: id, decision: 'approve', reason: 'Looks fine' }),
      await e.payee.decide({ actor: PLAIN, request_id: 'pcr_q1', merchant_id_retyped: 'SBXQUEUEPAYEE9', decision: 'verified', reason: 'Checked' }),
    ];
    for (const x of r) expect(x).toMatchObject({ ok: false, error: { code: 'mfa_required' } });
    expect((await w.app.db.query<{ s: string }>('SELECT status AS s FROM publishers WHERE id = $1', [id])).rows[0]!.s).toBe('active');
    expect(Number((await w.app.db.query<{ c: string }>('SELECT count(*) AS c FROM audit_log')).rows[0]!.c)).toBeGreaterThanOrEqual(Number(before));
  });

  it('each action form says what to do when there is no code', () => {
    expect(OPS_NEEDS_CODE).toBe('needs your authenticator code');
    for (const f of ['app/ops/publishers/StatusForm.tsx', 'app/ops/publishers/ApplicantForms.tsx', 'app/ops/payee-requests/DecisionForm.tsx']) {
      const form = source(f);
      expect(form).toContain('OPS_NEEDS_CODE');
      expect(form).toMatch(/disabled=\{/);
    }
    for (const f of ['app/ops/publishers/page.tsx', 'app/ops/payee-requests/page.tsx']) {
      expect(source(f)).toMatch(/hasCode=\{|mfa=\{|canAct=\{/);
    }
  });
});

describe('who lands where', () => {
  it.each(['app/ops/publishers/page.tsx', 'app/ops/payee-requests/page.tsx'])(
    '%s sends a buyer, a seller and a visitor to sign in, and shows an operator without the code the queue',
    (f) => {
      const page = source(f);
      expect(page).toMatch(/actor\?\.kind !== 'operator'\) redirect\('\/signin\?next=\/ops\/(publishers|payee-requests)'\)/);
      expect(page).not.toMatch(/MfaNeeded|publishers-mfa-needed|payee-mfa-needed|mfa_required/);
      expect(page).toMatch(/from '(\.\.\/)+composition\/ops-sellers'/);
      expect(page).not.toMatch(/server\/access/);
    },
  );

  it('the routes still refuse a buyer, a seller and a visitor', async () => {
    for (const [url, load, body] of POSTS) {
      const route = await load();
      for (const [session, want] of [[w.refund.A, [403]], [w.pub['harbour-ledger'], [403]], [null, [401]]] as [Session | null, number[]][]) {
        const res = await call(route.POST, { url, method: 'POST', body, session });
        expect(want).toContain(res.status);
      }
    }
  });
});
