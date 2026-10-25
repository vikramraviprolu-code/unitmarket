import { z } from 'zod';
import { withRoute } from '@umsbx/security';
import type { RouteMeta } from '@umsbx/security';
import { app, securityDeps } from '../../../../server/access';
import { answerFor } from '../../../../server/webhook';

// CO-3: PayPal's webhook. Public (no session, no CSRF), the body is read as raw bytes and never
// parsed before the signature is checked, 64 KiB at most. The limiter counts refused deliveries only
// (COST-3: 60 a minute per address); a valid delivery is never limited. A delivery is a hint: it
// stores one event and makes one read-back due, nothing more (nfr.md P1, P2).
export const routeMeta: RouteMeta = {
  path: '/api/webhooks/paypal',
  method: 'POST',
  auth: 'webhook',
  csrf: false,
  rate: { name: 'webhook-invalid', per: 'ip', limit: 60, window_ms: 60_000 },
  raw: true,
  max_body_bytes: 65_536,
  idempotent: false,
  risk: 'high',
};

const Input = z
  .object({ raw_body: z.string(), headers: z.record(z.string(), z.string()) })
  .strict();

export const POST = withRoute(routeMeta, Input, async ({ input }) =>
  answerFor(await (await app()).engine.webhook(input)),
)(securityDeps);
