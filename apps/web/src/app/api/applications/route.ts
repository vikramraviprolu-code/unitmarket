import { z } from 'zod';
import { withRoute } from '@umsbx/security';
import type { RouteMeta } from '@umsbx/security';
import { app, securityDeps } from '../../../server/access';
import { applyErrorText } from '../../../lib/apply-copy';

// PUB-APPLY: the one public write. Anyone may leave an application; it creates an applicant record only (a
// publisher with status applied, no payee, no offers, no account, no sign in). Public auth, so no session is
// needed and none is created: this handler reads no cookie and sets none. CSRF here is the origin check. The
// body is strict and small. 20 requests an hour per address here (every kind of request, refused ones too),
// and 5 applications an hour per hashed address in the engine. The answer is the reference and nothing else.
export const routeMeta: RouteMeta = {
  path: '/api/applications',
  method: 'POST',
  auth: 'public',
  csrf: true,
  rate: { name: 'apply-request', per: 'ip', limit: 20, window_ms: 3_600_000 },
  max_body_bytes: 2048,
  idempotent: false,
  risk: 'medium',
};

const Input = z
  .object({
    display_name: z.string().min(1).max(200),
    country: z.string().min(1).max(10),
    note: z.string().min(1).max(400),
    // The honeypot: a person leaves it empty. A filled one gets the normal answer and nothing is stored.
    website: z.string().max(200).optional(),
  })
  .strict();

export const POST = withRoute(routeMeta, Input, async ({ input, ip_hash }) => {
  const r = await (
    await app()
  ).engine.applyToPublish({
    display_name: input.display_name,
    country: input.country,
    note: input.note,
    website: input.website ?? '',
    ip_hash,
  });
  if (r.ok) return { status: 200, body: { reference: r.reference } };
  const message = applyErrorText(r.code);
  switch (r.code) {
    case 'rate_limited':
      return { status: 429, code: r.code, message };
    case 'busy':
      return { status: 503, code: r.code, message };
    default:
      return { status: 422, code: 'invalid_input', message };
  }
})(securityDeps);
