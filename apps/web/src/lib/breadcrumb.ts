// INT-UI0 / UI0.1: the breadcrumb trail for a path. Pure. The last crumb is the page you are on and has no
// link. A path the shell does not own gives an empty trail, so public pages show no breadcrumb.
import { cleanPath } from './shell-tabs';

export interface Crumb {
  label: string;
  /** Null for the current page. */
  href: string | null;
}

type Trail = readonly [string, string | null][];

/** Fixed trails by exact path, written as [label, href of that crumb]. The last href is ignored. */
const EXACT: Record<string, Trail> = {
  '/ops': [['Operator', '/ops']],
  '/ops/buyers': [
    ['Operator', '/ops'],
    ['Buyers', '/ops/buyers'],
  ],
  '/ops/sellers': [
    ['Operator', '/ops'],
    ['Sellers', '/ops/sellers'],
  ],
  '/ops/money': [
    ['Operator', '/ops'],
    ['Money', '/ops/money'],
  ],
  '/ops/agents': [
    ['Operator', '/ops'],
    ['Agents and API', '/ops/agents'],
  ],
  '/ops/controls': [
    ['Operator', '/ops'],
    ['Controls', '/ops/controls'],
  ],
  '/ops/publishers': [
    ['Operator', '/ops'],
    ['Sellers', '/ops/sellers'],
    ['Publishers', '/ops/publishers'],
  ],
  '/ops/payee-requests': [
    ['Operator', '/ops'],
    ['Sellers', '/ops/sellers'],
    ['Payee requests', '/ops/payee-requests'],
  ],
  '/ops/evals': [
    ['Operator', '/ops'],
    ['Controls', '/ops/controls'],
    ['Evals', '/ops/evals'],
  ],
  '/buyer': [['Buyer', '/buyer']],
  '/buyer/spending': [
    ['Buyer', '/buyer'],
    ['Spending', '/buyer/spending'],
  ],
  '/buyer/agents': [
    ['Buyer', '/buyer'],
    ['Agents', '/buyer/agents'],
  ],
  '/discover': [
    ['Buyer', '/buyer'],
    ['Find', '/discover'],
  ],
  '/library': [
    ['Buyer', '/buyer'],
    ['Library', '/library'],
  ],
  '/publisher': [['Seller', '/publisher']],
  '/publisher/offers': [
    ['Seller', '/publisher'],
    ['Offers', '/publisher/offers'],
  ],
  '/publisher/offers/new': [
    ['Seller', '/publisher'],
    ['Offers', '/publisher/offers'],
    ['New offer', null],
  ],
  '/publisher/sales': [
    ['Seller', '/publisher'],
    ['Sales', '/publisher/sales'],
  ],
  '/publisher/statement': [
    ['Seller', '/publisher'],
    ['Money', '/publisher/statement'],
  ],
  '/publisher/payout-account': [
    ['Seller', '/publisher'],
    ['Account', '/publisher/payout-account'],
  ],
};

/** Trails for one level below a list page: the parent list, then a fixed word for the item. */
const CHILD: readonly { base: string; trail: Trail; item: string }[] = [
  {
    base: '/library',
    trail: [
      ['Buyer', '/buyer'],
      ['Library', '/library'],
    ],
    item: 'Item',
  },
  {
    base: '/publisher/offers',
    trail: [
      ['Seller', '/publisher'],
      ['Offers', '/publisher/offers'],
    ],
    item: 'Offer',
  },
];

function finish(trail: Trail): Crumb[] {
  return trail.map(([label, href], i) => ({ label, href: i === trail.length - 1 ? null : href }));
}

export function breadcrumbFor(rawPath: string): Crumb[] {
  const path = cleanPath(rawPath);
  const exact = EXACT[path];
  if (exact !== undefined) return finish(exact);
  for (const c of CHILD) {
    if (path.startsWith(`${c.base}/`) && path.split('/').length === c.base.split('/').length + 1)
      return finish([...c.trail, [c.item, null]]);
  }
  return [];
}
