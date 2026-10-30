// Demo prices (PUB-B, D-065 item 37): PayPal's fixed fee can exceed a 0.40 sale, so every USD offer on sale
// is priced from 1.00 to 2.50 USD in the demo. This is NOT a seed edit: it is one audited offer revision
// per offer, made as the offer's own publisher, so the history shows what the price was and when it moved.
//
// Rules, all idempotent:
//   - only offers that are authorised, current, USD and have never been revised (a single version row)
//     and carry an option price below 100 or above 250 minor units are touched;
//   - each price is clamped into 100 to 250 (40 becomes 100, 300 and 450 become 250, 90 becomes 100);
//     120, 125, 150 and 200 stay and so do GBP offers, withdrawn offers and drafts;
//   - an offer a publisher has already revised is never touched again, so a later boot cannot undo a
//     price the publisher chose. A second run revises nothing.
// On a database that already holds the seed (the hosted one) the first boot after the deploy writes the
// new versions; later boots find nothing to do.
import type { AccessOption } from '@umsbx/contracts';
import { reviseWithMark } from './write';
import type { OfferWriteDeps } from './write';

export const DEMO_MIN_MINOR = 100;
export const DEMO_MAX_MINOR = 250;
export const DEMO_AUDIT_REASON = 'seed: demo prices (decision 37)';
/** The authorisation row of a demo revision records this instead of the publisher attestation text. */
export const DEMO_ATTESTATION = 'SEED-DEMO-PRICES-37';

export interface DemoRevision {
  offer_id: string;
  version: string;
  from: { option: AccessOption; price_minor: number }[];
  to: { option: AccessOption; price_minor: number }[];
}

interface Candidate {
  id: string;
  version: string;
  publisher_id: string;
  options: unknown;
}

export async function applyDemoPrices(deps: OfferWriteDeps): Promise<DemoRevision[]> {
  const { rows } = await deps.db.query<Candidate>(
    `SELECT o.id, o.version, o.publisher_id, o.options
       FROM offers o
      WHERE o.currency = 'USD' AND o.status = 'authorised' AND o.superseded_by IS NULL
        AND (SELECT count(*) FROM offers x WHERE x.id = o.id) = 1
        AND EXISTS (SELECT 1 FROM publisher_authorisations pa
                     WHERE pa.offer_id = o.id AND pa.offer_version = o.version)
      ORDER BY o.id`,
  );
  const done: DemoRevision[] = [];
  for (const c of rows) {
    const stored = (typeof c.options === 'string' ? JSON.parse(c.options) : c.options) as {
      option: AccessOption;
      price_minor: number;
    }[];
    const from = stored.map((o) => ({ option: o.option, price_minor: o.price_minor }));
    if (!from.some((o) => o.price_minor < DEMO_MIN_MINOR || o.price_minor > DEMO_MAX_MINOR))
      continue;
    const to = from.map((o) => ({
      option: o.option,
      price_minor: Math.min(DEMO_MAX_MINOR, Math.max(DEMO_MIN_MINOR, o.price_minor)),
    }));
    const r = await reviseWithMark(
      deps,
      { kind: 'publisher', publisher_id: c.publisher_id },
      { offer_id: c.id, expected_version: c.version, options: to, attestation: true },
      { attestation_version: DEMO_ATTESTATION, reason: DEMO_AUDIT_REASON },
    );
    // A refusal (another boot got there first, a lower cap, a suspended publisher) is not an error here:
    // the step is a convenience for the demo and must never stop the app from starting.
    if (r.ok) done.push({ offer_id: c.id, version: r.value.version, from, to });
  }
  return done;
}
