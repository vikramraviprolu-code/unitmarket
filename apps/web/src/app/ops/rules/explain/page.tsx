import { notFound, redirect } from 'next/navigation';
import type { Metadata } from 'next';
import Link from 'next/link';
import { currentActor } from '../../../../server/session';
import { readExplain } from '../../../../composition/ops-rules';
import { PageHeader, Section } from '../../../../ui/publisher/kit';
import {
  COL_SOURCE,
  COL_TERM,
  COL_VALUE,
  DIGEST_LABEL,
  EXPLAIN_BLANK,
  EXPLAIN_BUTTON,
  EXPLAIN_FIELD,
  EXPLAIN_HEADING,
  EXPLAIN_UNREADABLE,
  RULES_BACK_LINK,
  RULES_VERSION_LABEL,
  daysText,
} from '../../../../lib/ops-rules-copy';
import '../../pk-opshome.css';
import '../../../tables.css';
import '../../../publisher/pk-sales.css';

export const metadata: Metadata = { title: EXPLAIN_HEADING };

// BR-6: why one order has the terms it has. The order id comes from the address; the read checks it with IdSchema
// before any query and answers "refused" for any other shape or an unknown order, which this page turns into a 404.
// The terms are the ones frozen in the approval snapshot: value and source for each rule, the rules version and
// the digest. An order approved before BR-3 has none and says so.
export default async function OpsRulesExplain({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const actor = await currentActor();
  if (actor?.kind !== 'operator') redirect('/signin?next=/ops/rules/explain');
  const { order } = await searchParams;
  const read = await readExplain(actor, order);
  if (read === null) redirect('/signin?next=/ops/rules/explain');
  if (read.kind === 'refused') notFound();
  return (
    <>
      <PageHeader title={EXPLAIN_HEADING} />
      <p>
        <Link href="/ops/rules">{RULES_BACK_LINK}</Link>
      </p>
      <Section title={EXPLAIN_HEADING} id="rules-explain">
        <form method="get" action="/ops/rules/explain" aria-label="Choose an order">
          <div className="field">
            <label htmlFor="rx-order">{EXPLAIN_FIELD}</label>
            <input
              id="rx-order"
              name="order"
              type="text"
              maxLength={200}
              defaultValue={read.kind === 'blank' ? '' : read.order_id}
            />
          </div>
          <div className="actions">
            <button type="submit" className="btn">
              {EXPLAIN_BUTTON}
            </button>
          </div>
        </form>
        {read.kind === 'blank' ? <p className="muted">{EXPLAIN_BLANK}</p> : null}
        {read.kind === 'old' ? (
          <p role="status" data-testid="explain-old">
            {read.line}
          </p>
        ) : null}
        {read.kind === 'unreadable' ? <p role="alert">{EXPLAIN_UNREADABLE}</p> : null}
        {read.kind === 'terms' ? (
          <>
            <table className="pk-table" data-testid="explain-table">
              <caption className="visually-hidden">Terms this order was approved under</caption>
              <thead>
                <tr>
                  <th scope="col">{COL_TERM}</th>
                  <th scope="col">{COL_VALUE}</th>
                  <th scope="col">{COL_SOURCE}</th>
                </tr>
              </thead>
              <tbody>
                {read.rows.map((r) => (
                  <tr key={r.key} data-testid="explain-row">
                    <td data-label={COL_TERM}>{r.label}</td>
                    <td data-label={COL_VALUE}>{daysText(r.value)}</td>
                    <td data-label={COL_SOURCE}>{r.source}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="muted" data-testid="explain-facts">
              {RULES_VERSION_LABEL}: {read.rules_version}. {DIGEST_LABEL}:{' '}
              <span className="mono">{read.digest}</span>
            </p>
          </>
        ) : null}
      </Section>
    </>
  );
}
