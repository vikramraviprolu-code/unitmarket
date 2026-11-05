// INT-OPS-B / OPS-B.2: Money > Transactions. The page is a server shell that mounts a client table; the table
// reads GET /api/ops/transactions (SR1) through getJson. lib/transactions-view.ts holds the logic and is tested
// against that route's own answers: each saved view gives SR1's seeded counts, the CSV request carries the same
// canonical query as the list, and a session without MFA gets rows with no buyer, seller or provider id.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { VIEWS_EXPECTED, VIEWS_MEMBERS } from '../composition.server';
import { expectOffline } from './api-v1/offline-guard';
import { bootSearch, json } from './search-support';
import type { Handler, SearchRig, Sess } from './search-support';
import { parseQueryString } from './lib/filter-bar-view';
import {
  EXPORT_PATH,
  LIST_PATH,
  csvDownload,
  exportUrl,
  listUrl,
  nextPageHref,
  pageViewOf,
  rowsOf,
} from './lib/transactions-view';
import type { TxnItem } from './lib/transactions-view';

vi.mock('server-only', () => ({}));
vi.mock('node:net', async (orig) => (await import('./api-v1/offline-guard')).netMock(await orig()));
vi.mock('node:dns', async (orig) => (await import('./api-v1/offline-guard')).dnsMock(await orig()));
expectOffline();

const here = fileURLToPath(new URL('.', import.meta.url));
const source = (rel: string) =>
  readFileSync(join(here, rel), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');

let rig: SearchRig;
let mfa: Sess;
let noMfa: Sess;
let listRoute: Handler;
let exportRoute: Handler;

beforeAll(async () => {
  rig = await bootSearch();
  mfa = await rig.session(rig.operator);
  noMfa = await rig.session({ kind: 'operator', operator_id: 'opr_nomfa', mfa: false });
  listRoute = (await import('./app/api/ops/transactions/route')).GET as Handler;
  exportRoute = (await import('./app/api/ops/transactions/export/route')).GET as Handler;
});

const OPERATOR = { kind: 'txn', persona: 'operator' } as const;
const OPERATOR_KEY = { kind: 'txn', persona: 'operator_key' } as const;
type Page = { items: TxnItem[]; next_cursor: string | null };

const readList = async (s: Sess, url: string): Promise<Page> => {
  const res = await rig.old(listRoute, s, { url });
  expect(res.status).toBe(200);
  return json<Page>(res);
};

describe('OPS-B.2 saved views as presets', () => {
  const VIEWS = Object.keys(VIEWS_EXPECTED) as (keyof typeof VIEWS_EXPECTED)[];

  it("SR1's seeded counts are 4, 2, 5 and 3", () => {
    expect(VIEWS_EXPECTED).toEqual({
      needs_attention: 4,
      refunds_today: 2,
      agent_purchases: 5,
      sandbox_only: 3,
    });
  });

  it.each(VIEWS)('%s: the bar url gives the seeded lines, and the rows show them', async (view) => {
    const url = listUrl(OPERATOR, parseQueryString(`view=${view}`));
    expect(url).toBe(`${LIST_PATH}?view=${view}`);
    const page = await readList(mfa, url);
    expect(page.items.map((i) => i.unit_id).sort()).toEqual([...VIEWS_MEMBERS[view]].sort());
    expect(page.items).toHaveLength(VIEWS_EXPECTED[view]);
    const view$ = pageViewOf({ ok: true, data: page }, { mfa: true });
    expect(view$.kind).toBe('rows');
    if (view$.kind === 'rows') expect(view$.rows).toHaveLength(VIEWS_EXPECTED[view]);
  });

  it('a view and a filter are ANDed in the url the table sends', async () => {
    const url = listUrl(OPERATOR, parseQueryString('status=paid&view=agent_purchases&cursor=zzz'));
    expect(url).toBe(`${LIST_PATH}?status=paid&view=agent_purchases`);
    expect((await readList(mfa, url)).items.length).toBeGreaterThanOrEqual(0);
  });
});

describe('OPS-B.2 the CSV button', () => {
  it('asks the export route with the same canonical query as the list', () => {
    for (const q of [
      '',
      'view=agent_purchases',
      'status=paid,failed&currency=USD&from=2026-11-01',
      'q=tide&sort=amount&dir=asc&cursor=abc',
    ]) {
      const raw = parseQueryString(q);
      const list = listUrl(OPERATOR, raw);
      const csv = exportUrl(OPERATOR, raw);
      expect(csv.startsWith(`${EXPORT_PATH}`)).toBe(true);
      expect(csv.slice(EXPORT_PATH.length)).toBe(list.slice(LIST_PATH.length));
      expect(csv).not.toContain('cursor=');
    }
  });

  it('the export route answers a file name, the csv text and a truncated flag, which the button turns into a download', async () => {
    const url = exportUrl(OPERATOR, parseQueryString('view=agent_purchases'));
    const res = await rig.old(exportRoute, mfa, { url });
    expect(res.status).toBe(200);
    const body = await json<{ filename: string; csv: string; truncated: boolean }>(res);
    const file = csvDownload(body);
    expect(file.filename).toBe(body.filename);
    expect(file.text).toBe(body.csv);
    expect(file.mime).toBe('text/csv;charset=utf-8');
    expect(file.note).toBeNull();
    expect(csvDownload({ ...body, truncated: true }).note).toMatch(/first rows/i);
    expect(body.csv.split('\n').length).toBeGreaterThan(5);
  });
});

describe('OPS-B.2 identity (C3)', () => {
  const rowsFor = async (s: Sess, withMfa: boolean) => {
    const page = await readList(s, listUrl(withMfa ? OPERATOR : OPERATOR_KEY, parseQueryString('view=agent_purchases')));
    return rowsOf(page.items, { mfa: withMfa });
  };

  it('with MFA the rows name the buyer and the seller and show the PayPal order id', async () => {
    const rows = await rowsFor(mfa, true);
    expect(rows).toHaveLength(5);
    for (const r of rows) {
      expect(r.buyer).toBe('Wes Watcher');
      expect(r.seller).toBe('Quay Views');
      expect(r.provider_order).toMatch(/^PAYPALVS/);
    }
  });

  it('without MFA the rows have no buyer, no seller and no provider id (deep scan)', async () => {
    const page = await readList(noMfa, listUrl(OPERATOR_KEY, parseQueryString('view=agent_purchases')));
    const rows = rowsOf(page.items, { mfa: false });
    expect(rows).toHaveLength(5);
    const text = JSON.stringify(rows);
    for (const w of [
      'Wes Watcher',
      'Vera Viewer',
      'Quay Views',
      'vs-quay',
      'PAYPALVS',
      'CAP_vs_u',
      'vs_b1',
      'vs_b2',
      'vs_p1',
    ])
      expect(text, w).not.toContain(w);
    for (const r of rows) {
      expect(r.buyer).toBeNull();
      expect(r.seller).toBeNull();
      expect(r.provider_order).toBeNull();
    }
  });

  it('a row never invents identity the line does not carry, even with MFA', () => {
    const [r] = rowsOf(
      [
        {
          unit_id: 'u1',
          order_ref: 'ref_1',
          order_ref6: 'ref_1',
          status: 'paid',
          created_at: '2026-11-04T10:00:00.000Z',
          currency: 'USD',
          amount_minor: 250,
          refunded_minor: 0,
          environment: 'dryrun',
          channel: 'human',
        } as TxnItem,
      ],
      { mfa: true },
    );
    expect(r!.buyer).toBeNull();
    expect(r!.seller).toBeNull();
    expect(r!.provider_order).toBeNull();
  });
});

describe('OPS-B.2 the rows and the page states', () => {
  it('a row links to the order page, says the status in words, and writes money and time', async () => {
    const page = await readList(mfa, listUrl(OPERATOR, parseQueryString('view=needs_attention')));
    const [r] = rowsOf(page.items, { mfa: true });
    expect(r!.href).toBe(`/ops/money/orders/${encodeURIComponent(page.items[0]!.order_ref)}`);
    expect(r!.status_word).toBe('Needs attention');
    expect(r!.amount).toMatch(/\d\.\d{2}$/);
    expect(r!.when).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2} UTC$/);
    // The label comes from the stored environment, not from a literal.
    expect(['dryrun', 'sandbox']).toContain(r!.environment);
  });

  it('writes the empty, error and refused states in plain sentences', () => {
    expect(pageViewOf({ ok: true, data: { items: [], next_cursor: null } }, { mfa: true }).kind).toBe('empty');
    const failed = pageViewOf({ ok: false, status: 0, code: 'network', message: 'x' }, { mfa: true });
    expect(failed).toEqual({ kind: 'error', message: expect.stringMatching(/could not be loaded/i) });
    const refused = pageViewOf({ ok: false, status: 400, code: 'field_not_allowed', message: 'x' }, { mfa: true });
    expect(refused.kind).toBe('error');
    const limited = pageViewOf({ ok: false, status: 429, code: 'rate_limited', message: 'x' }, { mfa: true });
    expect(limited).toEqual({ kind: 'error', message: expect.stringMatching(/too many|wait/i) });
  });

  it('the next page link carries the cursor and the filters, and a new filter leaves it behind', () => {
    const raw = parseQueryString('status=paid&cursor=old');
    const next = nextPageHref('/ops/money/transactions', OPERATOR, raw, 'abc-DEF_123');
    expect(next).toBe('/ops/money/transactions?status=paid&cursor=abc-DEF_123');
    expect(nextPageHref('/ops/money/transactions', OPERATOR, raw, null)).toBeNull();
  });
});

