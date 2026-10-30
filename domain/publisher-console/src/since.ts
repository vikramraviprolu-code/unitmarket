// "Since your last visit" for a publisher (PUB-E1): counts of stored rows newer than an instant. The
// instant comes from the visit cursor (domain/catalogue touchVisit); this module only reads. The publisher
// id is the actor's. Every count is a count of stored rows of that publisher: nothing is projected.
import type { Actor, SqlExecutor } from '@umsbx/contracts';
import type { PublisherActor } from './sales';

export interface SinceCounts {
  /** The instant the counts start from (exclusive), as given. */
  since: string;
  /** Ledger sale rows of the publisher's units. */
  new_sales: number;
  /** Ledger refund rows of the publisher's units. */
  refunds: number;
  /** Operator actions on the publisher or on its offers (audit rows). */
  operator_offer_changes: number;
  /** Operator answers to the publisher's payee change requests. */
  payee_decisions: number;
}

export async function countsSince(
  db: SqlExecutor,
  actor: PublisherActor,
  since: string,
): Promise<SinceCounts | null> {
  if ((actor as Actor).kind !== 'publisher') return null;
  const r = await db.query<{
    s: string | number;
    f: string | number;
    o: string | number;
    p: string | number;
  }>(
    `SELECT
       (SELECT count(*) FROM ledger_entries l JOIN order_units u ON u.id = l.unit_id
         WHERE u.publisher_id = $1 AND l.kind = 'sale' AND l.created_at > $2::timestamptz) AS s,
       (SELECT count(*) FROM ledger_entries l JOIN order_units u ON u.id = l.unit_id
         WHERE u.publisher_id = $1 AND l.kind = 'refund' AND l.created_at > $2::timestamptz) AS f,
       (SELECT count(*) FROM audit_log a
         WHERE a.actor_kind = 'operator' AND a.created_at > $2::timestamptz
           AND ((a.action LIKE 'publisher.%' AND a.target = $1)
             OR (a.action LIKE 'offer.%'
                 AND a.target IN (SELECT o.id FROM offers o WHERE o.publisher_id = $1)))) AS o,
       (SELECT count(*) FROM payee_decisions d JOIN payee_change_requests q ON q.id = d.request_id
         WHERE q.publisher_id = $1 AND d.created_at > $2::timestamptz) AS p`,
    [actor.publisher_id, since],
  );
  const row = r.rows[0];
  return {
    since,
    new_sales: Number(row?.s ?? 0),
    refunds: Number(row?.f ?? 0),
    operator_offer_changes: Number(row?.o ?? 0),
    payee_decisions: Number(row?.p ?? 0),
  };
}
