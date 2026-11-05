// INT-GA (R2-4, GA-L5): the assist reads. The ask box route turns plain words into proposed filter chips; the explain
// panel and its route explain a problem order. Both reach the model through App.model (scripted, or Claude behind
// the caps and the paypal_outbound switch) and AL's catalogue through the one door. Neither writes anything, runs a
// query or logs the text, the chips or the answer.
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
 * GA.4: the explanation of one order, for an operator. `not_found` when there is no such order; null when its status
 * group is not `attention` (then the model is not asked). The entries are always the identity-free operator view,
 * even on an MFA session, and the domain sends only its seven-field projection.
 */
export async function explainForOrder(
  actor: Actor,
  ref: string,
): Promise<OrderExplain | null | 'not_found'> {
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
  const answer = await explainOrder(tl?.entries ?? [], kinds, fixIds, model);
  return { answer, fixes };
}
