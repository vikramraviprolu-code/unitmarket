// INT-GA / GA.2 (F14): the model fallback and the checks every chip passes. Only the scrubbed rest is sent, with
// purpose txn_query. The answer then passes, in order: (1) it must be a map of strings, or it is dropped whole;
// (2) each field the role table refuses for the caller is removed and named in `dropped`; (3) parseTxnQuery reads
// the rest and an invalid value is dropped (and named); (4) the caller's scope check runs last, so after (2) it can
// no longer refuse a field. GA never runs a query: the person sees the chips and the dropped list and edits them.
import { TXN_QUERY_KEYS, parseTxnQuery } from '@umsbx/contracts';
import type { ModelPort, TxnQuery } from '@umsbx/contracts';
import { ChipSet } from './chips';
import type { AssistRole } from './chips';
import { parseRules } from './parse-rules';
import type { AssistContext } from './parse-rules';

export interface AssistAnswer {
  chips: Record<string, string>;
  dropped: string[];
}

/** Step 4, supplied by the composition: `scopeQuery(principal, raw, parsed)` of SR0. It must not refuse. */
export type ScopeCheck = (raw: Record<string, string>, parsed: TxnQuery) => void;

/** The page cursor and size are the list's, never a proposal's. */
const PROPOSABLE: ReadonlySet<string> = new Set(
  TXN_QUERY_KEYS.filter((k) => k !== 'cursor' && k !== 'limit'),
);

const isStringMap = (v: unknown): v is Record<string, string> =>
  typeof v === 'object' &&
  v !== null &&
  !Array.isArray(v) &&
  Object.values(v as Record<string, unknown>).every((x) => typeof x === 'string');

/** Step 1: the model's answer as a string map, or nothing. Never throws. */
async function ask(rest: string, port: ModelPort): Promise<Record<string, string>> {
  if (rest.trim() === '') return {};
  try {
    const r = await port.complete({ purpose: 'txn_query', system: '', input: { rest } });
    return r.kind === 'ok' && isStringMap(r.output) ? r.output : {};
  } catch {
    return {};
  }
}

const valueOf = (v: unknown): string => (Array.isArray(v) ? v.join(',') : String(v));

/** Steps 2 to 4 on a merged proposal. `first` wins over `second` on the same field. */
function check(
  role: AssistRole,
  first: Record<string, string>,
  second: Record<string, string>,
  dropped: readonly string[],
  scope?: ScopeCheck,
): AssistAnswer {
  const set = new ChipSet(role);
  for (const f of dropped) set.drop(f);
  const merged: Record<string, string> = {};
  for (const [k, v] of [...Object.entries(second), ...Object.entries(first)]) {
    if (!PROPOSABLE.has(k)) continue;
    if (set.refused(k)) {
      set.drop(k);
      continue;
    }
    merged[k] = v;
  }
  const parsed = parseTxnQuery(merged) as Record<string, unknown>;
  const chips: Record<string, string> = {};
  for (const k of Object.keys(merged)) {
    if (parsed[k] === undefined) set.drop(k);
    else chips[k] = valueOf(parsed[k]);
  }
  scope?.(chips, parseTxnQuery(chips));
  return { chips, dropped: [...set.dropped] };
}

/** GA.2: ask the model about the rest only, then the four checks. */
export async function parseWithModel(
  rest: string,
  port: ModelPort,
  ctx: Pick<AssistContext, 'role'>,
  scope?: ScopeCheck,
): Promise<AssistAnswer> {
  return check(ctx.role, {}, await ask(rest, port), [], scope);
}

/** GA.1 then GA.2: the rules, the model on what they left, and the four checks on both. A rule chip wins. */
export async function assistQuery(
  text: string,
  now: Date,
  ctx: AssistContext,
  port: ModelPort,
  scope?: ScopeCheck,
): Promise<AssistAnswer> {
  const rules = parseRules(text, now, ctx);
  const model = await ask(rules.rest, port);
  return check(ctx.role, rules.chips, model, rules.dropped, scope);
}
