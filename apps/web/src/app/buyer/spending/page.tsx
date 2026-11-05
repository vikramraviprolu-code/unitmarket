import Link from 'next/link';
import { redirect } from 'next/navigation';
import type { Metadata } from 'next';
import { app } from '../../../server/access';
import { currentActor } from '../../../server/session';
import { readSpending } from '../../../composition/buyer';
import { barState, hrefWith, rawFromSearchParams } from '../../../lib/filter-bar-view';
import {
  SPENDING_FILTER_CONTEXT,
  SPENDING_LEDE,
  SPENDING_TITLE,
  spendingModel,
} from '../../../lib/buyer-spending-view';
import { displayRef } from '../../../lib/ref-format';
import { FilterBar } from '../../../ui/FilterBar';
import { EnvLabel } from '../../../ui/EnvLabel';
import { PageHeader } from '../../../ui/publisher/kit';
import { SpendingExport } from '../../../ui/buyer/SpendingExport';
import '../../../ui/buyer/buyer.css';
import '../../tables.css';
import '../../publisher/pk-sales.css';

export const metadata: Metadata = { title: SPENDING_TITLE };

const PAGE_PATH = '/buyer/spending';

// INT-BUY / BUY.4: the buyer's own purchases under the shared filter bar (buyer fields only). The list is SR1's
// buyer read, done on the server for the signed-in buyer; the CSV comes from GET /api/buyer/orders/export.
export default async function BuyerSpending({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const actor = await currentActor();
  if (actor?.kind !== 'buyer') redirect('/signin?next=/buyer/spending');
  const raw = rawFromSearchParams(await searchParams);
  const a = await app();
  const ctx = SPENDING_FILTER_CONTEXT;
  const bar = barState(ctx, raw);
  const list = await readSpending(actor.buyer_id, {
    ...bar.map,
    ...(raw['cursor'] === undefined ? {} : { cursor: raw['cursor'] }),
  }).catch(() => null);
  const model = spendingModel(list?.lines ?? [], a.security.clock.now());
  const next =
    list?.next_cursor == null
      ? null
      : hrefWith(PAGE_PATH, { ...bar.map, cursor: list.next_cursor });
  return (
    <>
      <PageHeader
        title={SPENDING_TITLE}
        aside={<EnvLabel environment={a.environment} />}
        lede={SPENDING_LEDE}
      />
      <FilterBar ctx={ctx} raw={raw} basePath={PAGE_PATH} presets={[]} label="Spending filters" />
      <SpendingExport query={bar.map} />
      {list === null ? (
        <p role="alert" data-testid="spending-error">
          The list could not be loaded. Try again in a moment.
        </p>
      ) : model.empty !== null ? (
        <p data-testid="spending-empty">{model.empty}</p>
      ) : (
        <div className="table-scroll" tabIndex={0} role="region" aria-label="Spending table">
          <table className="pk-table" aria-label="Your purchases" data-testid="spending-table">
            <caption className="visually-hidden">Your purchases, newest first</caption>
            <thead>
              <tr>
                <th scope="col">Order</th>
                <th scope="col">When</th>
                <th scope="col">Items</th>
                <th scope="col">Amount</th>
                <th scope="col">Status</th>
                <th scope="col">Bought by</th>
                <th scope="col">Mode</th>
              </tr>
            </thead>
            <tbody>
              {model.rows.map((r) => (
                <tr key={r.key}>
                  <td className="mono">
                    <Link href={r.href} title={r.order_ref}>
                      {displayRef(r.order_ref)}
                    </Link>
                  </td>
                  <td>{r.when}</td>
                  <td>{r.items}</td>
                  <td className="pk-num">
                    {r.money_text}
                    {r.refunded_text !== null ? (
                      <span className="txn-flags">{r.refunded_text} refunded</span>
                    ) : null}
                  </td>
                  <td>{r.status_word}</td>
                  <td>{r.by}</td>
                  <td>{r.environment === 'sandbox' ? 'Sandbox' : 'Dry run'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {next !== null ? (
        <p>
          <Link className="btn" href={next} rel="next">
            Next page
          </Link>
        </p>
      ) : null}
    </>
  );
}
