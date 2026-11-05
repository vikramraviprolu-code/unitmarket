import { redirect } from 'next/navigation';
import type { Metadata } from 'next';
import { currentActor } from '../../../../server/session';
import { readOpsTransactionsProps } from '../../../../composition/ops-money';
import { EnvLabel } from '../../../../ui/EnvLabel';
import { PageHeader } from '../../../../ui/publisher/kit';
import { TransactionsTable } from '../../../../ui/ops/TransactionsTable';
import { rawFromSearchParams, txnPersona } from '../../../../lib/filter-bar-view';
import '../../pk-opshome.css';
import '../../../tables.css';
import '../../../publisher/pk-sales.css';

export const metadata: Metadata = { title: 'Transactions' };

// INT-OPS-B / OPS-B.2: the operator transaction list. This page is a shell: it checks the sign-in, reads the
// props (the stored environment and whether the session has MFA) and mounts the table, which reads
// GET /api/ops/transactions in the browser. Names and PayPal ids come from that route, and only with MFA.
export default async function OpsTransactions({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const actor = await currentActor();
  if (actor?.kind !== 'operator') redirect('/signin?next=/ops/money/transactions');
  const props = await readOpsTransactionsProps(actor);
  if (props === null) redirect('/signin?next=/ops/money/transactions');
  const raw = rawFromSearchParams(await searchParams);
  return (
    <>
      <PageHeader
        title="Transactions"
        aside={<EnvLabel environment={props.environment} />}
        lede="Find any transaction. Filters stay in the address, so a filtered list can be shared or bookmarked."
      />
      <TransactionsTable raw={raw} persona={txnPersona(actor)} mfa={props.mfa} />
    </>
  );
}
