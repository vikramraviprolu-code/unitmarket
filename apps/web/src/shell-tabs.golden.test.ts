// INT-UI0 / UI0.1 golden: the tabs of each persona, their URLs, which are hidden until another lane
// builds their page, and the breadcrumb trail for 12 paths. Pure logic only (lib/shell-tabs.ts,
// lib/breadcrumb.ts): the vitest runner does not compile .tsx, so the components are read as text in
// shell-a11y.state.test.ts and driven in e2e/shell.spec.ts.
import { describe, expect, it } from 'vitest';
import {
  TABS,
  activeTabId,
  personaForActor,
  subTabsFor,
  visibleTabs,
  type ShellPersona,
} from './lib/shell-tabs';
import { breadcrumbFor } from './lib/breadcrumb';

const rows = (p: ShellPersona) => TABS[p].map((t) => [t.label, t.href, t.ready]);

describe('tabs per persona (spec UI0.1)', () => {
  it('operator: Home, Buyers, Sellers, Money, Agents and API, Controls', () => {
    expect(rows('operator')).toEqual([
      ['Home', '/ops', true],
      ['Buyers', '/ops/buyers', true],
      ['Sellers', '/ops/sellers', true],
      ['Money', '/ops/money', true],
      ['Agents and API', '/ops/agents', false],
      ['Controls', '/ops/controls', true],
    ]);
  });
  it('buyer: Home, Find, Library, Spending, Agents', () => {
    expect(rows('buyer')).toEqual([
      ['Home', '/buyer', true],
      ['Find', '/discover', true],
      ['Library', '/library', true],
      ['Spending', '/buyer/spending', true],
      ['Agents', '/buyer/agents', true],
    ]);
  });
  it('seller: URLs keep /publisher, the labels say Seller words', () => {
    expect(rows('seller')).toEqual([
      ['Home', '/publisher', true],
      ['Offers', '/publisher/offers', true],
      ['Sales', '/publisher/sales', true],
      ['Money', '/publisher/statement', true],
      ['Account', '/publisher/payout-account', true],
    ]);
  });
  it('a tab whose page another lane builds is hidden, never shown as coming soon', () => {
    expect(visibleTabs('operator').map((t) => t.label)).toEqual([
      'Home',
      'Buyers', // INT-OPS-A: the case queue is its page
      'Sellers',
      'Money',
      'Controls',
    ]);
    expect(visibleTabs('buyer').map((t) => t.label)).toEqual([
      'Home',
      'Find',
      'Library',
      'Spending',
      'Agents',
    ]);
    expect(visibleTabs('seller')).toHaveLength(5);
    for (const p of ['operator', 'buyer', 'seller'] as const)
      for (const t of TABS[p]) expect(typeof t.ready).toBe('boolean');
  });
  it('tab ids are unique inside a persona and every label is plain words', () => {
    for (const p of ['operator', 'buyer', 'seller'] as const) {
      const ids = TABS[p].map((t) => t.id);
      expect(new Set(ids).size).toBe(ids.length);
      for (const t of TABS[p]) expect(t.label).not.toMatch(/[‒-―]|--|\s-\s|coming soon/i);
    }
  });
  it('the actor kind picks the persona: a publisher is a seller, nobody gets none', () => {
    expect(personaForActor('operator')).toBe('operator');
    expect(personaForActor('buyer')).toBe('buyer');
    expect(personaForActor('publisher')).toBe('seller');
    expect(personaForActor(null)).toBeNull();
  });
});

describe('the active tab', () => {
  it.each([
    ['operator', '/ops', 'home'],
    ['operator', '/ops/money', 'money'],
    ['operator', '/ops/money#ops-refunds', 'money'],
    ['operator', '/ops/sellers', 'sellers'],
    ['operator', '/ops/publishers', 'sellers'],
    ['operator', '/ops/payee-requests', 'sellers'],
    ['operator', '/ops/controls', 'controls'],
    ['operator', '/ops/evals', 'controls'],
    ['operator', '/ops/buyers', 'buyers'],
    ['buyer', '/buyer', 'home'],
    ['buyer', '/discover', 'find'],
    ['buyer', '/library', 'library'],
    ['buyer', '/library/ent_1', 'library'],
    ['seller', '/publisher', 'home'],
    ['seller', '/publisher/offers', 'offers'],
    ['seller', '/publisher/offers/new', 'offers'],
    ['seller', '/publisher/sales', 'sales'],
    ['seller', '/publisher/statement', 'money'],
    ['seller', '/publisher/payout-account', 'account'],
  ] as const)('%s at %s marks %s', (persona, path, id) => {
    expect(activeTabId(persona, path)).toBe(id);
  });
  it('a path outside the persona marks nothing, and /ops is not a prefix of everything', () => {
    expect(activeTabId('operator', '/library')).toBeNull();
    expect(activeTabId('operator', '/opsx')).toBeNull();
    expect(activeTabId('buyer', '/ops')).toBeNull();
    expect(activeTabId('seller', '/seller')).toBeNull();
  });
});

