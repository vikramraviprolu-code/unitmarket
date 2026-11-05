// INT-UI0 / UI0.2, UI0.3: where each block of the old /ops page went, as data. The server never sees a
// #fragment, so no redirect can carry an old anchor: /ops is Operator Home, and for each block that moved
// Home keeps a stub section with the old id, one sentence and a link to the new place. An old bookmark
// lands on the stub. The kill switch and the alerts stay on Home. Tests read this table.
// Pure: no server module. Every path is relative and passes lib/next-path.ts (no //, no scheme).

export interface ShellMove {
  /** Plain name of the block, for the stub sentence. */
  block: string;
  /** The id of the section on the old /ops page, and on the new page. */
  id: string;
  from: '/ops';
  to: string;
  /** False for a block that stays on Home. */
  moved: boolean;
  /** The tab it moved to, in plain words. */
  tab: string;
}

const move = (block: string, id: string, to: string, tab: string): ShellMove => ({
  block,
  id,
  from: '/ops',
  to,
  moved: to !== '/ops',
  tab,
});

export const SHELL_MOVES: readonly ShellMove[] = [
  move('Kill switch', 'ops-kill', '/ops', 'Home'),
  move('Alerts', 'ops-alerts', '/ops', 'Home'),
  move('Switches', 'ops-switches', '/ops/controls', 'Controls'),
  move('Outbound approval gate', 'ops-gate-section', '/ops/controls', 'Controls'),
  move('Refunds', 'ops-refunds', '/ops/money', 'Money'),
  move('Orders', 'ops-orders', '/ops/money', 'Money'),
  move('Totals', 'ops-totals', '/ops/money', 'Money'),
  move('Operations by state', 'ops-states', '/ops/money', 'Money'),
  move('Invariants', 'ops-invariants', '/ops/money', 'Money'),
  move('Shared payee', 'ops-shared-payee', '/ops/sellers', 'Sellers'),
];

export interface KeptUrl {
  url: string;
  /** The tab it shows under: 'sellers' and 'controls' as section tabs, the rest 'tabs only'. */
  under: string;
}

/** URLs that keep working at the same place. The first three show under a tab's section tabs. */
export const KEPT_URLS: readonly KeptUrl[] = [
  { url: '/ops/publishers', under: 'sellers' },
  { url: '/ops/payee-requests', under: 'sellers' },
  { url: '/ops/evals', under: 'controls' },
  { url: '/publisher', under: 'seller tabs' },
  { url: '/library', under: 'buyer tabs' },
  { url: '/account', under: 'buyer tabs' },
  { url: '/discover', under: 'buyer tabs' },
  { url: '/buyer', under: 'buyer tabs' },
];

export interface Stub {
  /** One sentence. */
  text: string;
  /** The link text. */
  link: string;
  /** Path plus the same id on the new page. */
  href: string;
}

/** The words and the link of the stub Home keeps for a moved block. */
export function stubFor(m: ShellMove): Stub {
  return {
    text: `${m.block} moved to ${m.tab}.`,
    link: `Open ${m.block.toLowerCase()} in ${m.tab}`,
    href: `${m.to}#${m.id}`,
  };
}
