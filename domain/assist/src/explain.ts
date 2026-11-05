// INT-GA / GA.4 (F4, F7): "explain this problem order". The port gets the identity-free projection only, whatever
// view the entries came from: per entry seq, event_type, words_key, the actor's kind, channel, state_from and
// state_to; the alert kinds on the order; the fix ids. Nothing else: no source id, actor id or label, provider id or
// tail, amount, time, ref, buyer, seller, request id or address. The answer's action is one of the fix ids or `none`;
// its two texts are plain strings cut at 400 characters (the panel prints them as text). Any failure gives a safe
// answer with no action.
import type { ModelPort, OpsTimelineEntry } from '@umsbx/contracts';

export interface ExplainEntry {
  seq: number;
  event_type: string;
  words_key: string;
  actor_kind: string;
  channel: string;
  state_from: string | null;
  state_to: string | null;
}

export interface ExplainInput {
  entries: ExplainEntry[];
  alert_kinds: string[];
  fix_ids: string[];
}

export interface ExplainAnswer {
  what_happened: string;
  safe_now: string;
  /** An AL catalogue alert kind that has a fix, or `none`. */
  action_id: string;
}

export const EXPLAIN_TEXT_MAX = 400;
const MAX_ENTRIES = 500;
const KIND = /^[a-z][a-z0-9_]{0,59}$/;

export const EXPLAIN_FALLBACK: ExplainAnswer = {
  what_happened: 'No explanation could be made for this order. Read its timeline below.',
  safe_now: 'Change nothing until the cause is clear.',
  action_id: 'none',
};

const kinds = (list: readonly string[]): string[] => [
  ...new Set(list.filter((k) => typeof k === 'string' && KIND.test(k))),
];

/** The one projection (F7). It copies seven named fields and builds every object fresh. */
export function explainProjection(
  entries: readonly OpsTimelineEntry[],
  alertKinds: readonly string[],
  fixIds: readonly string[],
): ExplainInput {
  return {
    entries: entries.slice(0, MAX_ENTRIES).map((e) => ({
      seq: e.seq,
      event_type: e.event_type,
      words_key: e.words_key,
      actor_kind: e.actor.kind,
      channel: e.channel,
      state_from: e.state_from ?? null,
      state_to: e.state_to ?? null,
    })),
    alert_kinds: kinds(alertKinds),
    fix_ids: kinds(fixIds),
  };
}

const cut = (s: string): string => Array.from(s).slice(0, EXPLAIN_TEXT_MAX).join('');
const text = (v: unknown): string | null =>
  typeof v === 'string' && v.trim() !== '' ? cut(v) : null;

export async function explainOrder(
  entries: readonly OpsTimelineEntry[],
  alertKinds: readonly string[],
  fixIds: readonly string[],
  port: ModelPort,
): Promise<ExplainAnswer> {
  const input = explainProjection(entries, alertKinds, fixIds);
  let output: unknown;
  try {
    const r = await port.complete({ purpose: 'explain_order', system: '', input });
    if (r.kind !== 'ok') return EXPLAIN_FALLBACK;
    output = r.output;
  } catch {
    return EXPLAIN_FALLBACK;
  }
  if (typeof output !== 'object' || output === null || Array.isArray(output))
    return EXPLAIN_FALLBACK;
  const o = output as Record<string, unknown>;
  const what = text(o['what_happened']);
  const safe = text(o['safe_now']);
  if (what === null || safe === null) return EXPLAIN_FALLBACK;
  const id = o['action_id'];
  const action_id = typeof id === 'string' && input.fix_ids.includes(id) ? id : 'none';
  return { what_happened: what, safe_now: safe, action_id };
}

const SEVERITY_ORDER = ['critical', 'high', 'medium', 'info'];

/**
 * The fix ids in catalogue severity order: critical, high, medium, info; ties keep the order given (the catalogue's).
 * A kind with no severity is left out. The scripted model picks the first of these that is on the order.
 */
export function orderFixIds(
  kindsWithFix: readonly string[],
  severityOf: (kind: string) => string | null,
): string[] {
  const rank = (k: string): number => SEVERITY_ORDER.indexOf(severityOf(k) ?? '');
  return kindsWithFix
    .map((k, i) => ({ k, i, r: rank(k) }))
    .filter((x) => x.r >= 0)
    .sort((a, b) => a.r - b.r || a.i - b.i)
    .map((x) => x.k);
}