describe('section tabs under Sellers and Controls (spec: old URLs keep working)', () => {
  it('Sellers lists Overview, Publishers and Payee requests and marks the current one', () => {
    expect(subTabsFor('operator', '/ops/publishers')).toEqual([
      { label: 'Overview', href: '/ops/sellers', current: false },
      { label: 'Publishers', href: '/ops/publishers', current: true },
      { label: 'Payee requests', href: '/ops/payee-requests', current: false },
    ]);
    expect(subTabsFor('operator', '/ops/sellers')?.map((s) => s.current)).toEqual([
      true,
      false,
      false,
    ]);
  });
  it('Controls lists Switches and gate, Evals, and (INT-OPS-B) Activity and Invariants', () => {
    expect(subTabsFor('operator', '/ops/evals')).toEqual([
      { label: 'Switches and gate', href: '/ops/controls', current: false },
      { label: 'Evals', href: '/ops/evals', current: true },
      { label: 'Activity', href: '/ops/controls/activity', current: false },
      { label: 'Invariants', href: '/ops/controls/invariants', current: false },
    ]);
    expect(subTabsFor('operator', '/ops/controls/activity')?.map((s) => s.current)).toEqual([
      false,
      false,
      true,
      false,
    ]);
  });
  it('Money lists Overview and (INT-OPS-B) Transactions', () => {
    expect(subTabsFor('operator', '/ops/money/transactions')).toEqual([
      { label: 'Overview', href: '/ops/money', current: false },
      { label: 'Transactions', href: '/ops/money/transactions', current: true },
    ]);
  });
  it('other tabs have none', () => {
    expect(subTabsFor('operator', '/ops')).toBeNull();
    expect(subTabsFor('seller', '/publisher/offers')).toBeNull();
  });
});

describe('breadcrumbFor: the trail for 12 paths', () => {
  const trail = (p: string) => breadcrumbFor(p).map((c) => [c.label, c.href]);
  it.each([
    ['/ops', [['Operator', null]]],
    [
      '/ops/money',
      [
        ['Operator', '/ops'],
        ['Money', null],
      ],
    ],
    [
      '/ops/sellers',
      [
        ['Operator', '/ops'],
        ['Sellers', null],
      ],
    ],
    [
      '/ops/publishers',
      [
        ['Operator', '/ops'],
        ['Sellers', '/ops/sellers'],
        ['Publishers', null],
      ],
    ],
    [
      '/ops/payee-requests',
      [
        ['Operator', '/ops'],
        ['Sellers', '/ops/sellers'],
        ['Payee requests', null],
      ],
    ],
    [
      '/ops/evals',
      [
        ['Operator', '/ops'],
        ['Controls', '/ops/controls'],
        ['Evals', null],
      ],
    ],
    ['/buyer', [['Buyer', null]]],
    [
      '/discover',
      [
        ['Buyer', '/buyer'],
        ['Find', null],
      ],
    ],
    [
      '/library',
      [
        ['Buyer', '/buyer'],
        ['Library', null],
      ],
    ],
    [
      '/library/ent_1',
      [
        ['Buyer', '/buyer'],
        ['Library', '/library'],
        ['Item', null],
      ],
    ],
    ['/publisher', [['Seller', null]]],
    [
      '/publisher/offers/new',
      [
        ['Seller', '/publisher'],
        ['Offers', '/publisher/offers'],
        ['New offer', null],
      ],
    ],
  ] as const)('%s', (path, expected) => {
    expect(trail(path)).toEqual(expected);
  });
  it('ignores the query, the fragment and a trailing slash', () => {
    expect(trail('/ops/money/?x=1#ops-orders')).toEqual(trail('/ops/money'));
  });
  it('gives no trail for a path the shell does not own', () => {
    expect(breadcrumbFor('/')).toEqual([]);
    expect(breadcrumbFor('/legal/terms')).toEqual([]);
    expect(breadcrumbFor('/signin')).toEqual([]);
  });
  it('only the last crumb is the current page: it has no link', () => {
    for (const p of ['/ops/money', '/ops/publishers', '/library/ent_1']) {
      const t = breadcrumbFor(p);
      expect(t[t.length - 1]?.href).toBeNull();
      for (const c of t.slice(0, -1)) expect(c.href).not.toBeNull();
    }
  });
});
