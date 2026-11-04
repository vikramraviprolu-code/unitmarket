// API-B (handoff page): the buyer's own page for an order an agent placed. In sandbox mode an agent buy
// stops at `buyer_approval_required` and sends the buyer here. Only the buyer who owns the order sees it;
// anyone else gets the same answer as for an order that does not exist. Opening it calls nothing and creates
// no payment: payment starts only when the buyer presses the button, through the existing checkout route.
import type { Actor } from '@umsbx/contracts';
import type { App, OrderView } from '../../composition.server';

/** Order statuses where the buyer can still go on to pay. Paid, abandoned, failed and the rest cannot. */
const PAYABLE = new Set(['created', 'awaiting_buyer']);

export type Handoff =
  | { kind: 'signin'; next: string }
  | { kind: 'not_found' }
  | { kind: 'show'; view: OrderView; can_pay: boolean };

export async function resolveHandoff(app: App, actor: Actor | null, ref: string): Promise<Handoff> {
  if (actor === null || actor.kind !== 'buyer')
    return { kind: 'signin', next: `/buy/agent/${ref}` };
  const view = await app.engine.orderView({ order_ref: ref, actor });
  if (view === null) return { kind: 'not_found' };
  return { kind: 'show', view, can_pay: PAYABLE.has(view.status) };
}
