// Content route (P13, P14): streams through planServe; no URL to leak. withRoute does the
// authorisation, rate limit and headers; the stream is attached afterwards to its 200 answer.
import { z } from 'zod';
import { withRoute } from '@umsbx/security';
import type { RouteMeta } from '@umsbx/security';
import { app, securityDeps } from '../../../server/access';
import { currentSessionId } from '../../../server/session';

export const routeMeta: RouteMeta = {
  path: '/c/[token]',
  method: 'GET',
  auth: 'buyer',
  csrf: false,
  rate: { name: 'content', per: 'actor', limit: 60, window_ms: 3_600_000 },
  max_body_bytes: 1024,
  idempotent: false,
  risk: 'medium',
};

const Input = z
  .object({ token: z.string().min(1).max(600), mode: z.enum(['download', 'read']).optional() })
  .strict();

type Served = { headers: Record<string, string>; stream: ReadableStream<Uint8Array> };
const served = new Map<string, Served>();

function hardened(res: Response): Response {
  res.headers.set('Cache-Control', 'private, no-store');
  res.headers.set('Referrer-Policy', 'no-referrer');
  return res;
}

type Call = { params?: Promise<Record<string, string>> | Record<string, string> };

// Attaches the stream to withRoute's 200 answer; every other answer passes through unchanged.
function withStream(guarded: (req: Request, call?: Call) => Promise<Response>) {
  return async (req: Request, call?: Call): Promise<Response> => {
    const res = hardened(await guarded(req, call));
    const id = res.headers.get('x-request-id');
    const plan = id === null ? undefined : served.get(id);
    if (id !== null) served.delete(id);
    if (res.status !== 200 || plan === undefined) return res;
    const headers = new Headers(res.headers);
    for (const [k, v] of Object.entries(plan.headers)) headers.set(k, v);
    return new Response(plan.stream, { status: 200, headers });
  };
}

export const GET = withStream(
  withRoute(routeMeta, Input, async ({ actor, input, req_id }) => {
    const session_id = await currentSessionId(actor);
    const r = await (
      await app()
    ).engine.serve({
      token: input.token,
      actor,
      mode: input.mode ?? 'read',
      ...(session_id !== undefined ? { session_id } : {}),
    });
    if (r.ok) {
      served.set(req_id, { headers: r.headers, stream: r.stream });
      return { status: 200, body: { ok: true } };
    }
    switch (r.code) {
      case 'window_ended':
      case 'not_available':
      case 'expired':
        return { status: 403, code: r.code, message: 'This item can no longer be opened.' };
      case 'store_unavailable':
        return {
          status: 503,
          code: 'store_unavailable',
          message: 'The content is temporarily unavailable. You have not lost time.',
        };
      default:
        // bad_token, not_found and another buyer's link all answer alike.
        return { status: 404, code: 'not_found', message: 'We could not find that item.' };
    }
  })(securityDeps),
);
