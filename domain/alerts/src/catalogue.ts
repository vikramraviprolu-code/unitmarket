// INT-AL / AL.2: the alert catalogue. One place says, for every alert kind and every gate reason, how serious it
// is, what it is called, why it happened, where to fix it, what to do next and which money is at risk. The
// operator list reads only this, so a kind that is not here cannot reach the list without a title. A kind or a
// reason prefix that is not mapped answers null; the golden test fails on any unmapped one.
import { BLOCKED_BY } from '@umsbx/contracts';
import type { BlockedBy, OpsPage } from '@umsbx/contracts';

export type Severity = 'critical' | 'high' | 'medium' | 'info';
export type MoneyRule = 'unit_amount' | 'order_total' | 'refund_amount';

/** Every kind the list can show: the 12 that payments and recovery raise and the 2 the sweep raises. */
export const ALERT_KINDS = [
  'frozen_order',
  'create_rejected',
  'content_unavailable',
  'unexpected_capture',
  'fee_above_amount',
  'payment_unresolved',
  'reversal',
  'reversal_hint',
  'partial_composite',
  'refund_unbooked',
  'refund_failed',
  'refund_unresolved',
  'mandate_near_cap',
  'webhook_failing',
] as const;
export type CatalogueKind = (typeof ALERT_KINDS)[number];

export interface Fix {
  /** A path of the operator shell (OPS_PAGES). */
  route: OpsPage;
  /** The id of the section on that page, lower case and dashes. */
  anchor: string;
}

export interface AlertDescription {
  severity: Severity;
  title: string;
  cause: string;
  fix: Fix;
  runbook: string;
  money_at_risk: MoneyRule | null;
}

type Detail = Record<string, unknown>;
interface Entry {
  severity: Severity;
  title: string;
  /** The reason prefixes this kind may carry; null means any reason is fine. */
  prefixes: readonly string[] | null;
  cause: (reason: string, detail: Detail) => string;
  fix: Fix;
  runbook: string;
  money: MoneyRule | null;
}

const MONEY_ORDERS: Fix = { route: '/ops/money', anchor: 'ops-orders' };
const MONEY_REFUNDS: Fix = { route: '/ops/money', anchor: 'ops-refunds' };
const HOME_ALERTS: Fix = { route: '/ops', anchor: 'ops-alerts' };
const CONTROLS_GATE: Fix = { route: '/ops/controls', anchor: 'ops-gate-section' };
const CONTROLS_SWITCHES: Fix = { route: '/ops/controls', anchor: 'ops-switches' };

const ENTRIES: Record<CatalogueKind, Entry> = {
  frozen_order: {
    severity: 'critical',
    title: 'Order frozen',
    prefixes: null,
    cause: () =>
      'PayPal put this payment on hold, so the order cannot finish until the hold is lifted or the order is refunded.',
    fix: MONEY_ORDERS,
    runbook:
      'Open the order, read its PayPal state, and wait for the hold to clear or refund it from the case.',
    money: 'order_total',
  },
  payment_unresolved: {
    severity: 'high',
    title: 'Payment not settled',
    prefixes: null,
    cause: () =>
      'We could not prove whether the buyer was charged: the capture answer was unclear or the read-back did not settle.',
    fix: MONEY_ORDERS,
    runbook:
      'Open the order and let the next read settle it; if it stays unresolved, diagnose the case.',
    money: 'order_total',
  },
  create_rejected: {
    severity: 'medium',
    title: 'Order refused by PayPal',
    prefixes: null,
    cause: () =>
      'PayPal refused to create the order, so nothing was charged and the buyer was told to try again.',
    fix: MONEY_ORDERS,
    runbook:
      'Check the seller payee and the amount on the order; no money moved, so acknowledge when understood.',
    money: null,
  },
  content_unavailable: {
    severity: 'medium',
    title: 'Content missing after payment',
    prefixes: null,
    cause: () => 'The buyer paid but the article bytes could not be read, so delivery is blocked.',
    fix: MONEY_ORDERS,
    runbook:
      'Restore the content from the seller, then restore the case; refund the buyer if it cannot be fixed.',
    money: 'unit_amount',
  },
  unexpected_capture: {
    severity: 'high',
    title: 'Capture we did not expect',
    prefixes: null,
    cause: () =>
      'PayPal reports a capture that does not match what we asked for, so the sale cannot be booked as is.',
    fix: MONEY_ORDERS,
    runbook:
      'Compare the capture with the order, then refund or accept it by hand; do not book it twice.',
    money: 'unit_amount',
  },
  fee_above_amount: {
    severity: 'medium',
    title: 'Fee above the price',
    prefixes: null,
    cause: () => 'The fee on an offer is higher than its price, so a sale would lose money.',
    fix: { route: '/ops/sellers', anchor: 'ops-shared-payee' },
    runbook: 'Ask the seller to change the price or the fee setting before the offer sells.',
    money: null,
  },
  reversal: {
    severity: 'critical',
    title: 'Payment reversed',
    prefixes: null,
    cause: () =>
      'PayPal took the money back from this sale (a reversal or a dispute), so access is withdrawn.',
    fix: MONEY_ORDERS,
    runbook:
      'Open the case, read the reversal, and decide with the seller; the ledger already shows the reversal.',
    money: 'unit_amount',
  },
  reversal_hint: {
    severity: 'info',
    title: 'Reversal hinted',
    prefixes: null,
    cause: () =>
      'A webhook said the capture was reversed, but a read has not shown it yet, so nothing changed.',
    fix: MONEY_ORDERS,
    runbook: 'Wait for the next read of the order; act only if a reversal alert follows.',
    money: null,
  },
  partial_composite: {
    severity: 'medium',
    title: 'Pack partly paid',
    prefixes: null,
    cause: () =>
      'A pack ended paid in part: at least one of its PayPal orders was declined, failed or abandoned.',
    fix: MONEY_ORDERS,
    runbook:
      'Open the order and check which parts were charged; the buyer has been told which parts failed.',
    money: 'order_total',
  },
  refund_unbooked: {
    severity: 'high',
    title: 'Refund not booked',
    prefixes: null,
    cause: () =>
      'PayPal shows a refund that our ledger did not book, or more refunds than the sale allows.',
    fix: MONEY_REFUNDS,
    runbook:
      'Compare PayPal and the ledger for the unit, book what is missing by hand, and never refund twice.',
    money: 'refund_amount',
  },
  refund_failed: {
    severity: 'high',
    title: 'Refund failed',
    prefixes: null,
    cause: () =>
      'PayPal did not complete this refund (it failed, was cancelled or was never sent).',
    fix: MONEY_REFUNDS,
    runbook:
      'Open the refund and try again once the reason is clear; the alert clears when a later refund is booked.',
    money: 'refund_amount',
  },
  refund_unresolved: {
    severity: 'critical',
    title: 'Refund needs a person',
    prefixes: ['refund_outcome_unknown_', 'cannot_book_', 'ledger_rule_', 'listed_refund_on_'],
    cause: (reason) => {
      if (reason.startsWith('refund_outcome_unknown_'))
        return 'We sent the refund but could not learn whether PayPal completed it; it clears when the refund is completed and booked.';
      if (reason.startsWith('cannot_book_'))
        return 'PayPal paid the refund out but the ledger could not book it, so the books and PayPal disagree.';
      if (reason.startsWith('ledger_rule_'))
        return 'PayPal paid the refund out but a ledger rule refused the booking, so the books and PayPal disagree.';
      return 'A refund was listed by PayPal on a unit that is not in a refundable state.';
    },
    fix: MONEY_REFUNDS,
    runbook:
      'Read the refund in PayPal and the ledger side by side, book it by hand, then resolve this alert.',
    money: 'refund_amount',
  },
  mandate_near_cap: {
    severity: 'info',
    title: 'Agent cap nearly used',
    prefixes: ['cap90_'],
    cause: () => 'An agent spending cap has used 90 percent of its money or its purchases.',
    fix: HOME_ALERTS,
    runbook:
      'Tell the buyer, or leave it: the cap stops further purchases by itself when it is used up.',
    money: null,
  },
  webhook_failing: {
    severity: 'medium',
    title: 'Webhook delivery failing',
    prefixes: ['webhook_failing_'],
    cause: () =>
      'The last three deliveries to one webhook subscription failed, so its owner is not getting events.',
    fix: HOME_ALERTS,
    runbook:
      'Ask the owner to check their receiving address; the alert clears when a delivery goes through.',
    money: null,
  },
};

