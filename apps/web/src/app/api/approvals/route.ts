import { z } from 'zod';
import { withRoute } from '@umsbx/security';
import type { RouteMeta } from '@umsbx/security';
import { app, securityDeps } from '../../../server/access';
import { MIXED_CURRENCY_TEXT, TOO_MANY_PUBLISHERS_TEXT } from '../../../lib/composite-copy';

export const routeMeta: RouteMeta = {
  path: '/api/approvals',
  method: 'POST',
  auth: 'buyer',
  csrf: true,
  rate: { name: 'approval', per: 'actor', limit: 10, window_ms: 3_600_000 },
  max_body_bytes: 4096,
  idempotent: false,
  risk: 'high',
};

const Input = z
  .object({
    quote_id: z.string().min(1).max(200).optional(),
    proposal_id: z.string().min(1).max(200).optional(),
    offer_ids: z.array(z.string().min(1).max(200)).min(1).max(5).optional(),
    consent: z.object({ terms: z.boolean(), identity_share: z.boolean() }).strict(),
  })
  .strict();

const STATUS: Record<string, 400 | 403 | 404 | 409 | 410 | 422> = {
  unknown_selection: 404,
  quote_expired: 410,
  offer_changed: 409,
  publisher_unverified: 409,
  mixed_currency: 422,
  corridor_unsupported: 422,
  consent_missing: 422,
  not_owner: 403,
  too_many_items: 422,
  too_many_publishers: 422,
};
const TEXT: Record<string, string> = {
  quote_expired: 'That quote expired. Please start again to see the current price.',
  offer_changed: 'The offer changed. Please start again to see the current price.',
  consent_missing: 'Please accept the terms to continue.',
  unknown_selection: 'We could not find that selection.',
  mixed_currency: MIXED_CURRENCY_TEXT,
  too_many_publishers: TOO_MANY_PUBLISHERS_TEXT,
};

export const POST = withRoute(routeMeta, Input, async ({ actor, input }) => {
  const selection =
    input.quote_id !== undefined
      ? ({ kind: 'quote', quote_id: input.quote_id } as const)
      : input.proposal_id !== undefined && input.offer_ids !== undefined
        ? ({
            kind: 'proposal',
            proposal_id: input.proposal_id,
            offer_ids: input.offer_ids,
          } as const)
        : null;
  if (selection === null)
    return { status: 422, code: 'invalid_input', message: 'Choose a quote or a proposal.' };
  const a = await app();
  const r = await a.engine.requestApproval({ actor, selection, consent: input.consent });
  if (!r.ok)
    return {
      status: STATUS[r.error.code] ?? 422,
      code: r.error.code,
      message: TEXT[r.error.code] ?? 'We could not prepare that approval.',
    };
  const g = r.value;
  return {
    status: 201,
    body: {
      approval_id: g.approval_id,
      token: g.token,
      expires_at: g.expires_at,
      total_minor: g.snapshot.total_minor,
      currency: g.snapshot.currency,
      environment: a.environment,
      content_hash: g.content_hash,
    },
  };
})(securityDeps);
