// INT-OPS-B / OPS-B.3: quick-find. Pressing "/" in the operator shell opens a search over GET /api/ops/find.
// lib/quick-find-view.ts turns the route's answer into groups in a fixed order (Orders, Sellers, Offers, Keys,
// Buyers), and Buyers appear only with MFA. The first Orders hit is the Enter target. Only the operator shell
// mounts it (B6); the buyer and seller shells never call /api/ops/find. The typed text is never logged.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { expectOffline } from './api-v1/offline-guard';
import { bootSearch, json } from './search-support';
import type { Handler, SearchRig, Sess } from './search-support';
import {
  FIND_GROUP_ORDER,
  FIND_PATH,
  MIN_FIND_CHARS,
  findUrl,
  quickFindView,
  showsQuickFind,
} from './lib/quick-find-view';
import type { FindAnswer } from './lib/quick-find-view';

vi.mock('server-only', () => ({}));
vi.mock('node:net', async (orig) => (await import('./api-v1/offline-guard')).netMock(await orig()));
vi.mock('node:dns', async (orig) => (await import('./api-v1/offline-guard')).dnsMock(await orig()));
expectOffline();

const here = fileURLToPath(new URL('.', import.meta.url));
const code = (rel: string) =>
  readFileSync(join(here, rel), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
const filesUnder = (rel: string): string[] =>
  readdirSync(join(here, rel)).flatMap((n) => {
    const p = `${rel}/${n}`;
    return statSync(join(here, p)).isDirectory() ? filesUnder(p) : [p];
  });

let rig: SearchRig;
let findRoute: Handler;
let mfa: Sess;
let noMfa: Sess;
beforeAll(async () => {
  rig = await bootSearch();
  findRoute = (await import('./app/api/ops/find/route')).GET as Handler;
  mfa = await rig.session(rig.operator);
  noMfa = await rig.session({ kind: 'operator', operator_id: 'opr_nomfa', mfa: false });
});

const find = async (s: Sess, q: string): Promise<FindAnswer> => {
  const url = findUrl(q);
  expect(url, q).not.toBeNull();
  const res = await rig.old(findRoute, s, { url: url! });
  expect(res.status).toBe(200);
  return json<FindAnswer>(res);
};

describe('OPS-B.3 the request', () => {
  it('asks /api/ops/find with the text encoded, and not before there is enough to look for', () => {
    expect(FIND_PATH).toBe('/api/ops/find');
    expect(MIN_FIND_CHARS).toBe(2);
    expect(findUrl('ref_vs_o1')).toBe('/api/ops/find?q=ref_vs_o1');
    expect(findUrl('  a b&c  ')).toBe('/api/ops/find?q=a%20b%26c');
    expect(findUrl('')).toBeNull();
    expect(findUrl(' a ')).toBeNull();
    expect(findUrl('x'.repeat(101))).toBeNull();
    expect(findUrl('a\u0000b')).toBeNull();
  });
});

describe('OPS-B.3 the groups', () => {
  it('lists Orders, Sellers, Offers, Keys and Buyers in that fixed order', () => {
    expect([...FIND_GROUP_ORDER]).toEqual(['orders', 'sellers', 'offers', 'keys', 'buyers']);
  });

  it('renders a real answer for a signed-in operator with MFA, groups in order, Buyers last', async () => {
    const answer = await find(mfa, 'Quay');
    const v = quickFindView(answer, { mfa: true });
    expect(v.groups.map((g) => g.id)).toEqual(
      FIND_GROUP_ORDER.filter((g) => v.groups.some((x) => x.id === g)),
    );
    expect(v.groups.map((g) => g.label)).toEqual(
      v.groups.map((g) => ({ orders: 'Orders', sellers: 'Sellers', offers: 'Offers', keys: 'Keys', buyers: 'Buyers' })[g.id]),
    );
    expect(v.groups.some((g) => g.id === 'sellers')).toBe(true);
  });

  it('finds an order by its ref and points Enter at the order page', async () => {
    const answer = await find(mfa, 'ref_vs_o1');
    expect(answer.orders.length).toBeGreaterThan(0);
    const v = quickFindView(answer, { mfa: true });
    expect(v.groups[0]!.id).toBe('orders');
    expect(v.firstOrderHref).toBe('/ops/money/orders/ref_vs_o1');
    expect(v.groups[0]!.items[0]!.href).toBe('/ops/money/orders/ref_vs_o1');
    expect(v.empty).toBe(false);
  });

  it('encodes a ref that has odd characters', () => {
    const v = quickFindView(
      {
        orders: [
          {
            order_ref: 'ref a/b?c',
            order_ref6: 'a/b?c',
            matched: 'order_ref',
            status: 'paid_partial',
            currency: 'USD',
            total_minor: 500,
            environment: 'dryrun',
            created_at: '2026-11-04T10:00:00.000Z',
          },
        ],
        sellers: [],
        offers: [],
        keys: [],
      },
      { mfa: false },
    );
    expect(v.firstOrderHref).toBe('/ops/money/orders/ref%20a%2Fb%3Fc');
  });

  it('shows Buyers only with MFA, whatever the answer holds', async () => {
    const withBuyers: FindAnswer = {
      orders: [],
      sellers: [],
      offers: [],
      keys: [],
      buyers: [{ buyer_id: 'vs_b2', display_name: 'Wes Watcher' }],
    };
    expect(quickFindView(withBuyers, { mfa: true }).groups.map((g) => g.id)).toEqual(['buyers']);
    const cut = quickFindView(withBuyers, { mfa: false });
    expect(cut.groups).toEqual([]);
    expect(cut.empty).toBe(true);
    expect(JSON.stringify(cut)).not.toContain('Wes Watcher');
    // And the route itself already leaves them out for a session without MFA.
    const plain = await find(noMfa, 'Wes');
    expect(plain.buyers).toBeUndefined();
  });

  it('says so in a plain sentence when nothing matches', async () => {
    const v = quickFindView(await find(mfa, 'zzzz-no-such-thing'), { mfa: true });
    expect(v.empty).toBe(true);
    expect(v.firstOrderHref).toBeNull();
    expect(v.emptyText).toMatch(/nothing found/i);
  });

  it('shows a seller by slug without MFA and by name with it', async () => {
    const plain = quickFindView(await find(noMfa, 'vs-quay'), { mfa: false });
    const seller = plain.groups.find((g) => g.id === 'sellers');
    expect(seller).toBeDefined();
    expect(JSON.stringify(plain)).not.toContain('Quay Views');
    const named = quickFindView(await find(mfa, 'Quay'), { mfa: true });
    expect(JSON.stringify(named)).toContain('Quay Views');
  });
});

describe('OPS-B.3 only the operator shell has it (B6)', () => {
  it('says yes for the operator persona and no for the buyer and the seller', () => {
    expect(showsQuickFind('operator')).toBe(true);
    expect(showsQuickFind('buyer')).toBe(false);
    expect(showsQuickFind('seller')).toBe(false);
  });

  it('SearchSlot mounts QuickFind behind the operator persona and nowhere else', () => {
    const slot = code('ui/shell/SearchSlot.tsx');
    expect(slot).toMatch(/import \{ QuickFind \} from '\.\.\/ops\/QuickFind'/);
    expect(slot).toMatch(/showsQuickFind\(persona\)/);
    expect(code('ui/shell/Shell.tsx')).toMatch(/<SearchSlot persona=\{persona\}/);
  });

  it('no buyer or seller page, layout or shell part names QuickFind or /api/ops/find', () => {
    const allowed = new Set([
      'ui/ops/QuickFind.tsx',
      'ui/shell/SearchSlot.tsx',
      'lib/quick-find-view.ts',
      'app/api/ops/find/route.ts',
    ]);
    const hits = [...filesUnder('ui'), ...filesUnder('app'), ...filesUnder('lib')]
      .filter((f) => /\.(ts|tsx)$/.test(f) && !f.endsWith('.test.ts'))
      .filter((f) => !allowed.has(f))
      .filter((f) => /QuickFind|api\/ops\/find/.test(code(f)));
    expect(hits).toEqual([]);
    for (const f of ['ui/shell/PhoneBar.tsx', 'ui/shell/Tabs.tsx', 'ui/shell/Breadcrumb.tsx'])
      expect(code(f), f).not.toMatch(/QuickFind|api\/ops\/find/);
  });
});

describe('OPS-B.3 the typed text is never logged', () => {
  it('the component and the view hold no console call, no storage write and no beacon', () => {
    for (const f of ['ui/ops/QuickFind.tsx', 'lib/quick-find-view.ts']) {
      const src = code(f);
      expect(src, f).not.toMatch(/console\.|localStorage|sessionStorage|sendBeacon|document\.cookie/);
    }
  });

  it('the route keeps the query out of its log line (it logs the path only)', () => {
    const route = code('app/api/ops/find/route.ts');
    expect(route).not.toMatch(/console\.|logger\./);
  });
});
