// What a buyer is shown of a receipt (UX-1A addendum, items 45 and 54). The stored receipt is hashed and
// stays as it is. This view adds the article title and the publisher name to each line, and leaves out
// every merchant id: a buyer has no use for the payee account. Pure; the engine supplies the names.
import type { ApprovalSnapshot, Receipt, ReceiptLine, SnapshotItem } from '@umsbx/contracts';

/** What the page says when the catalogue no longer has the article. Never the id. */
export const BUYER_RECEIPT_FALLBACK = { title: 'Article', publisher: 'Publisher' } as const;

export interface ArticleFacts {
  title: string;
  publisher: string;
}

export interface BuyerReceiptLine extends ReceiptLine {
  title: string;
  publisher: string;
}

export interface BuyerSnapshot extends Omit<ApprovalSnapshot, 'items' | 'publishers'> {
  items: Omit<SnapshotItem, 'payee_merchant_id'>[];
  publishers: { publisher_id: string; amount_minor: number; platform_fee_minor: 0 }[];
}

export interface BuyerReceipt extends Omit<Receipt, 'lines' | 'snapshot'> {
  snapshot: BuyerSnapshot;
  lines: BuyerReceiptLine[];
}

function withoutPayee(item: SnapshotItem): BuyerSnapshot['items'][number] {
  const copy: Partial<SnapshotItem> = { ...item };
  delete copy.payee_merchant_id;
  return copy as BuyerSnapshot['items'][number];
}

export function toBuyerReceipt(r: Receipt, facts: ReadonlyMap<string, ArticleFacts>): BuyerReceipt {
  const { items, publishers, ...rest } = r.snapshot;
  return {
    ...r,
    snapshot: {
      ...rest,
      items: items.map((item) => withoutPayee(item)),
      publishers: publishers.map((p) => ({
        publisher_id: p.publisher_id,
        amount_minor: p.amount_minor,
        platform_fee_minor: p.platform_fee_minor,
      })),
    },
    lines: r.lines.map((l) => {
      const f = facts.get(l.article_id);
      return {
        ...l,
        title: f?.title ?? BUYER_RECEIPT_FALLBACK.title,
        publisher: f?.publisher ?? l.publisher_display_name ?? BUYER_RECEIPT_FALLBACK.publisher,
      };
    }),
  };
}
