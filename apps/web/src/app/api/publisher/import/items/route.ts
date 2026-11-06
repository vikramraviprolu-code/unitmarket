import { z } from 'zod';
import { withRoute } from '@umsbx/security';
import type { HttpResult, RouteMeta } from '@umsbx/security';
import { app, securityDeps } from '../../../../../server/access';
import { importErrorText, importStatusOf } from '../../../../../lib/web-import-copy';

// POB-I1 (D-089, J8): the publisher edits one staged item: the title, its own price, and whether it is shown.
// One call, one transaction. The body has these fields and the item id; no state, currency, reference or
// owner can come from the client.
export const routeMeta: RouteMeta = {
  path: '/api/publisher/import/items',
  method: 'POST',
  auth: 'publisher',
  csrf: true,
  rate: { name: 'import_item', per: 'actor', limit: 120, window_ms: 60_000 },
  max_body_bytes: 2048,
  idempotent: false,
  risk: 'medium',
};

const Input = z
  .object({
    item_id: z.string().min(1).max(200),
    title: z.string().max(1000).optional(),
    price_minor: z.number().optional(),
    hidden: z.boolean().optional(),
  })
  .strict();

/** An error value of the engine as the answer of the route: a fixed code and a plain sentence. */
function refused(code: string): Extract<HttpResult<never>, { code: string }> {
  return { status: importStatusOf(code), code, message: importErrorText(code) };
}

export const POST = withRoute(routeMeta, Input, async ({ actor, input }) => {
  const r = await (
    await app()
  ).engine.webImport.edit({
    actor,
    item_id: input.item_id,
    ...(input.title === undefined ? {} : { title: input.title }),
    ...(input.price_minor === undefined ? {} : { price_minor: input.price_minor }),
    ...(input.hidden === undefined ? {} : { hidden: input.hidden }),
  });
  if (!r.ok) return refused(r.error.code);
  return { status: 200, body: r.value };
})(securityDeps);
