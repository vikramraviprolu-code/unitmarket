// INT-UI0 / UI0.7: the composition module of the buyer tabs. The buyer pages keep their own reads until BUY moves them here.
// INT-TR1 adds the one read below: the buyer timeline of an order, from the journal.
import { app } from '../server/access';

/** The steps of one order for the buyer who owns it. Null for another buyer's order or an unknown one. */
export async function readBuyerTimeline(buyer_id: string, order_ref: string) {
  return (await app()).trace.buyerTimeline({ order_ref, buyer_id });
}
