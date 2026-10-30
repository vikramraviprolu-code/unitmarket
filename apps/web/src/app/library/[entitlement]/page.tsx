import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import type { Metadata } from 'next';
import { app } from '../../../server/access';
import { currentActor } from '../../../server/session';
import { WindowMeter } from '../../../ui/WindowMeter';
import { OpenButton } from '../OpenButton';
import { Refresher } from '../../../ui/Refresher';
import { optionLabel, formatDateTime } from '../../../lib/format';
import { READER_LINK_TEXT } from '../../../lib/reader-copy';

export const metadata: Metadata = { title: 'Library item' };

export default async function LibraryItem({
  params,
}: {
  params: Promise<{ entitlement: string }>;
}) {
  const { entitlement } = await params;
  const actor = await currentActor();
  if (actor?.kind !== 'buyer')
    redirect(`/signin?next=${encodeURIComponent(`/library/${entitlement}`)}`);
  const item = await (await app()).engine.libraryItem({ entitlement_id: entitlement, actor });
  if (item === null) notFound();
  return (
    <>
      <p className="muted">{item.publisher}</p>
      <h1>{item.title}</h1>
      <Refresher />
      <p>{optionLabel(item.option)}.</p>
      <p aria-live="polite" aria-atomic="true" data-testid="library-status">
        <strong>{item.status_text}</strong>
      </p>
      {item.refund_note ? <p data-testid="library-refund-note">{item.refund_note}</p> : null}
      {item.refunded ? null : (
        <WindowMeter
          state={item.window.state}
          daysLeft={item.window.days_left}
          endsAt={item.window.ends_at}
          option={item.option}
        />
      )}
      <h2>Evidence</h2>
      <dl>
        <dt>Window started</dt>
        <dd>{item.window.started_at ? formatDateTime(item.window.started_at) : 'Not started'}</dd>
        <dt>Window ends</dt>
        <dd>{item.window.ends_at ? formatDateTime(item.window.ends_at) : 'Not set'}</dd>
        <dt>Payment state</dt>
        <dd>{item.money}</dd>
      </dl>
      <div className="actions">
        {item.can_open ? (
          <OpenButton
            entitlementId={item.entitlement_id}
            mode={item.option === 'keep_retrieve' ? 'download' : 'read'}
          />
        ) : null}
        {item.can_open && item.option === 'online_read' ? (
          <Link
            className="btn"
            prefetch={false}
            href={`/library/${encodeURIComponent(item.entitlement_id)}/read`}
          >
            {READER_LINK_TEXT}
          </Link>
        ) : null}
        {item.order_id ? (
          <Link className="btn" href={`/receipts/${encodeURIComponent(item.order_id)}`}>
            View receipt
          </Link>
        ) : null}
        <Link
          className="btn"
          href={`/help/delivery?item=${encodeURIComponent(item.entitlement_id)}`}
        >
          Problem with this item?
        </Link>
      </div>
    </>
  );
}
