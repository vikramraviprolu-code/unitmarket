// INT-TR1 / TR1.5: GET /api/ops/units/[id]/evidence and evidence.html through the real route wrapper. Both
// need an operator session WITH the second factor. The HTML lists the same events as the JSON and holds no
// buyer id outside the canon text.
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { NOW, bootStartRig } from './ops-start-support';
import type { StartRig } from './ops-start-support';
import { call } from './support';
import type { Session } from './support';
import { createHash } from 'node:crypto';

vi.mock('server-only', () => ({}));
vi.setConfig({ testTimeout: 180_000, hookTimeout: 180_000 });

let rig: StartRig;
let json: typeof import('./app/api/ops/units/[id]/evidence/route');
let html: typeof import('./app/api/ops/units/[id]/evidence.html/route');
let mfa: Session;
let plain: Session;
let unit = '';

beforeAll(async () => {
  // The authenticator code is computed for NOW, as the other operator tests do.
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  rig = await bootStartRig();
  json = await import('./app/api/ops/units/[id]/evidence/route');
  html = await import('./app/api/ops/units/[id]/evidence.html/route');
  mfa = await rig.mfaOperator();
  plain = await rig.plainOperator();
  const T = '2026-11-04T09:00:00Z';
  const q = (s: string, p: unknown[] = []) => rig.app.db.query(s, p);
  await q(
    `INSERT INTO publishers (id, slug, display_name, country, paypal_merchant_id, payee_verified_at, created_at, updated_at) VALUES ('pub_ev','pev','Ev','US','MEV',$1,$1,$1)`,
    [T],
  );
  await q(
    `INSERT INTO buyers (id, display_name, auth_subject, country, created_at, updated_at) VALUES ('buy_ev','Ev Buyer','sub_ev','US',$1,$1)`,
    [T],
  );
  await q(
    `INSERT INTO approvals (id, buyer_id, snapshot, content_hash, nonce, expires_at, used_at, environment, created_at, updated_at) VALUES ('apr_ev','buy_ev','{}',$2,'n','2026-11-04T09:15:00Z',NULL,'dryrun',$1,$1)`,
    [T, 'a'.repeat(64)],
  );
  await q(
    `INSERT INTO orders (id, approval_id, buyer_id, content_hash, order_ref, expected, status, mismatch, corridor_id, currency, total_minor, environment, created_at, updated_at) VALUES ('ord_ev','apr_ev','buy_ev',$2,'ref_ev','{}','paid',false,'us-usd','USD',500,'dryrun',$1,$1)`,
    [T, 'a'.repeat(64)],
  );
  await q(
    `INSERT INTO order_units (id, order_id, publisher_id, reference_id, payee_merchant_id, amount_minor, platform_fee_minor, capture_id, status, refunded_minor, captured_verified_at, created_at, updated_at) VALUES ('unt_ev','ord_ev','pub_ev','rid_ev','MEV',500,0,'CAPEV','captured_verified',0,$1,$1,$1)`,
    [T],
  );
  unit = 'unt_ev';
});
afterAll(async () => {
  await rig?.app.close();
});

const sha = (s: string): string => createHash('sha256').update(s, 'utf8').digest('hex');
const getJson = (s: Session | null, id = unit) =>
  call(json.GET, { url: `/api/ops/units/${id}/evidence`, session: s, params: { id } });
const getHtml = (s: Session | null, id = unit) =>
  call(html.GET, { url: `/api/ops/units/${id}/evidence.html`, session: s, params: { id } });
const code = async (r: Response): Promise<string> =>
  ((await r.json()) as { error: { code: string } }).error.code;

describe('access', () => {
  it('both routes refuse no session (401), a plain operator (403 mfa_required) and a publisher', async () => {
    expect((await getJson(null)).status).toBe(401);
    expect((await getHtml(null)).status).toBe(401);
    for (const r of [await getJson(plain), await getHtml(plain)]) {
      expect(r.status).toBe(403);
      expect(await code(r)).toBe('mfa_required');
    }
    const pub = await rig.publisher();
    expect((await getJson(pub)).status).toBe(403);
    expect((await getHtml(pub)).status).toBe(403);
  });
  it('an unknown unit is 404 for an operator with the code', async () => {
    expect((await getJson(mfa, 'unt_nope')).status).toBe(404);
    expect((await getHtml(mfa, 'unt_nope')).status).toBe(404);
  });
});

describe('the pack and the page', () => {
  it('the JSON verifies offline and holds no buyer name', async () => {
    const r = await getJson(mfa);
    expect(r.status).toBe(200);
    expect(r.headers.get('content-type')).toContain('application/json');
    const p = (await r.json()) as {
      events: { seq: number; canon: string; row_hash: string }[];
      sealed: boolean;
    };
    expect(p.events.length).toBeGreaterThan(0);
    for (const e of p.events) expect(sha(e.canon)).toBe(e.row_hash);
    expect(JSON.stringify(p)).not.toContain('Ev Buyer');
  });
  it('the HTML is a page, lists the same events, and holds no buyer id outside the canon text', async () => {
    const pack = (await (await getJson(mfa)).json()) as {
      events: { seq: number; row_hash: string }[];
    };
    const r = await getHtml(mfa);
    expect(r.status).toBe(200);
    expect(r.headers.get('content-type')).toContain('text/html');
    const page = await r.text();
    expect(page).toContain('<!doctype html>');
    const seqs = [...page.matchAll(/data-seq="(\d+)"/g)].map((m) => Number(m[1]));
    expect(seqs).toEqual(pack.events.map((e) => e.seq));
    const hashes = [...page.matchAll(/data-hash="([a-f0-9]{64})"/g)].map((m) => m[1]);
    expect(hashes).toEqual(pack.events.map((e) => e.row_hash));
    const outside = page.replace(/<pre class="canon">[\s\S]*?<\/pre>/g, '');
    expect(outside).not.toContain('buy_ev');
    expect(outside).not.toContain('Ev Buyer');
    expect(page).toContain('Not sealed yet');
  });
});
