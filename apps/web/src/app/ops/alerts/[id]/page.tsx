import { notFound, redirect } from 'next/navigation';
import type { Metadata } from 'next';
import Link from 'next/link';
import { currentActor } from '../../../../server/session';
import { readAlertPage } from '../../../../composition/ops-home';
import { PageHeader } from '../../../../ui/publisher/kit';
import { AlertDetail } from '../../../../ui/ops/AlertDetail';
import { alertDetailView } from '../../../../lib/ops-alerts-view';
import '../../../publisher/pk-sales.css';
import '../../pk-opshome.css';

export const metadata: Metadata = { title: 'Alert' };

// INT-OPS-A / OPS-A.3: one alert. Operators only; one without the authenticator code reads it and sees every
// button off. The single-use keys of the buttons are made here, on the server.
export default async function OpsAlert({ params }: { params: Promise<{ id: string }> }) {
  const actor = await currentActor();
  if (actor?.kind !== 'operator') redirect('/signin?next=/ops/alerts');
  const { id } = await params;
  const page = await readAlertPage(actor, id);
  if (page === null) notFound();
  const view = alertDetailView(page.detail, {
    mfa: actor.mfa === true,
    keys: page.keys,
    order_anchor: page.order_anchor,
  });
  return (
    <>
      <PageHeader title={view.title} lede={view.cause} />
      <p>
        <Link href="/ops/alerts">All alerts</Link>
      </p>
      <AlertDetail view={view} />
    </>
  );
}
