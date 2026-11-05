import { z } from 'zod';
import { withRoute } from '@umsbx/security';
import type { HttpResult, RouteMeta } from '@umsbx/security';
import { app, securityDeps } from '../../../../../server/access';
import { importErrorText, importStatusOf } from '../../../../../lib/web-import-copy';

// POB-I1 (D-089, J8): progress and review. With a batch it answers the batch (done, total, refused) and its
// items with the price and the buyer price; without one it lists the own batches. Another publisher's batch
// and an id that does not exist both answer 404.
export const routeMeta: RouteMeta = {
  path: '/api/publisher/import/status',
  method: 'GET',
  auth: 'publisher',
  csrf: false,
  rate: { name: 'import_status', per: 'actor', limit: 120, window_ms: 60_000 },
  max_body_bytes: 1024,
  idempotent: false,
  risk: 'low',
};

const Input = z.object({ batch: z.string().min(1).max(200).optional() }).strict();

/** An error value of the engine as the answer of the route: a fixed code and a plain sentence. */
function refused(code: string): Extract<HttpResult<never>, { code: string }> {
  return { status: importStatusOf(code), code, message: importErrorText(code) };
}

export const GET = withRoute(
  routeMeta,
  Input,
  async ({ actor, input }): Promise<HttpResult<unknown>> => {
    const engine = (await app()).engine.webImport;
    if (input.batch === undefined) {
      const list = await engine.batches(actor);
      if (list === null) return refused('not_publisher');
      return { status: 200, body: list };
    }
    const one = await engine.review({ actor, batch_id: input.batch });
    if (one === null) return refused('not_found');
    return { status: 200, body: one };
  },
)(securityDeps);