export function describeAlert(
  kind: string,
  reason: string,
  detail: Detail = {},
): AlertDescription | null {
  if (!(kind in ENTRIES)) return null;
  const e = ENTRIES[kind as CatalogueKind];
  if (e.prefixes !== null && !e.prefixes.some((p) => reason.startsWith(p))) return null;
  return {
    severity: e.severity,
    title: e.title,
    cause: e.cause(reason, detail),
    fix: e.fix,
    runbook: e.runbook,
    money_at_risk: e.money,
  };
}

/** The severity of a kind, or null when the kind is not in the catalogue. */
export const severityOf = (kind: string): Severity | null =>
  kind in ENTRIES ? ENTRIES[kind as CatalogueKind].severity : null;

/** The kinds of one severity, for a filter. */
export const kindsOf = (severity: Severity): CatalogueKind[] =>
  ALERT_KINDS.filter((k) => ENTRIES[k].severity === severity);

const GATE: Record<BlockedBy, Omit<AlertDescription, 'money_at_risk'>> = {
  connect_off: {
    severity: 'info',
    title: 'PayPal connection is off',
    cause: 'The connect flag is off, so no request leaves for PayPal.',
    fix: CONTROLS_GATE,
    runbook:
      'Turn the connect flag on in the host settings only when a sandbox sitting is planned.',
  },
  kill_switch: {
    severity: 'high',
    title: 'Kill switch is off',
    cause: 'The outbound kill switch is off, so every PayPal call is answered blocked.',
    fix: CONTROLS_SWITCHES,
    runbook: 'Turn the switch on again when the cause is understood.',
  },
  no_approval: {
    severity: 'medium',
    title: 'No active approval',
    cause: 'There is no active outbound approval for this scope, so PayPal calls are blocked.',
    fix: CONTROLS_GATE,
    runbook: 'The owner records an approval on a terminal; nothing here can do it.',
  },
  budget: {
    severity: 'medium',
    title: 'Call budget used up',
    cause: 'The approval allows no more calls or money today, so further calls are blocked.',
    fix: CONTROLS_GATE,
    runbook: 'Wait for the next window or ask the owner for a new approval.',
  },
  egress: {
    severity: 'high',
    title: 'Network egress blocked',
    cause: 'The network rules refuse the PayPal address, so no call can leave.',
    fix: CONTROLS_GATE,
    runbook: 'Check the host network settings; this is an owner action.',
  },
};

export function describeGate(reason: string): AlertDescription | null {
  if (!(BLOCKED_BY as readonly string[]).includes(reason)) return null;
  return { ...GATE[reason as BlockedBy], money_at_risk: null };
}
