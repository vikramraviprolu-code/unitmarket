// INT-UI0 / UI0.7: the composition module of the seller tabs. The seller pages keep their own reads until SEL moves them here.
// INT-TR1 adds the one read below: the seller timeline of one unit, from the journal.
import { app } from '../server/access';

/** The steps of one unit for the seller who sold it. Null for another seller's unit or an unknown one. */
export async function readSellerTimeline(publisher_id: string, unit_id: string) {
  return (await app()).trace.sellerTimeline({ unit_id, publisher_id });
}
