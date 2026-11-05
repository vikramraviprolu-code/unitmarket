'use client';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { getJson } from '../../lib/client-api';
import { barState, hrefWith } from '../../lib/filter-bar-view';
import type { FilterPersona, RawMap } from '../../lib/filter-bar-view';
import { displayRef } from '../../lib/ref-format';
import {
  PAGE_PATH,
  csvDownload,
  exportUrl,
  listUrl,
  nextPageHref,
  pageViewOf,
  savedViewLinks,
} from '../../lib/transactions-view';
import type { TxnItem, TxnPageView } from '../../lib/transactions-view';
import { EnvLabel } from '../EnvLabel';
import { FilterBar } from '../FilterBar';
import './ops-b.css';

// INT-OPS-B / OPS-B.2: the operator transaction list. The page is a server shell; this table asks the session
// route GET /api/ops/transactions through getJson, so the cursor hash and the MFA rule stay in the route
// handler (SR1). All wording and rules come from lib/transactions-view.ts.
export function TransactionsTable({
  raw,
  persona,
  mfa,
}: {
  raw: RawMap;
  persona: FilterPersona;
  mfa: boolean;
}) {
  const ctx = { kind: 'txn', persona } as const;
  const url = listUrl(ctx, raw, raw['cursor']);
  const [view, setView] = useState<TxnPageView | null>(null);
  const [csv, setCsv] = useState('');

  useEffect(() => {
    let alive = true;
    setView(null);
    void getJson<{ items: TxnItem[]; next_cursor: string | null }>(url).then((r) => {
      if (alive) setView(pageViewOf(r.ok ? { ok: true, data: r.data } : r, { mfa }));
    });
    return () => {
      alive = false;
    };
  }, [url, mfa]);

  const download = async (): Promise<void> => {
    setCsv('Preparing the file.');
    const r = await getJson<{ filename: string; csv: string; truncated: boolean }>(
      exportUrl(ctx, raw),
    );
    if (!r.ok) {
      setCsv('The file could not be made. Try again in a moment.');
      return;
    }
    const file = csvDownload(r.data);
    const href = URL.createObjectURL(new Blob([file.text], { type: file.mime }));
    const a = document.createElement('a');
    a.href = href;
    a.download = file.filename;
    a.click();
    URL.revokeObjectURL(href);
    setCsv(file.note ?? 'The file was downloaded.');
  };

  const next = view?.kind === 'rows' ? nextPageHref(PAGE_PATH, ctx, raw, view.next_cursor) : null;
  const first = hrefWith(PAGE_PATH, barState(ctx, raw).map);
  return (
    <>
      <FilterBar
        ctx={ctx}
        raw={raw}
        basePath={PAGE_PATH}
        presets={savedViewLinks(ctx, raw)}
        label="Transaction filters"
      />
      <p className="actions">
        <button type="button" className="btn" onClick={() => void download()}>
          Download CSV
        </button>
      </p>
      <p role="status" aria-live="polite" className="txn-note" data-testid="txn-status">
        {csv !== ''
          ? csv
          : view === null
            ? 'Loading transactions.'
            : view.kind === 'rows'
              ? `Showing ${String(view.rows.length)} transactions.`
              : ''}
      </p>
      {view?.kind === 'error' ? (
        <p role="alert" data-testid="txn-error">
          {view.message}
        </p>
      ) : null}
      {view?.kind === 'empty' ? <p data-testid="txn-empty">{view.message}</p> : null}
      {view?.kind === 'rows' ? (
        <div className="table-scroll" tabIndex={0} role="region" aria-label="Transactions table">
          <table className="pk-table" data-testid="txn-table">
            <caption className="visually-hidden">Transactions, newest first</caption>
            <thead>
              <tr>
                <th scope="col">Order</th>
                <th scope="col">When</th>
                <th scope="col">Status</th>
                <th scope="col">Amount</th>
                <th scope="col">Channel</th>
                <th scope="col">Mode</th>
                <th scope="col">Items</th>
                {mfa ? <th scope="col">Buyer</th> : null}
                {mfa ? <th scope="col">Seller</th> : null}
                {mfa ? <th scope="col">PayPal order</th> : null}
              </tr>
            </thead>
            <tbody>
              {view.rows.map((r) => (
                <tr key={r.key}>
                  <td className="mono">
                    <Link href={r.href} data-testid="txn-ref" title={r.order_ref}>
                      {displayRef(r.order_ref)}
                    </Link>
                  </td>
                  <td>
                    <time dateTime={r.at}>{r.when}</time>
                  </td>
                  <td>
                    {r.status_word}
                    {r.flags.length > 0 ? (
                      <span className="txn-flags">{r.flags.join(', ')}</span>
                    ) : null}
                  </td>
                  <td className="pk-num">
                    {r.amount}
                    {r.refunded !== null ? (
                      <span className="txn-flags">{r.refunded} refunded</span>
                    ) : null}
                  </td>
                  <td>{r.channel_word}</td>
                  <td>
                    <EnvLabel environment={r.environment} />
                  </td>
                  <td>{r.titles}</td>
                  {mfa ? <td>{r.buyer ?? ''}</td> : null}
                  {mfa ? <td>{r.seller ?? ''}</td> : null}
                  {mfa ? <td className="mono">{r.provider_order ?? ''}</td> : null}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
      <p className="txn-pager">
        {raw['cursor'] !== undefined ? <Link href={first}>Back to the first page</Link> : null}
        {next !== null ? <Link href={next}>Next page</Link> : null}
      </p>
    </>
  );
}
