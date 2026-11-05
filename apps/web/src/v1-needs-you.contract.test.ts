// INT-AL AL.6: GET /api/v1/ops/needs-you. The shape is the one in contracts/v1-alerts.ts; the counts match what
// was seeded for each source; every href is a page the operator shell has (OPS_PAGES), and each listed path has a
// page.tsx. A bearer key with ops:read reads it; no other key does.
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { NeedsYouSchema, OPS_PAGES, V1_ROUTES } from '@umsbx/contracts';
import { bootAlertRig, rows, seedAlert } from './ops-alerts-support';
import type { AlertRig, Handler } from './ops-alerts-support';

vi.mock('server-only', () => ({}));

let r: AlertRig;
let get: Handler;
const read = async (token: string | null = r.opKey) =>
  r.rig.v1(get, token, { url: '/api/v1/ops/needs-you' });

beforeAll(async () => {
  r = await bootAlertRig();
  get = (await import('./app/api/v1/ops/needs-you/route')).GET as Handler;
  const at = '2026-11-05T10:00:00.000Z';
  await seedAlert(r.rig, { id: 'alr_n1', kind: 'mandate_near_cap', reason: 'cap90_man_1' });
  await seedAlert(r.rig, { id: 'alr_n2', kind: 'mandate_near_cap', reason: 'cap90_man_2' });
  await seedAlert(r.rig, { id: 'alr_n3', kind: 'reversal_hint', reason: 'x' });
  for (const [id, decided] of [
    ['pub_wait1', false],
    ['pub_wait2', false],
    ['pub_rej', true],
  ] as const) {
    await r.rig.app.db.query(
      `INSERT INTO publishers (id, slug, display_name, country, status, created_at, updated_at)
       VALUES ($1::text, $1::text, $1::text, 'US', 'applied', $2::timestamptz, $2::timestamptz)`,
      [id, at],
    );
    if (decided) {
      await r.rig.app.db.query(
        `INSERT INTO publisher_applicant_decisions (id, publisher_id, decision, operator_id, reason, created_at, updated_at)
         VALUES ('aud_n1', $1, 'rejected', 'opr_x', 'no', $2, $2)`,
        [id, at],
      );
    }
  }
  await r.rig.app.db.query(
    `INSERT INTO payee_change_requests (id, publisher_id, requested_merchant_id, note, created_by, created_at, updated_at)
     SELECT 'pcr_n1', id, 'MERCH9', 'n', 'publisher', $1::timestamptz, $1::timestamptz FROM publishers WHERE slug = 'harbour-ledger'`,
    [at],
  );
});
afterAll(async () => r.rig.app.close());

type Row = { kind: string; sentence: string; href: string; count: number };
const items = async (): Promise<Row[]> => ((await (await read()).json()) as { items: Row[] }).items;
const total = (xs: Row[], kind: string): number =>
  xs.filter((x) => x.kind === kind).reduce((n, x) => n + x.count, 0);

describe('GET /api/v1/ops/needs-you (AL.6)', () => {
  it('answers 200 with the shape of NeedsYouSchema', async () => {
    const res = await read();
    expect(res.status).toBe(200);
    expect(NeedsYouSchema.safeParse(await res.json()).success).toBe(true);
  });

  it('the counts match the seed for each source', async () => {
    const xs = await items();
    expect(total(xs, 'open_alerts')).toBe(3);
    expect(total(xs, 'caps_near_limit')).toBe(2);
    expect(total(xs, 'applicants_waiting')).toBe(2);
    expect(total(xs, 'payee_checks_waiting')).toBe(1);
  });

  it('every href is in OPS_PAGES, and each listed path has a page', async () => {
    for (const x of await items()) expect(OPS_PAGES).toContain(x.href.split('#')[0]);
    for (const p of OPS_PAGES) {
      const dir = fileURLToPath(new URL(`./app${p}`, import.meta.url));
      expect(existsSync(`${dir}/page.tsx`), `page for ${p}`).toBe(true);
    }
  });

  it('is a read: an operator key with ops:read gets 200, a key of another owner or no key does not', async () => {
    expect((await read(r.opKey)).status).toBe(200);
    const buyerKey = await r.rig.key(r.rig.buyerA, ['orders:read']);
    expect((await read(buyerKey)).status).toBe(403);
    expect((await read(null)).status).toBe(401);
  });

  it('carries no buyer or seller identity and no PayPal id', async () => {
    const text = JSON.stringify(await items());
    for (const bad of ['MERCH9', 'opr_', 'buy_', '@']) expect(text).not.toContain(bad);
  });

  it('is registered as a GET with the ops:read scope, and no /api/v1/ops route writes', () => {
    const doc = V1_ROUTES.find((x) => x.path === '/api/v1/ops/needs-you');
    expect(doc).toMatchObject({ method: 'GET', auth: 'apikey', scopes: ['ops:read'] });
    for (const x of V1_ROUTES.filter((y) => y.path.startsWith('/api/v1/ops')))
      expect(x.method).toBe('GET');
  });

  it('there is no alert table write behind it', async () => {
    const before = (await rows(r.rig, 'SELECT count(*) AS c FROM alert_events'))[0];
    await read();
    expect((await rows(r.rig, 'SELECT count(*) AS c FROM alert_events'))[0]).toEqual(before);
  });
});
