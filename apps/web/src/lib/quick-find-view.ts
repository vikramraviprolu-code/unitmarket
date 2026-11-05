// INT-OPS-B / OPS-B.3: the logic of quick-find. Pure. The operator shell sends the typed text to
// GET /api/ops/find (SR1) and this file words the answer: five groups in a fixed order, Buyers only with MFA,
// and the first Orders hit as the target of Enter ("/" and Enter are the two actions). It never logs, stores
// or sends the text anywhere but that one request, and it never invents a name the route left out.
import { formatMinor } from './format';
import { readableKey } from './timeline-view';
import type { ShellPersona } from './shell-tabs';

export const FIND_PATH = '/api/ops/find';
export const MIN_FIND_CHARS = 2;
const MAX_FIND_CHARS = 100;
const CONTROL = /\p{Cc}/u;

export const FIND_GROUP_ORDER = ['orders', 'sellers', 'offers', 'keys', 'buyers'] as const;
export type FindGroupId = (typeof FIND_GROUP_ORDER)[number];
const GROUP_LABEL: Readonly<Record<FindGroupId, string>> = {
  orders: 'Orders',
  sellers: 'Sellers',
  offers: 'Offers',
  keys: 'Keys',
  buyers: 'Buyers',
};

/** SR1's answer (GET /api/ops/find). The buyers group is present only for a session with MFA. */
export interface FindAnswer {
  orders: {
    order_ref: string;
    order_ref6: string;
    matched: string;
    status: string;
    currency: string;
    total_minor: number;
    environment: string;
    created_at: string;
  }[];
  sellers: { publisher_id: string; slug: string; display_name?: string }[];
  offers: { offer_id: string; title: string; publisher_id: string }[];
  keys: { key_id: string; owner_kind: string; key_kind: string }[];
  buyers?: { buyer_id: string; display_name: string }[];
}

/** Only the operator shell has quick-find (B6). */
export const showsQuickFind = (persona: ShellPersona): boolean => persona === 'operator';

/** The request for some text, or null when there is too little or too much to look for. */
export function findUrl(text: string): string | null {
  const q = text.trim();
  if (q.length < MIN_FIND_CHARS || q.length > MAX_FIND_CHARS || CONTROL.test(q)) return null;
  return `${FIND_PATH}?q=${encodeURIComponent(q)}`;
}

export interface FindItem {
  key: string;
  label: string;
  detail: string;
  href: string;
}
export interface FindGroup {
  id: FindGroupId;
  label: string;
  items: FindItem[];
}
export interface QuickFindView {
  groups: FindGroup[];
  empty: boolean;
  emptyText: string;
  firstOrderHref: string | null;
}

const MATCHED_WORDS: Readonly<Record<string, string>> = {
  order_ref: 'order ref',
  order_ref6: 'last six of the ref',
  provider_order_id: 'PayPal order id',
  capture_id: 'capture id',
  refund_id: 'refund id',
  receipt_id: 'receipt id',
};

export function quickFindView(answer: FindAnswer, o: { mfa: boolean }): QuickFindView {
  const sellerHref = (id: string): string => `/ops/sellers/${encodeURIComponent(id)}`;
  const groups: FindGroup[] = [];
  const add = (id: FindGroupId, items: FindItem[]): void => {
    if (items.length > 0) groups.push({ id, label: GROUP_LABEL[id], items });
  };
  add(
    'orders',
    answer.orders.map((r) => ({
      key: `${r.order_ref}:${r.matched}`,
      label: r.order_ref,
      detail: `${readableKey(r.status)}, ${formatMinor(r.total_minor, r.currency)}, matched ${MATCHED_WORDS[r.matched] ?? r.matched}`,
      href: `/ops/money/orders/${encodeURIComponent(r.order_ref)}`,
    })),
  );
  add(
    'sellers',
    answer.sellers.map((s) => ({
      key: s.publisher_id,
      label: s.display_name ?? s.slug,
      detail: s.display_name === undefined ? s.publisher_id : `${s.slug}, ${s.publisher_id}`,
      href: sellerHref(s.publisher_id),
    })),
  );
  add(
    'offers',
    answer.offers.map((r) => ({
      key: r.offer_id,
      label: r.title,
      detail: r.offer_id,
      href: sellerHref(r.publisher_id),
    })),
  );
  add(
    'keys',
    answer.keys.map((k) => ({
      key: k.key_id,
      label: k.key_id,
      detail: `${k.owner_kind} ${k.key_kind}`,
      href: '/ops/agents',
    })),
  );
  if (o.mfa)
    add(
      'buyers',
      (answer.buyers ?? []).map((b) => ({
        key: b.buyer_id,
        label: b.display_name,
        detail: b.buyer_id,
        href: `/ops/buyers/${encodeURIComponent(b.buyer_id)}`,
      })),
    );
  const orders = groups.find((g) => g.id === 'orders');
  return {
    groups,
    empty: groups.length === 0,
    emptyText: 'Nothing found. Try an order ref, a seller name, an offer title or a key id.',
    firstOrderHref: orders?.items[0]?.href ?? null,
  };
}
