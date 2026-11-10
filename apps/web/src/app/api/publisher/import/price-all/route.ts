import { z } from 'zod';
import { withRoute } from '@umsbx/security';
import type { HttpResult, RouteMeta } from '@umsbx/security';
import { app, securityDeps } from '../../../../../server/access';
import { importErrorText, importStatusOf } from '../../../../../lib/web-import-copy';

// POB-Q1: one price for every staged item of a finished batch that has none (or every staged item, when
// replace_existing is set), or of every batch from the same address (all_from_source, POB-Q2). One transaction,
// one audit row. Publishing stays its own step.
export const routeMeta: RouteMeta = {
  path: '/api/publisher/import/price-all',
  method: 'POST',
  auth: 'publisher',
  csrf: true,
  rate: { name: 'import_price_all', per: 'actor', limit: 30, window_ms: 60_000 },
  max_body_bytes: 1024,
  idempotent: false,
  risk: 'medium',
};

const Input = z
  .object({
    batch_id: z.string().min(1).max(200),
    price_minor: z.number(),
    replace_existing: z.boolean().optional(),
    all_from_source: z.boolean().optional(),
  })
  .strict();

/** An error value of the engine as the answer of the route: a fixed code and a plain sentence. */
function refused(code: string): Extract<HttpResult<never>, { code: string }> {
  return { status: importStatusOf(code), code, message: importErrorText(code) };
}

export const POST = withRoute(routeMeta, Input, async ({ actor, input }) => {
  const r = await (
    await app()
  ).engine.webImport.priceAll({
    actor,
    batch_id: input.batch_id,
    price_minor: input.price_minor,
    ...(input.replace_existing === undefined ? {} : { replace_existing: input.replace_existing }),
    ...(input.all_from_source === undefined ? {} : { all_from_source: input.all_from_source }),
  });
  if (!r.ok) return refused(r.error.code);
  return { status: 200, body: r.value };
})(securityDeps);
