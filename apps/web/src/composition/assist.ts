// INT-GA (R2-4, GA-L5): the assist reads. The ask box route turns plain words into proposed filter chips; the explain
// panel and its route explain a problem order. Both reach the model through App.model (scripted, or Claude behind
// the caps and the paypal_outbound switch) and AL's catalogue through the one door. Neither writes anything, runs a
// query or logs the text, the chips or the answer.
import { createHash } from 'node:crypto';
import { statusGroupOf } from '@umsbx/contracts';
import type { Actor, ModelPort } from '@umsbx/contracts';
import {
  ALERT_KINDS,
  app,
  assistQuery,
  explainOrder,
  orderFixIds,
  scopeQuery,
  severityOf,
  takeToken,
} from '../server/access';
import type { App, AssistAnswer, AssistRole, ExplainAnswer } from '../server/access';

/**
 * F8 / GA-L5: the model port and the fix ids. Every AL catalogue entry has a fix (its type requires one), so the fix
 * ids are the catalogue's alert kinds, in severity order: the scripted model picks the first one on the order.
 */
export async function assistDeps(): Promise<{ model: ModelPort; fixIds: readonly string[] }> {
  const a = await app();
  return { model: a.model, fixIds: orderFixIds(ALERT_KINDS, severityOf) };
}

/** The role the transaction search applies to this sign-in (SR0's REFUSED_FIELDS key), or null. */
export function assistRole(actor: Actor): AssistRole | null {
  switch (actor.kind) {
    case 'buyer':
      return 'buyer';
    case 'publisher':
      return 'publisher';
    case 'operator':
      return actor.mfa === true ? 'operator' : 'operator_key';
    default:
      return null;
  }
}

/** Seller names this person may name: a buyer the live catalogue, a seller itself, an operator every seller. */
async function sellersFor(a: App, actor: Actor): Promise<string[]> {
  const q =
    actor.kind === 'publisher'
      ? a.db.query<{ n: string }>('SELECT display_name AS n FROM publishers WHERE id = $1', [
          actor.publisher_id,
        ])
      : actor.kind === 'operator'
        ? a.db.query<{ n: string }>(
            'SELECT display_name AS n FROM publishers ORDER BY display_name',
          )
        : a.db.query<{ n: string }>(
            `SELECT display_name AS n FROM publishers WHERE status = 'active' ORDER BY display_name`,
          );
  return (await q).rows.map((r) => r.n);
}

/** GA.1 and GA.2: proposed chips and dropped fields for the person's own words. Null for a sign-in that cannot search. */
export async function askAssist(actor: Actor, text: string): Promise<AssistAnswer | null> {
  const role = assistRole(actor);
  if (role === null) return null;
  const a = await app();
  const { model } = await assistDeps();
  const sellers = await sellersFor(a, actor);
  // Step 4: SR0's own scope check runs last on what is proposed. After the role table it cannot refuse.
  return assistQuery(text, a.security.clock.now(), { role, sellers }, model, (raw, parsed) => {
    scopeQuery(actor, raw, parsed);
  });
}

export interface OrderExplain {
  answer: ExplainAnswer;
  /** The catalogue fix of each alert kind on the order (AL's own words, from the alert read). */
  fixes: Record<string, { route: string; anchor: string }>;
}

/**
 * The rate rule of the explain route (`routeMeta.rate` in app/api/ops/orders/[ref]/explain/route.ts; a test holds the
 * two equal). The order page spends from the same bucket (name and operator id), so route and page together stay
 * under 10 model calls a minute for each operator.
 */
export const EXPLAIN_RATE = {
  name: 'ops_explain',
  per: 'actor',
  limit: 10,
  window_ms: 60_000,
} as const;

/** INT-GA FU-1: one entry for each order and each set of model inputs, kept in memory, at most this many. */
export const EXPLAIN_CACHE_MAX = 200;
const explainCache = new WeakMap<App, Map<string, Promise<OrderExplain>>>();

