// MC2-L6 (D-083): the words and the pure view of a capture PayPal holds for the seller to accept. Pure:
// no server module, no clock. The engine maps a stored PayPal reason to a closed kind (domain/payments);
// everything here takes the kind, never the reason, so a raw reason cannot reach a screen. The seller is
// shown two choices and no action is taken for them: UnitMarket never converts money for the seller
// and never penalises the buyer. Wording rules: D-051, plain words, no italics, no dashes.
import type { EnvironmentLabel } from '@umsbx/contracts';
import { formatMinor } from './format';

export type PendingKind = 'awaiting_seller_acceptance' | 'payment_pending';

export const AWAITING_SELLER_LABEL = 'Awaiting seller acceptance';
const GENERIC_PENDING = 'Payment pending at PayPal';

/** The buyer's words on the order page and in the library. Access stays locked until the capture completes. */
export const AWAITING_SELLER_BUYER_TEXT = `${AWAITING_SELLER_LABEL}. You have not lost money. Access unlocks when the seller accepts the payment, or PayPal returns it to you.`;

/** One item of a pack, beside the lock. */
export const AWAITING_SELLER_LINE = `${AWAITING_SELLER_LABEL}. Not unlocked yet`;

export const pendingBuyerText = (kind: PendingKind): string =>
  kind === 'awaiting_seller_acceptance' ? AWAITING_SELLER_BUYER_TEXT : GENERIC_PENDING;

/** The pack item line for a kind, or null when the generic line applies. */
export const pendingItemLine = (kind: PendingKind): string | null =>
  kind === 'awaiting_seller_acceptance' ? AWAITING_SELLER_LINE : null;

// The seller console.
export const PENDING_HEADING = 'Payments waiting at PayPal';
export const PENDING_LEDE =
  'These payments are pending at PayPal. They are not counted in your totals until PayPal completes them.';
export const PENDING_COLUMNS = {
  date: 'Date',
  order: 'Order',
  amount: 'Amount',
  reason: 'Why it is pending',
} as const;

const PANEL_HEADING = 'Payments awaiting your acceptance';
const PANEL_INTRO =
  'PayPal is holding these payments because your PayPal account is set to accept them by hand. The buyer has not lost money. UnitMarket cannot change this PayPal setting for you.';
const WAIT_TITLE = 'Wait';
const WAIT_BODY =
  'Open your PayPal account and accept the pending payment. The sale then completes and the buyer gets access. If the payment is not accepted, PayPal returns it to the buyer.';
const OTHER_TITLE = 'List an offer in another currency';
const OTHER_BODY =
  'List a new offer in a currency your PayPal account accepts. Payments already pending stay as they are.';
const OTHER_LINK = 'Start a new offer';
const PANEL_CLOSING =
  'UnitMarket does not convert money for you and does nothing until you choose.';

/** The existing new offer page. */
export const NEW_OFFER_HREF = '/publisher/offers/new';

/** The operator's exposure line (one row per currency block). */
export const COL_AWAITING = AWAITING_SELLER_LABEL;

/** One pending unit of the signed-in seller. No buyer is named. */
export interface PendingUnitRow {
  /** captured_verified_at, else created_at (UTC, ISO). */
  at: string;
  /** The last 6 characters of the order reference. */
  order_ref6: string;
  amount_minor: number;
  currency: string;
  environment: EnvironmentLabel;
  kind: PendingKind;
  /** One of the closed labels; never a stored reason. */
  label: string;
}

export interface PendingGroup {
  currency: string;
  environment: EnvironmentLabel;
  count: number;
  minor: number;
  text: string;
}

export interface PendingChoice {
  id: 'wait' | 'other_currency';
  title: string;
  body: string;
  href: string | null;
  link_text: string | null;
}

export interface PendingPanel {
  heading: string;
  intro: string;
  /** How many listed units await acceptance. */
  awaiting_count: number;
  choices: [PendingChoice, PendingChoice];
  closing: string;
}

export interface PendingSellerView {
  groups: PendingGroup[];
  rows: PendingUnitRow[];
  panel: PendingPanel | null;
}

const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

export const groupText = (count: number, amount: string): string =>
  `${String(count)} ${count === 1 ? 'payment' : 'payments'}, ${amount}`;

/** The pending units of a seller, counted and summed per currency and stored environment, and the panel. */
export function pendingSellerView(rows: readonly PendingUnitRow[]): PendingSellerView {
  const byKey = new Map<string, PendingGroup>();
  for (const r of rows) {
    const key = `${r.currency}\u0000${r.environment}`;
    const g = byKey.get(key) ?? {
      currency: r.currency,
      environment: r.environment,
      count: 0,
      minor: 0,
      text: '',
    };
    g.count += 1;
    g.minor += r.amount_minor;
    byKey.set(key, g);
  }
  const groups = [...byKey.values()]
    .sort((a, b) => cmp(a.currency, b.currency) || cmp(a.environment, b.environment))
    .map((g) => ({ ...g, text: groupText(g.count, formatMinor(g.minor, g.currency)) }));
  const awaiting = rows.filter((r) => r.kind === 'awaiting_seller_acceptance').length;
  const panel: PendingPanel | null =
    awaiting === 0
      ? null
      : {
          heading: PANEL_HEADING,
          intro: PANEL_INTRO,
          awaiting_count: awaiting,
          choices: [
            { id: 'wait', title: WAIT_TITLE, body: WAIT_BODY, href: null, link_text: null },
            {
              id: 'other_currency',
              title: OTHER_TITLE,
              body: OTHER_BODY,
              href: NEW_OFFER_HREF,
              link_text: OTHER_LINK,
            },
          ],
          closing: PANEL_CLOSING,
        };
  return { groups, rows: [...rows], panel };
}
