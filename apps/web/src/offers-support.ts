// PUB-B test helper: an offline app with a publisher session per seeded publisher, the two buyers and
// call helpers for the offer routes. Merchant ids and secrets are fictional; nothing reads the environment.
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

const SLUGS = ['harbour-ledger', 'quayside-gazette', 'northfield-quarterly'] as const;
type Slug = (typeof SLUGS)[number];

export interface OffersWebWorld {
  refund: RefundWorld;
  app: App;
  logs: string[];
  pub: Record<Slug, Session>;
  pubId: Record<Slug, string>;
  actor: Record<Slug, Actor>;
  revise: typeof import('./app/api/publisher/offers/revise/route');
  withdraw: typeof import('./app/api/publisher/offers/withdraw/route');
}

/** `demo_prices` is off unless asked for, so tests see the seed prices (40, 90, 300, 450 and the rest). */
export async function bootOffersWorld(
  o: { demo_prices?: boolean; env?: Record<string, string> } = {},
): Promise<OffersWebWorld> {
  const logs: string[] = [];
  const refund = await bootRefundWorld(o.env ?? {}, {
    log_sink: (l) => logs.push(l),
    ...(o.demo_prices === true ? { test_seed: { demo_prices: true } } : {}),
  });
  const pub = {} as OffersWebWorld['pub'];
  const pubId = {} as OffersWebWorld['pubId'];
  const actor = {} as OffersWebWorld['actor'];
  for (const slug of SLUGS) {
    const id = (
      await refund.app.db.query<{ id: string }>('SELECT id FROM publishers WHERE slug = $1', [slug])
    ).rows[0]!.id;
    actor[slug] = { kind: 'publisher', publisher_id: id };
    const s = await createSession(refund.app.security, actor[slug]);
    pub[slug] = { cookie: s.cookie.split(';')[0] ?? '', csrf: s.csrf_token };
    pubId[slug] = id;
  }
  return {
    refund,
    app: refund.app,
    logs,
    pub,
    pubId,
    actor,
    revise: await import('./app/api/publisher/offers/revise/route'),
    withdraw: await import('./app/api/publisher/offers/withdraw/route'),
  };
}

export const postRevise = (
  w: OffersWebWorld,
  session: Session | null,
  body: unknown,
  o: { csrf?: boolean } = {},
): Promise<Response> =>
  call(w.revise.POST as Handler, {
    url: '/api/publisher/offers/revise',
    method: 'POST',
    body,
    session,
    ...(o.csrf === undefined ? {} : { csrf: o.csrf }),
  });

export const postWithdraw = (
  w: OffersWebWorld,
  session: Session | null,
  body: unknown,
  o: { csrf?: boolean } = {},
): Promise<Response> =>
  call(w.withdraw.POST as Handler, {
    url: '/api/publisher/offers/withdraw',
    method: 'POST',
    body,
    session,
    ...(o.csrf === undefined ? {} : { csrf: o.csrf }),
  });

export const both = (keep: number, online: number) => [
  { option: 'keep_retrieve', price_minor: keep },
  { option: 'online_read', price_minor: online },
];

export const TIDE = 'ofr_harbour-ledger_tide-tables';
export const FERRY = 'ofr_harbour-ledger_ferry-timetables';
export const FEES = 'ofr_harbour-ledger_harbour-fees';
export const QUAY = 'ofr_quayside-gazette_quay-walk';
