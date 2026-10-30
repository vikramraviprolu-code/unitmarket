import { redirect } from 'next/navigation';
import type { Metadata } from 'next';
import Link from 'next/link';
import { app } from '../../../server/access';
import { currentActor } from '../../../server/session';
import { EnvLabel, envText } from '../../../ui/EnvLabel';
import { formatMinor } from '../../../lib/format';
import {
  APPLIED_HINT,
  COL_CAPTURED,
  COL_CURRENCY,
  COL_HELD,
  COL_NOT_REFUNDED,
  COL_REFUNDS_OPEN,
  LABEL_MONEY,
  LABEL_OFFERS,
  LABEL_PAYEE,
  LABEL_STATUS,
  NONE_CELL,
  NO_PAYMENTS,
  OPS_LINK_PAYEE_REQUESTS,
  PUBLISHERS_BACK_LINK,
  PUBLISHERS_EMPTY,
  PUBLISHERS_HEADING,
  PUBLISHERS_LEDE,
  REACTIVATE_HINT,
  SUSPEND_HINT,
  countAmountText,
  offersText,
  payeeText,
  statusText,
  unitsText,
} from '../../../lib/ops-publishers-copy';
import { StatusForm } from './StatusForm';

export const metadata: Metadata = { title: 'Publishers' };

// PUB-D (S7): the operator's table of publishers. Operator with the second factor only; the engine
// answers an error to any other session. It shows counts and sums of stored rows and the last 4 of the
// payee account; it names no buyer. The suspend form posts to the route, which checks everything again.
export default async function OpsPublishers() {
  const actor = await currentActor();
  if (actor?.kind !== 'operator') redirect('/signin?next=/ops/publishers');
  const r = await (await app()).engine.opsPublishers.list(actor);
  if (!r.ok) redirect('/signin?next=/ops/publishers');
  const { publishers, environment } = r.value;
  return (
    <>
      <h1>
        {PUBLISHERS_HEADING} <EnvLabel environment={environment} />
      </h1>
      <p className="lede">{PUBLISHERS_LEDE}</p>
      <p>
        <Link href="/ops/payee-requests">{OPS_LINK_PAYEE_REQUESTS}</Link>
      </p>
      {publishers.length === 0 ? (
        <p className="muted" data-testid="publishers-empty">
          {PUBLISHERS_EMPTY}
        </p>
      ) : (
        publishers.map((p) => (
          <section
            key={p.publisher_id}
            className="card"
            aria-labelledby={`pub-${p.publisher_id}`}
            data-testid="publisher-row"
          >
            <h2 id={`pub-${p.publisher_id}`}>{p.display_name}</h2>
            <dl>
              <dt>{LABEL_STATUS}</dt>
              <dd data-testid="publisher-row-status">{statusText(p.status)}</dd>
              <dt>{LABEL_PAYEE}</dt>
              <dd>
                {payeeText({
                  last4: p.payee_last4,
                  verified: p.payee_verified_at !== null,
                  shared: p.payee_shared,
                })}
              </dd>
              <dt>{LABEL_OFFERS}</dt>
              <dd>{offersText(p.offers_live)}</dd>
            </dl>
            <h3>{LABEL_MONEY}</h3>
            {p.by_currency.length === 0 ? (
              <p className="muted">{NO_PAYMENTS}</p>
            ) : (
              <div
                className="table-scroll"
                role="region"
                aria-label={`${LABEL_MONEY}: ${p.display_name}`}
                tabIndex={0}
              >
                <table>
                  <caption className="visually-hidden">
                    {LABEL_MONEY}: {p.display_name}
                  </caption>
                  <thead>
                    <tr>
                      <th scope="col">{COL_CURRENCY}</th>
                      <th scope="col">{COL_CAPTURED}</th>
                      <th scope="col">{COL_NOT_REFUNDED}</th>
                      <th scope="col">{COL_REFUNDS_OPEN}</th>
                      <th scope="col">{COL_HELD}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {p.by_currency.map((b) => (
                      <tr key={`${b.currency}-${b.environment}`} data-testid="exposure-row">
                        <th scope="row">
                          {b.currency} ({envText(b.environment)})
                        </th>
                        <td>{unitsText(b.units_captured)}</td>
                        <td>{formatMinor(b.captured_not_refunded_minor, b.currency)}</td>
                        <td>
                          {b.refunds_open_count === 0
                            ? NONE_CELL
                            : countAmountText(
                                b.refunds_open_count,
                                formatMinor(b.refunds_open_minor, b.currency),
                              )}
                        </td>
                        <td>
                          {b.held_count === 0
                            ? NONE_CELL
                            : countAmountText(b.held_count, formatMinor(b.held_minor, b.currency))}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            {p.status === 'applied' ? (
              <p className="muted">{APPLIED_HINT}</p>
            ) : (
              <>
                <p className="muted">{p.status === 'suspended' ? REACTIVATE_HINT : SUSPEND_HINT}</p>
                <StatusForm
                  publisherId={p.publisher_id}
                  name={p.display_name}
                  suspended={p.status === 'suspended'}
                />
              </>
            )}
          </section>
        ))
      )}
      <p>
        <Link href="/ops">{PUBLISHERS_BACK_LINK}</Link>
      </p>
    </>
  );
}
