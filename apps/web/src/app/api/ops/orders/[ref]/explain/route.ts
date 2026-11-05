import { z } from 'zod';
import { withRoute } from '@umsbx/security';
import type { RouteMeta } from '@umsbx/security';
import { explainForOrder } from '../../../../../../composition/assist';
import { explainPanelView } from '../../../../../../lib/explain-view';
import { securityDeps } from '../../../../../../server/access';

// INT-GA / GA.4: "explain this problem order". Operators only. A GET (F13): it changes no state, and the model sees
// only the identity-free projection of the order's steps and its alert kinds. `explain` is null when the order is not
// in the `attention` group. The answer is plain text; its one action is a link to the catalogue fix page. The text is
// never logged.
export const routeMeta: RouteMeta = {
  path: '/api/ops/orders/[ref]/explain',
  method: 'GET',
  auth: 'operator',
  csrf: false,
  rate: { name: 'ops_explain', per: 'actor', limit: 10, window_ms: 60_000 },
  max_body_bytes: 1024,
  idempotent: false,
  risk: 'low',
};

const Input = z.object({ ref: z.string().min(1).max(200) }).strict();

interface Explained {
  explain: {
    what_happened: string;
    safe_now: string;
    action_id: string;
    button: { href: string; label: string } | null;
  } | null;
}

export const GET = withRoute(routeMeta, Input, async ({ actor, input }) => {
  if (actor.kind !== 'operator')
    return { status: 403, code: 'forbidden', message: 'This account cannot do that.' };
  const r = await explainForOrder(actor, input.ref);
  if (r === 'not_found') return { status: 404, code: 'not_found', message: 'No such order.' };
  const body: Explained =
    r === null
      ? { explain: null }
      : { explain: { ...explainPanelView(r.answer, r.fixes), action_id: r.answer.action_id } };
  return { status: 200, body };
})(securityDeps);
