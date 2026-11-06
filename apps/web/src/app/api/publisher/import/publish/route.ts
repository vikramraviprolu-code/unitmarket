import { z } from 'zod';
import { withRoute } from '@umsbx/security';
import type { HttpResult, RouteMeta } from '@umsbx/security';
import { app, securityDeps } from '../../../../../server/access';
import { importErrorText, importStatusOf } from '../../../../../lib/web-import-copy';

// POB-I1 (D-089, J9): the publisher publishes the shown items of a batch. The attestation of rights is given
// once per batch (the field is always sent; it only matters the first time). Each item is its own
// transaction; the answer counts what was published and what was left. The body has the batch, the tick and
// optionally the items to publish.
export const routeMeta: RouteMeta = {
  path: '/api/publisher/import/publish',
  method: 'POST',
  auth: 'publisher',
  csrf: true,
  rate: { name: 'import_publish', per: 'actor', limit: 20, window_ms: 3_600_000 },
  max_body_bytes: 16_384,
  idempotent: false,
  risk: 'high',
};

const Input = z
  .object({
    batch_id: z.string().min(1).max(200),
    attestation: z.boolean(),
    item_ids: z.array(z.string().min(1).max(200)).max(100).optional(),
  })
  .strict();

/** An error value of the engine as the answer of the route: a fixed code and a plain sentence. */
function refused(code: string): Extract<HttpResult<never>, { code: string }> {
  return { status: importStatusOf(code), code, message: importErrorText(code) };
}

export const POST = withRoute(routeMeta, Input, async ({ actor, input }) => {
  const r = await (
    await app()
  ).engine.webImport.publish({
    actor,
    batch_id: input.batch_id,
    attestation: input.attestation,
    ...(input.item_ids === undefined ? {} : { item_ids: input.item_ids }),
  });
  if (!r.ok) return refused(r.error.code);
  return { status: 200, body: r.value };
})(securityDeps);
