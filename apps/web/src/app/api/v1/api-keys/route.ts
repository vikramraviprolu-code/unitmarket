import {
  ApiKeyIssueRequestSchema,
  pageOf,
  ApiKeyViewSchema,
  type ApiKeyView,
} from '@umsbx/contracts';
import { issueKey, listKeys, withRoute } from '@umsbx/security';
import type { IssueError, RouteMeta } from '@umsbx/security';
import { z } from 'zod';
import { apiKeyDeps, app, securityDeps } from '../../../../server/access';

// API-W0 (F3): issue and list your own API keys. A signed in person only (a buyer, a publisher or an
// operator with a second factor): a key can never mint, list or revoke keys. The token is shown once, in the
// first answer; the stored and replayed answer is the view without it.
export const routeMetaGET: RouteMeta = {
  path: '/api/v1/api-keys',
  method: 'GET',
  auth: 'owner',
  csrf: false,
  rate: null,
  max_body_bytes: 1024,
  idempotent: false,
  risk: 'medium',
};

export const routeMetaPOST: RouteMeta = {
  path: '/api/v1/api-keys',
  method: 'POST',
  auth: 'owner',
  csrf: true,
  rate: { name: 'api_key_issue', per: 'actor', limit: 10, window_ms: 3_600_000 },
  max_body_bytes: 4096,
  idempotent: true,
  risk: 'high',
};

const REFUSALS: Record<IssueError, { status: 403 | 422; code: string; message: string }> = {
  mfa_required: {
    status: 403,
    code: 'mfa_required',
    message: 'Operator keys need a second factor.',
  },
  scope_not_allowed: {
    status: 403,
    code: 'scope_not_allowed',
    message: 'This account cannot hold one of those scopes.',
  },
  agent_key_needs_buyer: {
    status: 403,
    code: 'forbidden',
    message: 'Only a buyer can have an agent key.',
  },
  unknown_owner: { status: 403, code: 'forbidden', message: 'This account cannot do that.' },
  invalid_scopes: {
    status: 422,
    code: 'invalid_input',
    message: 'The request did not match the expected shape.',
  },
};

export const GET = withRoute(routeMetaGET, z.object({}).strict(), async ({ actor }) => {
  const items: ApiKeyView[] = await listKeys(apiKeyDeps(await app()), actor);
  return { status: 200, body: pageOf(ApiKeyViewSchema).parse({ items, next_cursor: null }) };
})(securityDeps);

export const POST = withRoute(routeMetaPOST, ApiKeyIssueRequestSchema, async ({ actor, input }) => {
  const r = await issueKey(apiKeyDeps(await app()), {
    owner: actor,
    key_kind: input.key_kind,
    scopes: input.scopes,
  });
  if (!r.ok) return REFUSALS[r.error];
  const { token, ...view } = r.value;
  void token;
  return { status: 201, body: r.value, replay_body: view };
})(securityDeps);
