import { z } from 'zod';
import { withRoute } from '@umsbx/security';
import type { RouteMeta } from '@umsbx/security';
import { app, securityDeps } from '../../../../../server/access';
import { termsErrorText } from '../../../../../lib/publisher-accounts-copy';

// POB-P1: the publisher accepts the current publisher terms with a real action (D-089). Publisher session, CSRF.
// The body is empty and strict: the publisher and the version both come from the server (the session and the
// current terms version), never from the caller. It needs a claimed account, so a demo persona gets no_account.
// One record per publisher and version; the record is labelled with the username.
export const routeMeta: RouteMeta = {
  path: '/api/publisher/terms/accept',
  method: 'POST',
  auth: 'publisher',
  csrf: true,
  rate: { name: 'publisher_terms_accept', per: 'actor', limit: 10, window_ms: 86_400_000 },
  max_body_bytes: 256,
  idempotent: false,
  risk: 'medium',
};

const Input = z.object({}).strict();

export const POST = withRoute(routeMeta, Input, async ({ actor }) => {
  const r = await (await app()).engine.publisherAccounts.acceptTerms(actor);
  if (r.ok) return { status: 200, body: { terms_version: r.value.terms_version } };
  const code = r.error.code;
  const message = termsErrorText(code);
  switch (code) {
    case 'already_accepted':
      return { status: 409, code, message };
    case 'no_account':
      return { status: 403, code, message };
    case 'invalid_input':
      return { status: 422, code, message };
    default:
      return { status: 403, code: 'forbidden', message };
  }
})(securityDeps);
