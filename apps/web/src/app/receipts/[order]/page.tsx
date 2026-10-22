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
  const r = await (await app()).engine.receipt({ order_id: order, actor });
  if (r === null) notFound();
  const cur = r.snapshot.currency;
  return (
    <>
      <h1>
        Receipt <EnvLabel environment={r.environment} />
      </h1>
      <p className="muted">
        Version {r.version}, issued {formatDateTime(r.created_at)}
      </p>
      <table>
        <caption className="visually-hidden">Items on this receipt</caption>
        <thead>
          <tr>
            <th scope="col">Item</th>
            <th scope="col">Access</th>
            <th scope="col">Amount</th>
          </tr>
        </thead>
        <tbody>
          {r.lines.map((l) => (
            <tr key={l.article_id}>
              <td className="mono">{l.article_id}</td>
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
        <ul>
          {r.refunds.map((f) => (
            <li key={f.refund_id}>
              Refund {formatMinor(f.amount.minor, f.amount.currency)} on {formatDateTime(f.at)}
            </li>
          ))}
        </ul>
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
