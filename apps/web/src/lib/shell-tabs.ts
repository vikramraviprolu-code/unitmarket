// INT-UI0 / UI0.1: the lasting tabs of each persona, as data. Pure: no server module, no clock, no
// identity. The shell renders what this returns and the tests pin it. A tab whose page another lane builds
// (operator Buyers and Agents in OPS-C; buyer Spending and Agents in BUY) carries `ready: false` and stays
// out of the shell until that lane flips the flag, so nobody sees an empty "coming soon" tab.
// Seller URLs keep /publisher; the labels say Seller words (decision V2). The public /seller apply page
// is not part of any persona and is unchanged.
export type ShellPersona = 'operator' | 'buyer' | 'seller';

export interface ShellTab {
  id: string;
  label: string;
  href: string;
  /** False until the lane that owns the page has built it. */
  ready: boolean;
}

export const PERSONA_WORD: Record<ShellPersona, string> = {
  operator: 'Operator',
  buyer: 'Buyer',
  seller: 'Seller',
};

export const TABS: Record<ShellPersona, readonly ShellTab[]> = {
  operator: [
    { id: 'home', label: 'Home', href: '/ops', ready: true },
    { id: 'buyers', label: 'Buyers', href: '/ops/buyers', ready: true },
    { id: 'sellers', label: 'Sellers', href: '/ops/sellers', ready: true },
    { id: 'money', label: 'Money', href: '/ops/money', ready: true },
    { id: 'agents', label: 'Agents and API', href: '/ops/agents', ready: false },
    { id: 'controls', label: 'Controls', href: '/ops/controls', ready: true },
  ],
  buyer: [
    { id: 'home', label: 'Home', href: '/buyer', ready: true },
    { id: 'find', label: 'Find', href: '/discover', ready: true },
    { id: 'library', label: 'Library', href: '/library', ready: true },
    { id: 'spending', label: 'Spending', href: '/buyer/spending', ready: false },
    { id: 'agents', label: 'Agents', href: '/buyer/agents', ready: false },
  ],
  seller: [
    { id: 'home', label: 'Home', href: '/publisher', ready: true },
    { id: 'offers', label: 'Offers', href: '/publisher/offers', ready: true },
    { id: 'sales', label: 'Sales', href: '/publisher/sales', ready: true },
    { id: 'money', label: 'Money', href: '/publisher/statement', ready: true },
    { id: 'account', label: 'Account', href: '/publisher/payout-account', ready: true },
  ],
};

/** The tabs the shell shows: only those whose page exists. */
export function visibleTabs(persona: ShellPersona): ShellTab[] {
  return TABS[persona].filter((t) => t.ready);
}

/** The signed in actor kind picks the persona. A publisher is a seller; nobody signed in gets none. */
export function personaForActor(
  kind: 'buyer' | 'publisher' | 'operator' | null,
): ShellPersona | null {
  switch (kind) {
    case 'operator':
      return 'operator';
    case 'buyer':
      return 'buyer';
    case 'publisher':
      return 'seller';
    default:
      return null;
  }
}

/** The path alone: no query, no fragment, no trailing slash (except the root). */
export function cleanPath(path: string): string {
  const bare = path.split('#')[0]!.split('?')[0]!;
  return bare.length > 1 ? bare.replace(/\/+$/, '') : bare;
}

const under = (path: string, base: string): boolean => path === base || path.startsWith(`${base}/`);

/**
 * Which tab a path belongs to, or null. Home matches its own URL only, so /ops is not a prefix of every
 * operator page. Pages kept at their old URLs belong to a tab: /ops/publishers and /ops/payee-requests to
 * Sellers, /ops/evals to Controls. BR-6: /ops/rules and the pages below it belong to Controls.
 */
export function activeTabId(persona: ShellPersona, rawPath: string): string | null {
  const path = cleanPath(rawPath);
  switch (persona) {
    case 'operator':
      if (path === '/ops') return 'home';
      if (under(path, '/ops/buyers')) return 'buyers';
      if (
        under(path, '/ops/sellers') ||
        under(path, '/ops/publishers') ||
        under(path, '/ops/payee-requests')
      )
        return 'sellers';
      if (under(path, '/ops/money')) return 'money';
      if (under(path, '/ops/agents')) return 'agents';
      if (under(path, '/ops/controls') || under(path, '/ops/evals') || under(path, '/ops/rules'))
        return 'controls';
      return null;
    case 'buyer':
      if (path === '/buyer') return 'home';
      if (under(path, '/discover')) return 'find';
      if (under(path, '/library')) return 'library';
      if (under(path, '/buyer/spending')) return 'spending';
      if (under(path, '/buyer/agents')) return 'agents';
      return null;
    case 'seller':
      if (path === '/publisher') return 'home';
      if (under(path, '/publisher/offers')) return 'offers';
      if (under(path, '/publisher/sales')) return 'sales';
      if (under(path, '/publisher/statement')) return 'money';
      if (under(path, '/publisher/payout-account')) return 'account';
      return null;
  }
}

export interface SubTab {
  label: string;
  href: string;
  current: boolean;
}

const SELLERS_SUB: readonly [string, string][] = [
  ['Overview', '/ops/sellers'],
  ['Publishers', '/ops/publishers'],
  ['Payee requests', '/ops/payee-requests'],
];
const CONTROLS_SUB: readonly [string, string][] = [
  ['Switches and gate', '/ops/controls'],
  ['Evals', '/ops/evals'],
  ['Activity', '/ops/controls/activity'],
  ['Invariants', '/ops/controls/invariants'],
  ['Business rules', '/ops/rules'],
];
const MONEY_SUB: readonly [string, string][] = [
  ['Overview', '/ops/money'],
  ['Transactions', '/ops/money/transactions'],
];

/** The section tabs of the Sellers and Controls tabs; null on every other page. */
export function subTabsFor(persona: ShellPersona, rawPath: string): SubTab[] | null {
  if (persona !== 'operator') return null;
  const tab = activeTabId('operator', rawPath);
  const list =
    tab === 'sellers'
      ? SELLERS_SUB
      : tab === 'controls'
        ? CONTROLS_SUB
        : tab === 'money'
          ? MONEY_SUB
          : null;
  if (list === null) return null;
  const path = cleanPath(rawPath);
  return list.map(([label, href]) => ({ label, href, current: path === href }));
}

/** The label of the tab a sub tab list belongs to, for its landmark name. */
export function subTabsLabel(persona: ShellPersona, rawPath: string): string | null {
  const id = activeTabId(persona, rawPath);
  return TABS[persona].find((t) => t.id === id)?.label ?? null;
}
