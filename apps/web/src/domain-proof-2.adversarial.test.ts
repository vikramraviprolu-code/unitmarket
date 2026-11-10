// DOMAIN-PROOF-2 (D-116), adversarial: a publisher cannot see or use another publisher's code or address; the lane
// touches nothing of PayPal, approval, payments, ledger or entitlements.
import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  SHOP,
  SHOP_HOST,
  bootImportWorld,
  fakeWeb,
  homeWithToken,
  shopPages,
} from './web-import-support';
import type { ImportWebWorld } from './web-import-support';
import { call } from './support';

vi.mock('server-only', () => ({}));
type Handler = (
  req: Request,
  ctx?: { params: Promise<Record<string, string>> },
) => Promise<Response>;

const worlds: ImportWebWorld[] = [];
const data = (name: string): string =>
  readFileSync(new URL(`../../../domain/catalogue/test-data/${name}`, import.meta.url), 'utf8');
const boot = async (): Promise<ImportWebWorld> => {
  const w = await bootImportWorld({ web: fakeWeb(shopPages(data)) });
  worlds.push(w);
  return w;
};
afterEach(async () => {
  for (const w of worlds.splice(0)) await w.app.close();
});
const json = async <T = Record<string, unknown>>(r: Response): Promise<T> => (await r.json()) as T;
const A = 'harbour-ledger';
const B = 'quayside-gazette';

const MONEY = [
  'orders',
  'order_units',
  'ledger_entries',
  'entitlements',
  'outbound_approvals',
  'payouts',
  'mandates',
  'safety_switches',
];
async function counts(w: ImportWebWorld): Promise<number[]> {
  const out: number[] = [];
  for (const t of MONEY)
    out.push(
      Number(
        (await w.app.db.query<{ c: string | number }>(`SELECT count(*) AS c FROM ${t}`)).rows[0]!.c,
      ),
    );
  return out;
}

describe('no publisher sees or uses another publisher code', () => {
  it("B's answers never hold A's code; A's code on a page does not prove B", async () => {
    const w = await boot();
    const a = (
      await json<{ token: string }>(await w.post('domains', w.pub[A], { host: SHOP_HOST }))
    ).token;
    const bRes = await w.post('domains', w.pub[B], { host: SHOP_HOST });
    const bText = await bRes.text();
    expect(bText).not.toContain(a);
    expect((await w.app.engine.webImport.domains(w.actor[B]))!.domains).toHaveLength(1);
    expect(JSON.stringify(await w.app.engine.webImport.domains(w.actor[B]))).not.toContain(a);
    expect(JSON.stringify(await w.app.engine.webImport.proofCode(w.actor[B]))).not.toContain(a);
    w.web.pages[`${SHOP}/`] = { body: homeWithToken(a) };
    const c = await w.post('check', w.pub[B], { host: SHOP_HOST });
    expect(c.status).toBe(422);
    expect((await json<{ error: { code: string } }>(c)).error.code).toBe('proof_missing');
  });

  it('a body that names another publisher or a code is refused (strict), and B cannot remove or vouch A', async () => {
    const w = await boot();
    const remove = (await import('./app/api/publisher/import/domains/remove/route'))
      .POST as Handler;
    const vouch = (await import('./app/api/ops/publishers/domains/vouch/route')).POST as Handler;
    await w.post('domains', w.pub[A], { host: SHOP_HOST });
    const id = (await w.app.db.query<{ id: string }>('SELECT id FROM publisher_domains')).rows[0]!
      .id;
    const extra = await call(remove, {
      url: '/api/publisher/import/domains/remove',
      method: 'POST',
      body: { host: SHOP_HOST, publisher_id: w.pubId[A] },
      session: w.pub[B],
    });
    expect(extra.status).toBe(422);
    const other = await call(remove, {
      url: '/api/publisher/import/domains/remove',
      method: 'POST',
      body: { host: SHOP_HOST },
      session: w.pub[B],
    });
    expect(other.status).toBe(404);
    const asOp = await call(vouch, {
      url: '/api/ops/publishers/domains/vouch',
      method: 'POST',
      body: { domain_id: id, reason: 'I am a publisher' },
      session: w.pub[B],
    });
    expect(asOp.status).toBe(403);
    const row = await w.app.db.query<{ state: string }>('SELECT state FROM publisher_domains');
    expect(row.rows).toEqual([{ state: 'pending' }]);
  });
});

describe('the lane touches no money, approval or PayPal state', () => {
  it('request, vouch, remove, begin leave orders, ledger, entitlements, approvals, payouts and switches as they were', async () => {
    const w = await boot();
    const vouch = (await import('./app/api/ops/publishers/domains/vouch/route')).POST as Handler;
    const remove = (await import('./app/api/publisher/import/domains/remove/route'))
      .POST as Handler;
    const before = await counts(w);
    await w.post('domains', w.pub[A], { host: SHOP_HOST });
    const id = (await w.app.db.query<{ id: string }>('SELECT id FROM publisher_domains')).rows[0]!
      .id;
    await call(vouch, {
      url: '/api/ops/publishers/domains/vouch',
      method: 'POST',
      body: { domain_id: id, reason: 'Checked on a call' },
      session: w.refund.op,
    });
    await w.post('begin', w.pub[A], { source_url: `${SHOP}/catalogue` });
    await w.app.engine.webImport.runPending();
    await call(remove, {
      url: '/api/publisher/import/domains/remove',
      method: 'POST',
      body: { host: SHOP_HOST },
      session: w.pub[A],
    });
    expect(await counts(w)).toEqual(before);
  });

  it('the new code does not import payments, approval, paypal, safety or ledger', () => {
    const src = readFileSync(
      new URL('../../../domain/catalogue/src/domain-proof.ts', import.meta.url),
      'utf8',
    );
    expect(src).not.toMatch(
      /from '(@umsbx\/(payments|approval|ledger|entitlements|paypal|safety|transport))/,
    );
  });
});
