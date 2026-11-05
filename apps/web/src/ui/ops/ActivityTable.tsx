'use client';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { getJson } from '../../lib/client-api';
import { ACTIVITY_PRESETS, barState, hrefWith } from '../../lib/filter-bar-view';
import type { RawMap } from '../../lib/filter-bar-view';
import {
  ACTIVITY_PAGE_PATH,
  activityPageView,
  activityUrl,
  nextPageHref,
  presetHref,
} from '../../lib/activity-view';
import type { ActivityItem, ActivityPageView } from '../../lib/activity-view';
import { FilterBar } from '../FilterBar';
import './ops-b.css';

// INT-OPS-B / OPS-B.4: the activity log. The page is a server shell; this table asks the session route
// GET /api/ops/activity (TR1) through getJson. Without the second factor the bar does not offer actor_id and
// the rows hold no identity; with it a row says who, with or without the second factor, on which channel.
export function ActivityTable({ raw, mfa }: { raw: RawMap; mfa: boolean }) {
  const ctx = { kind: 'activity', mfa } as const;
  const url = activityUrl(ctx, raw, raw['cursor']);
  const [view, setView] = useState<ActivityPageView | null>(null);

  useEffect(() => {
    let alive = true;
    setView(null);
    void getJson<{ items: ActivityItem[]; next_cursor: string | null }>(url).then((r) => {
      if (alive) setView(activityPageView(r.ok ? { ok: true, data: r.data } : r, { mfa }));
    });
    return () => {
      alive = false;
    };
  }, [url, mfa]);

  const current = barState(ctx, raw).map;
  const presets = ACTIVITY_PRESETS.map((p) => ({
    id: p.id,
    label: p.label,
    href: presetHref(p.map),
    current: JSON.stringify(current) === JSON.stringify(p.map),
  }));
  const next =
    view?.kind === 'rows' ? nextPageHref(ACTIVITY_PAGE_PATH, ctx, raw, view.next_cursor) : null;
  return (
    <>
      <FilterBar
        ctx={ctx}
        raw={raw}
        basePath={ACTIVITY_PAGE_PATH}
        presets={presets}
        label="Activity filters"
      />
      <p role="status" aria-live="polite" className="txn-note" data-testid="activity-status">
        {view === null
          ? 'Loading the activity log.'
          : view.kind === 'rows'
            ? `Showing ${String(view.rows.length)} events.`
            : ''}
      </p>
      {view?.kind === 'error' ? (
        <p role="alert" data-testid="activity-error">
          {view.message}
        </p>
      ) : null}
      {view?.kind === 'empty' ? <p data-testid="activity-empty">{view.message}</p> : null}
      {view?.kind === 'rows' ? (
        <div className="table-scroll" tabIndex={0} role="region" aria-label="Activity table">
          <table className="pk-table" data-testid="activity-table">
            <caption className="visually-hidden">Activity log, newest first</caption>
            <thead>
              <tr>
                <th scope="col">When</th>
                <th scope="col">Who</th>
                <th scope="col">Channel</th>
                <th scope="col">Event</th>
                <th scope="col">Context</th>
              </tr>
            </thead>
            <tbody>
              {view.rows.map((r) => (
                <tr key={r.key}>
                  <td>
                    <time dateTime={r.at}>{r.when}</time>
                  </td>
                  <td>
                    {r.actor_word}
                    {r.actor_id !== null ? (
                      <span className="txn-flags mono">{r.actor_id}</span>
                    ) : null}
                    {r.mfa_word !== null ? <span className="txn-flags">{r.mfa_word}</span> : null}
                  </td>
                  <td>{r.channel_word}</td>
                  <td>{r.event}</td>
                  <td className="mono">{r.context}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
      <p className="txn-pager">
        {raw['cursor'] !== undefined ? (
          <Link href={hrefWith(ACTIVITY_PAGE_PATH, current)}>Back to the first page</Link>
        ) : null}
        {next !== null ? <Link href={next}>Next page</Link> : null}
      </p>
    </>
  );
}
