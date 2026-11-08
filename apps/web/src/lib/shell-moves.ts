// INT-UI0 / UI0.2, UI0.3: where each block of the old /ops page went, as data. The kill switch and the alerts
// stay on Home. SCR-1: Home no longer keeps a stub for a moved block. Tests read this table.
// Pure: no server module. Every path is relative and passes lib/next-path.ts (no //, no scheme).

export interface ShellMove {
  /** Plain name of the block. */
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
