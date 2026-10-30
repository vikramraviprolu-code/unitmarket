// PUB-A2 test helper: an offline app with a named operator (second factor), the unverified demo
// operator, a publisher session per seeded publisher and a call helper for the two payee routes.
// Merchant ids here are fictional. Nothing reads the environment.
import { createSession } from '@umsbx/security';
import type { Actor } from '@umsbx/contracts';
import type { App } from '../composition.server';
import { call } from './support';
import type { Session } from './support';
import { bootRefundWorld } from './refund-support';
import type { RefundWorld } from './refund-support';

type Handler = (
  req: Request,
  ctx?: { params: Promise<Record<string, string>> },
) => Promise<Response>;

export interface PayeeWebWorld {
  refund: RefundWorld;
  app: App;
  logs: string[];
  /** Publisher sessions by slug. */
  pub: Record<'harbour-ledger' | 'quayside-gazette' | 'northfield-quarterly', Session>;
  pubId: Record<'harbour-ledger' | 'quayside-gazette' | 'northfield-quarterly', string>;
  request: typeof import('./app/api/publisher/payee-requests/route');
  decide: typeof import('./app/api/ops/payee-decisions/route');
}

const SLUGS = ['harbour-ledger', 'quayside-gazette', 'northfield-quarterly'] as const;

export async function bootPayeeWorld(): Promise<PayeeWebWorld> {
  const logs: string[] = [];
  const refund = await bootRefundWorld({}, { log_sink: (l) => logs.push(l) });
  const pub = {} as PayeeWebWorld['pub'];
  const pubId = {} as PayeeWebWorld['pubId'];
  for (const slug of SLUGS) {
    const id = (
      await refund.app.db.query<{ id: string }>('SELECT id FROM publishers WHERE slug = $1', [slug])
    ).rows[0]!.id;
    const actor: Actor = { kind: 'publisher', publisher_id: id };
    const s = await createSession(refund.app.security, actor);
    pub[slug] = { cookie: s.cookie.split(';')[0] ?? '', csrf: s.csrf_token };
    pubId[slug] = id;
  }
  return {
    refund,
    app: refund.app,
    logs,
    pub,
    pubId,
    request: await import('./app/api/publisher/payee-requests/route'),
    decide: await import('./app/api/ops/payee-decisions/route'),
  };
}

export const postRequest = (
  w: PayeeWebWorld,
  session: Session | null,
  body: unknown,
  o: { csrf?: boolean; headers?: Record<string, string> } = {},
): Promise<Response> =>
  call(w.request.POST as Handler, {
    url: '/api/publisher/payee-requests',
    method: 'POST',
    body,
    session,
    ...(o.csrf === undefined ? {} : { csrf: o.csrf }),
    ...(o.headers === undefined ? {} : { headers: o.headers }),
  });

export const postDecision = (
  w: PayeeWebWorld,
  session: Session | null,
  body: unknown,
  o: { csrf?: boolean } = {},
): Promise<Response> =>
  call(w.decide.POST as Handler, {
    url: '/api/ops/payee-decisions',
    method: 'POST',
    body,
    session,
    ...(o.csrf === undefined ? {} : { csrf: o.csrf }),
  });
