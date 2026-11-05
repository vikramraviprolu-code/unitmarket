import { redirect } from 'next/navigation';
import type { Metadata } from 'next';
import { currentActor } from '../../../server/session';
import { readAlertList } from '../../../composition/ops-home';
import { PageHeader } from '../../../ui/publisher/kit';
import { AlertList } from '../../../ui/ops/AlertList';
import { alertListView, alertQuery, parseAlertFilter } from '../../../lib/ops-alerts-view';
import '../../tables.css';
import '../../publisher/pk-sales.css';
import '../pk-opshome.css';

export const metadata: Metadata = { title: 'Alerts' };

// INT-OPS-A / OPS-A.3: the alert list. An operator without the authenticator code reads it too; the buttons on
// one alert are what the code unlocks. Anyone who is not an operator is sent to sign in before anything is read.
export default async function OpsAlerts({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const actor = await currentActor();
  if (actor?.kind !== 'operator') redirect('/signin?next=/ops/alerts');
  const filter = parseAlertFilter(await searchParams);
  const list = await readAlertList(alertQuery(filter));
  return (
    <>
      <PageHeader
        title="Alerts"
        lede={
          actor.mfa
            ? 'Everything that went wrong or needs a look. Open one to act on it.'
            : 'Everything that went wrong or needs a look. Acting on an alert needs your authenticator code.'
        }
      />
      <AlertList view={alertListView(list, filter)} />
    </>
  );
}