describe('OPS-B.2 the page reads only through getJson', () => {
  it('the table, the view and the page hold no fetch( of their own', () => {
    for (const f of [
      'ui/ops/TransactionsTable.tsx',
      'lib/transactions-view.ts',
      'app/ops/money/transactions/page.tsx',
    ])
      expect(source(f), f).not.toMatch(/\bfetch\s*\(/);
    expect(source('ui/ops/TransactionsTable.tsx')).toMatch(/getJson/);
    expect(source('ui/ops/TransactionsTable.tsx')).toMatch(/from '\.\.\/\.\.\/lib\/client-api'/);
  });

  it('the page checks for an operator first and reads only from its tab module', () => {
    const page = source('app/ops/money/transactions/page.tsx');
    expect(page).toMatch(/if \(actor\?\.kind !== 'operator'\) redirect\('\/signin\?next=\/ops\/money\/transactions'\);/);
    expect(page).toMatch(/from '\.\.\/\.\.\/\.\.\/\.\.\/composition\/ops-money'/);
    expect(page).not.toMatch(/composition\.server|server\/access/);
  });

  it('the page and table never print a literal environment label', () => {
    for (const f of ['ui/ops/TransactionsTable.tsx', 'app/ops/money/transactions/page.tsx'])
      expect(source(f), f).not.toMatch(/['"`>]\s*(Sandbox|Dry run)\s*['"`<]/);
  });
});
