// INT-TR1 / TR1.1: the words of the timeline. One sentence for each event type the journal can write
// (`<tracked table>.created`, `.updated`, `.imported`), and a finer sentence for the states and access kinds
// that matter to a reader. The golden test fails for any type without a sentence. Wording rules (D-051): plain
// sentences, no dash, no italics, no id and no amount inside the text (the entry carries those).
import { TRACKED_TABLES } from '@umsbx/contracts';

const OPS = ['created', 'updated', 'imported'] as const;
export const EVENT_TYPES: readonly string[] = TRACKED_TABLES.flatMap((t) =>
  OPS.map((o) => `${t.table}.${o}`),
);

/** What happened to a row of each table, as `[created, updated]`. `imported` is the same for all. */
const BASE: Record<string, readonly [string, string]> = {
  access_events: ['Something happened with the item.', 'A record about the item was corrected.'],
  access_windows: [
    'The access time for the item was set up.',
    'The access time for the item changed.',
  ],
  alerts: ['A check was raised for the team.', 'A check raised for the team changed.'],
  api_keys: ['An API key was created.', 'An API key changed.'],
  approvals: [
    'The buyer was asked to approve the purchase.',
    'The approval of the purchase changed.',
  ],
  audit_log: ['An action was written to the audit log.', 'An audit log entry changed.'],
  entitlements: ['The right to the item was created.', 'The right to the item changed.'],
  ledger_entries: [
    'A money line was written to the ledger.',
    'A money line in the ledger changed.',
  ],
  links: ['A link to the item was made.', 'A link to the item was used or changed.'],
  mandate_reservations: [
    'Part of the agent budget was set aside.',
    'The part of the agent budget set aside changed.',
  ],
  mandates: ['An agent budget was created.', 'An agent budget changed.'],
  offers: ['An offer was created.', 'An offer changed.'],
  operations: ['A step with PayPal was planned.', 'A step with PayPal moved on.'],
  order_units: ['An item was added to the order.', 'An item in the order changed.'],
  orders: ['The order was started.', 'The order changed.'],
  outbound_approvals: [
    'A permission to reach PayPal was recorded.',
    'A permission to reach PayPal changed.',
  ],
  payee_decisions: [
    'A decision on a payee change was recorded.',
    'A decision on a payee change changed.',
  ],
  provider_calls: ['A call to PayPal was recorded.', 'A call to PayPal was updated.'],
  provider_orders: ['A PayPal order was prepared.', 'A PayPal order moved on.'],
  publisher_applicant_decisions: [
    'A decision on a seller application was recorded.',
    'A decision on a seller application changed.',
  ],
  publishers: ['A seller account was created.', 'A seller account changed.'],
  receipts: ['A receipt was written.', 'A receipt changed.'],
  recovery_actions: ['A step was taken on a help case.', 'A step on a help case changed.'],
  recovery_cases: ['A help case was opened.', 'A help case changed.'],
  refund_requests: ['A refund was requested.', 'The refund moved on.'],
  safety_switches: ['A safety switch was set up.', 'A safety switch was changed.'],
  webhook_events: ['PayPal sent a notice.', 'A PayPal notice was handled.'],
};

const IMPORTED = 'This record was added to the history from before the journal began.';

/** Finer sentences, keyed `<event type>:<state or access kind>`. */
const REFINED: Record<string, string> = {
  'orders.updated:awaiting_buyer': 'The order is waiting for the buyer to approve the payment.',
  'orders.updated:capture_requested': 'The payment was requested from PayPal.',
  'orders.updated:capture_claimed': 'The payment request is being handled.',
  'orders.updated:unresolved': 'The payment needs a check before the order can settle.',
  'orders.updated:paid': 'The order was paid.',
  'orders.updated:paid_partial': 'Part of the order was paid.',
  'orders.updated:failed': 'The order failed.',
  'orders.updated:abandoned': 'The order was left unpaid and closed.',
  'orders.updated:frozen': 'The order was frozen for a check.',
  'order_units.updated:captured_verified': 'The payment for this item was taken and checked.',
  'order_units.updated:pending': 'The payment for this item is pending.',
  'order_units.updated:declined': 'The payment for this item was declined.',
  'order_units.updated:mismatch': 'The payment for this item did not match the order.',
  'order_units.updated:partially_refunded': 'Part of the payment for this item was refunded.',
  'order_units.updated:refunded': 'The payment for this item was refunded.',
  'order_units.updated:reversal_suspected': 'A reversal of this payment is suspected.',
  'order_units.updated:reversed': 'The payment for this item was reversed.',
  'refund_requests.updated:completed': 'The refund was completed.',
  'refund_requests.updated:failed': 'The refund failed.',
  'refund_requests.updated:pending': 'The refund is pending.',
  'entitlements.updated:available': 'The item was unlocked.',
  'entitlements.updated:ended': 'The access to the item ended.',
  'entitlements.updated:revoked': 'The access to the item was withdrawn.',
  'access_events.created:access_ready': 'The item is ready to open.',
  'access_events.created:link_issued': 'A link to the item was issued.',
  'access_events.created:download_completed': 'The item was downloaded.',
  'access_events.created:download_aborted': 'A download of the item stopped early.',
  'access_events.created:reader_rendered': 'The item was opened in the reader.',
  'access_events.created:reader_beacon': 'The reader reported that the item is still open.',
  'access_events.created:delivery_failed': 'The delivery of the item failed.',
  'access_events.created:delivery_restored': 'The delivery of the item was restored.',
  'access_events.created:credit_granted': 'Extra access time was granted.',
  'access_events.created:window_ended': 'The access time for the item ended.',
  'access_events.created:revoked': 'The access to the item was withdrawn.',
  'recovery_cases.updated:resolved': 'The help case was resolved.',
  'mandate_reservations.updated:committed': 'The agent budget set aside was spent.',
  'mandate_reservations.updated:released': 'The agent budget set aside was given back.',
};

export const WORDS: Readonly<Record<string, string>> = Object.freeze({
  ...Object.fromEntries(
    Object.entries(BASE).flatMap(([table, [c, u]]) => [
      [`${table}.created`, c],
      [`${table}.updated`, u],
      [`${table}.imported`, IMPORTED],
    ]),
  ),
  ...REFINED,
});

/** The key of the sentence for an event: the finest one that exists, else the base one. Throws if unmapped. */
export function wordsKeyOf(
  event_type: string,
  state_to: string | null | undefined,
  kind: string | null | undefined,
): string {
  if (!EVENT_TYPES.includes(event_type))
    throw new Error(`words: unmapped event type ${event_type}`);
  for (const part of [kind, state_to]) {
    if (part !== null && part !== undefined && Object.hasOwn(WORDS, `${event_type}:${part}`))
      return `${event_type}:${part}`;
  }
  return event_type;
}

export function wordsFor(key: string): string {
  if (!Object.hasOwn(WORDS, key)) throw new Error(`words: unmapped key ${key}`);
  return WORDS[key]!;
}