async function explainCore(
  actor: Actor,
  ref: string,
  page: boolean,
): Promise<OrderExplain | null | 'not_found' | 'paused'> {
  if (actor.kind !== 'operator') return null;
  const a = await app();
  const order = (
    await a.db.query<{ id: string; status: string }>(
      'SELECT id, status FROM orders WHERE order_ref = $1',
      [ref],
    )
  ).rows[0];
  if (order === undefined) return 'not_found';
  const now = a.security.clock.now();
  const units = (
    await a.db.query<{ status: string; updated_at: string | Date }>(
      'SELECT status, updated_at FROM order_units WHERE order_id = $1',
      [order.id],
    )
  ).rows;
  const rows = units.length > 0 ? units : [{ status: '', updated_at: now }];
  const attention = rows.some(
    (u) =>
      statusGroupOf(
        { order_status: order.status, unit_status: u.status, unit_updated_at: u.updated_at },
        now,
      ) === 'attention',
  );
  if (!attention) return null;
  const tl = await a.trace.opsTimeline({ order_ref: ref, mfa: false });
  const ids = await a.db.query<{ id: string }>(
    `SELECT a.id FROM alerts a LEFT JOIN order_units u ON u.id = a.unit_id
      WHERE COALESCE(a.order_id, u.order_id) = $1 ORDER BY a.created_at, a.id`,
    [order.id],
  );
  const kinds: string[] = [];
  const fixes: Record<string, { route: string; anchor: string }> = {};
  for (const r of ids.rows) {
    const d = await a.engine.opsReads.alert(r.id);
    if (d === null || d.state === 'resolved') continue;
    kinds.push(d.kind);
    fixes[d.kind] ??= { route: d.fix.route, anchor: d.fix.anchor };
  }
  const { model, fixIds } = await assistDeps();
  const ask = async (): Promise<OrderExplain> => ({
    answer: await explainOrder(tl?.entries ?? [], kinds, fixIds, model),
    fixes,
  });
  if (!page) return ask();

  // The page path (FU-1). The key is everything the answer depends on: the identity-free steps the model is sent, the
  // alert kinds, the fix ids and the fix links. The same key gets the same answer without a model call (also while the
  // first call is still running). A miss spends one token of the route's bucket; with none left the page is paused.
  let cache = explainCache.get(a);
  if (cache === undefined) explainCache.set(a, (cache = new Map()));
  const key = createHash('sha256')
    .update(JSON.stringify([order.id, tl?.entries ?? [], kinds, fixIds, fixes]))
    .digest('hex');
  const hit = cache.get(key);
  if (hit !== undefined) return hit;
  // A page render has no trace context of its own, and the bucket is a write, so it runs as the page actor.
  const verdict = await a.engine.asPageActor(actor, () =>
    takeToken(a.security, EXPLAIN_RATE, actor.operator_id),
  );
  if (!verdict.allowed) return 'paused';
  const again = cache.get(key);
  if (again !== undefined) return again;
  const started = ask();
  cache.set(key, started);
  started.catch(() => cache.delete(key));
  while (cache.size > EXPLAIN_CACHE_MAX) cache.delete(cache.keys().next().value as string);
  return started;
}

/**
 * GA.4: the explanation of one order, for an operator. `not_found` when there is no such order; null when its status
 * group is not `attention` (then the model is not asked). The entries are always the identity-free operator view,
 * even on an MFA session, and the domain sends only its seven-field projection. The route calls this and counts
 * every call against its rate rule.
 */
export async function explainForOrder(
  actor: Actor,
  ref: string,
): Promise<OrderExplain | null | 'not_found'> {
  const r = await explainCore(actor, ref, false);
  return r === 'paused' ? null : r;
}

/**
 * GA.4 on the order page (FU-1): the same explanation, but a page read keeps its answer for an unchanged order and
 * spends a token of the route's bucket only when it must ask the model. `paused` when the bucket is empty.
 */
export function explainForOrderPage(
  actor: Actor,
  ref: string,
): Promise<OrderExplain | null | 'not_found' | 'paused'> {
  return explainCore(actor, ref, true);
}
