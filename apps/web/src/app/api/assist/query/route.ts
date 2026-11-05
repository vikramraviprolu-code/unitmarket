import { z } from 'zod';
import { withRoute } from '@umsbx/security';
import type { RouteMeta } from '@umsbx/security';
import { askAssist } from '../../../../composition/assist';
import { securityDeps } from '../../../../server/access';

// INT-GA / GA.2: plain words to proposed filter chips. Any signed-in buyer, seller or operator (an operator needs the
// second factor: the wrapper refuses an operator POST without it). It changes no state and runs no query: the person
// sees the chips and the dropped fields and applies them. Not idempotent-stored, so no copy of the chips derived from
// the person's words is kept. The text, the chips and the answer are never logged.
export const routeMeta: RouteMeta = {
  path: '/api/assist/query',
  method: 'POST',
  auth: 'owner',
  csrf: true,
  rate: { name: 'assist_query', per: 'actor', limit: 20, window_ms: 60_000 },
  max_body_bytes: 4096,
  idempotent: false,
  risk: 'low',
};

const Input = z.object({ text: z.string().max(500) }).strict();

export const POST = withRoute(routeMeta, Input, async ({ actor, input }) => {
  const r = await askAssist(actor, input.text);
  if (r === null)
    return { status: 403, code: 'forbidden', message: 'This account cannot do that.' };
  return { status: 200, body: { chips: r.chips, dropped: r.dropped } };
})(securityDeps);
