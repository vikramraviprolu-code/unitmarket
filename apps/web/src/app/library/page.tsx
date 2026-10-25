import Link from 'next/link';
import { redirect } from 'next/navigation';
import type { Metadata } from 'next';
import { app } from '../../server/access';
import { currentActor } from '../../server/session';
import { EmptyState } from '../../ui/EmptyState';
import { WindowMeter } from '../../ui/WindowMeter';
import { OpenButton } from './OpenButton';
import { Refresher } from '../../ui/Refresher';
import { optionLabel } from '../../lib/format';

export const metadata: Metadata = { title: 'My library' };

export default async function Library() {
  const actor = await currentActor();
  if (actor?.kind !== 'buyer') redirect('/signin?next=/library');
  const items = await (await app()).engine.library({ actor });
  return (
    <>
      <h1>My library</h1>
      <Refresher />
      {items.length === 0 ? (
        <EmptyState
          title="Nothing here yet"
          action={
            <Link className="btn btn-primary" href="/discover">
              Find an article
            </Link>
          }
        >
          Articles you buy appear here with the days you have left.
        </EmptyState>
      ) : (
        <ul className="grid-2" style={{ listStyle: 'none', padding: 0 }}>
          {items.map((i) => (
            <li key={i.entitlement_id} className="card" data-testid="library-item">
              <h2>
                <Link href={`/library/${encodeURIComponent(i.entitlement_id)}`}>{i.title}</Link>
              </h2>
              <p className="muted">
                {i.publisher}, {optionLabel(i.option)}
              </p>
              <p aria-live="polite" aria-atomic="true" data-testid="library-status">
                <strong>{i.status_text}</strong>
              </p>
              {i.refunded ? null : (
                <WindowMeter
                  state={i.window.state}
                  daysLeft={i.window.days_left}
                  endsAt={i.window.ends_at}
                />
              )}
              {i.can_open ? (
                <div className="actions">
                  <OpenButton
                    entitlementId={i.entitlement_id}
                    mode={i.option === 'keep_retrieve' ? 'download' : 'read'}
                  />
                </div>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </>
  );
}
