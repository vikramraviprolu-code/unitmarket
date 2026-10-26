// Origin: AIC_Hackathon_UnitMarket@a36ddc03fd0b962000f686291c145b50ee337f90:packages/core/ledger/ledger.ts (sums). Adapted; owned by SBX.
// Pure sums over ledger rows (P11: the reconciler compares these with the PayPal read-back).
import type { Id, LedgerEntry } from '@umsbx/contracts';

export interface UnitBalance {
  sold_minor: number;
  refunded_minor: number;
  reversed_minor: number;
  net_minor: number;
}

// Sale, refund and reversal rows only; fee and commission rows never change what the buyer paid
// or got back. The caller passes the rows of one unit (or one capture); currency is one per order
// and is enforced when a row is appended, so this function adds integers and nothing else.
export function unitBalance(entries: LedgerEntry[]): UnitBalance {
  let sold = 0;
  let refunded = 0;
  let reversed = 0;
  for (const e of entries) {
    if (e.kind === 'sale') sold += e.amount.minor;
    else if (e.kind === 'refund') refunded += e.amount.minor;
    else if (e.kind === 'reversal') reversed += e.amount.minor;
  }
  return {
    sold_minor: sold,
    refunded_minor: refunded,
    reversed_minor: reversed,
    net_minor: sold - refunded - reversed,
  };
}

export interface PublisherBalance extends UnitBalance {
  publisher_id: Id;
  currency: string;
}

// The same sums per publisher and currency (MVP-D, P11 per publisher). The caller says whose each
// row is: the publisher of the unit the row belongs to. A publisher with no row has no balance
// here, which reads as 0. Fee rows never change the net, because unitBalance ignores them. The
// result is ordered by publisher id and then currency, so it does not depend on the order of rows.
export function publisherBalances(
  rows: readonly { publisher_id: Id; entry: LedgerEntry }[],
): PublisherBalance[] {
  const groups = new Map<string, { publisher_id: Id; currency: string; entries: LedgerEntry[] }>();
  for (const { publisher_id, entry } of rows) {
    const currency = entry.amount.currency;
    const key = JSON.stringify([publisher_id, currency]);
    const group = groups.get(key) ?? { publisher_id, currency, entries: [] };
    group.entries.push(entry);
    groups.set(key, group);
  }
  return [...groups.values()]
    .sort((a, b) =>
      a.publisher_id !== b.publisher_id
        ? a.publisher_id < b.publisher_id
          ? -1
          : 1
        : a.currency < b.currency
          ? -1
          : a.currency > b.currency
            ? 1
            : 0,
    )
    .map((g) => ({
      publisher_id: g.publisher_id,
      currency: g.currency,
      ...unitBalance(g.entries),
    }));
}
