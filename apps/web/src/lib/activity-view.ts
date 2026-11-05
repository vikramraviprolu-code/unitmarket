// INT-OPS-B / OPS-B.4: the logic of Controls > Activity. Pure. The table calls GET /api/ops/activity (TR1)
// through getJson. Without the second factor the route answers identity-free rows and refuses the actor_id
// filter, so the bar never offers it and this view never invents what the route left out. With it, a row says
// who did it, with the second factor or not, on which channel, and when.
import type { OpsTimelineEntry } from '@umsbx/contracts';
import { formatDateTime } from './format';
import { barState, hrefWith, pageHref, queryString } from './filter-bar-view';
import type { BarContext, RawMap } from './filter-bar-view';
import { failureText } from './transactions-view';
import type { ApiResult } from './transactions-view';
import { ACTOR_WORDS, CHANNEL_WORDS, readableKey } from './timeline-view';

export const ACTIVITY_PATH = '/api/ops/activity';
export const ACTIVITY_PAGE_PATH = '/ops/controls/activity';

export type ActivityItem = OpsTimelineEntry;

/** The request: the bar's canonical query, and TR1's cursor only when the caller passes one. */
export function activityUrl(ctx: BarContext, raw: RawMap, cursor?: string): string {
  const qs = queryString(barState(ctx, raw).map);
  const tail =
    cursor === undefined ? '' : `${qs === '' ? '' : '&'}cursor=${encodeURIComponent(cursor)}`;
  return qs === '' && tail === '' ? ACTIVITY_PATH : `${ACTIVITY_PATH}?${qs}${tail}`;
}

export const nextPageHref = (
  basePath: string,
  ctx: BarContext,
  raw: RawMap,
  cursor: string | null,
): string | null => pageHref(basePath, ctx, raw, cursor);

export const presetHref = (map: Readonly<Record<string, string>>): string =>
  hrefWith(ACTIVITY_PAGE_PATH, map);

export interface ActivityRow {
  key: string;
  at: string;
  when: string;
  actor_kind: string;
  actor_word: string;
  /** TR1 sends it for system and operator rows, and for every row with MFA. */
  actor_id: string | null;
  /** True or false with MFA; null without it, where the route leaves the flag out. */
  mfa: boolean | null;
  mfa_word: string | null;
  channel: string;
  channel_word: string;
  event_type: string;
  event: string;
  source_table: string;
  source_id: string;
  context: string;
  req_id: string | null;
}

const OP_WORDS: Readonly<Record<string, string>> = {
  created: 'created',
  updated: 'changed',
  imported: 'imported',
};

/** "safety_switches.updated" becomes "Safety switches changed". */
export function eventText(e: Pick<ActivityItem, 'event_type' | 'state_to'>): string {
  const [table = '', op = ''] = e.event_type.split('.');
  const base = `${readableKey(table)} ${OP_WORDS[op] ?? op}`.trim();
  return e.state_to === undefined ? base : `${base}, now ${e.state_to}`;
}

export function activityRowsOf(items: readonly ActivityItem[], o: { mfa: boolean }): ActivityRow[] {
  return items.map((e) => {
    const parts = [`${e.source.table} ${e.source.id}`];
    if (e.job !== undefined && e.job !== null) parts.push(`job ${e.job}`);
    if (e.tool !== undefined && e.tool !== null) parts.push(`tool ${e.tool}`);
    const req = o.mfa && e.req_id !== undefined && e.req_id !== null ? e.req_id : null;
    if (req !== null) parts.push(`request ${req}`);
    const mfa = o.mfa && e.mfa !== undefined ? e.mfa : null;
    return {
      key: `${e.chain_key ?? ''}#${String(e.seq)}`,
      at: e.at,
      when: formatDateTime(e.at),
      actor_kind: e.actor.kind,
      actor_word: ACTOR_WORDS[e.actor.kind],
      actor_id: e.actor_id ?? null,
      mfa,
      mfa_word: mfa === null ? null : mfa ? 'With the second factor' : 'Without the second factor',
      channel: e.channel,
      channel_word: CHANNEL_WORDS[e.channel],
      event_type: e.event_type,
      event: eventText(e),
      source_table: e.source.table,
      source_id: e.source.id,
      context: parts.join(', '),
      req_id: req,
    };
  });
}

export type ActivityPageView =
  | { kind: 'rows'; rows: ActivityRow[]; next_cursor: string | null }
  | { kind: 'empty'; message: string }
  | { kind: 'error'; message: string };

export const ACTIVITY_EMPTY = 'Nothing has been recorded for these filters.';

export function activityPageView(
  result: ApiResult<{ items: readonly ActivityItem[]; next_cursor: string | null }>,
  o: { mfa: boolean },
): ActivityPageView {
  if (!result.ok) return { kind: 'error', message: failureText(result.status, result.code) };
  if (result.data.items.length === 0) return { kind: 'empty', message: ACTIVITY_EMPTY };
  return {
    kind: 'rows',
    rows: activityRowsOf(result.data.items, o),
    next_cursor: result.data.next_cursor,
  };
}
