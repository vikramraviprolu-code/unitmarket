import { notFound, redirect } from 'next/navigation';
import type { Metadata } from 'next';
import { app } from '../../../server/access';
import { currentActor } from '../../../server/session';
import { EnvLabel } from '../../../ui/EnvLabel';
import { optionLabel, formatMinor, formatDateTime } from '../../../lib/format';

export const metadata: Metadata = { title: 'Receipt' };

export default async function ReceiptPage({ params }: { params: Promise<{ order: string }> }) {
  const { order } = await params;
  const actor = await currentActor();
  if (actor?.kind !== 'buyer') redirect(`/signin?next=${encodeURIComponent(`/receipts/${order}`)}`);
  const r = await (await app()).engine.buyerReceipt({ order_id: order, actor });
  if (r === null) notFound();
  const cur = r.snapshot.currency;
  return (
    <>
      <h1>
        Receipt <EnvLabel environment={r.environment} />
      </h1>
      <p className="muted" data-testid="receipt-version">
        Version {r.version}, issued {formatDateTime(r.created_at)}
      </p>
      <table>
        <caption className="visually-hidden">Items on this receipt</caption>
        <thead>
          <tr>
            <th scope="col">Article</th>
            <th scope="col">Publisher</th>
            <th scope="col">Access</th>
            <th scope="col">Amount</th>
          </tr>
        </thead>
        <tbody>
          {r.lines.map((l) => (
            <tr key={l.article_id} data-testid="receipt-line">
              <td>{l.title}</td>
              <td>{l.publisher}</td>
              <td>
                {optionLabel(l.option)}
                {l.window.ends_at ? `, until ${formatDateTime(l.window.ends_at)}` : ''}
              </td>
              <td>{formatMinor(l.amount_minor, cur)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p>
        Total: <strong>{formatMinor(r.snapshot.total_minor, cur)}</strong>
      </p>
      {r.refunds.length > 0 ? (
        <section aria-labelledby="receipt-refunds-heading">
          <h2 id="receipt-refunds-heading">Refunds</h2>
          <ul data-testid="receipt-refunds">
            {r.refunds.map((f) => (
              <li key={f.refund_id} data-testid="receipt-refund">
                Refund {formatMinor(f.amount.minor, f.amount.currency)} on {formatDateTime(f.at)}
              </li>
            ))}
          </ul>
          <p>
            Refunded in total:{' '}
            <strong data-testid="receipt-refunded-total">
              {formatMinor(
                r.refunds.reduce((n, f) => n + f.amount.minor, 0),
                cur,
              )}
            </strong>
          </p>
        </section>
      ) : null}
      <h2>Fingerprint</h2>
      <p className="muted">
        SHA-256 of this receipt. Keep it to prove the receipt was not changed.
      </p>
      <p className="mono" data-testid="receipt-sha256">
        {r.sha256}
      </p>
    </>
  );
}
