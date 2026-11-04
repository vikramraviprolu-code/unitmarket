// API-A: the seller routes S1 to S5. The publisher is always the owner of the key; no body or query names
// one. Each function is the body of the matching old publisher route, with the same Engine call and the same
// refusals.
import type {
  SellerOfferCreateRequestSchema,
  SellerOfferReviseRequestSchema,
  SellerOfferWithdrawQuerySchema,
} from '@umsbx/contracts';
import type { HttpResult } from '@umsbx/security';
import type { z } from 'zod';
import type { App } from '../../composition.server';
import { offerErrorText } from '../lib/offer-copy';
import { createErrorText } from '../lib/publisher-e1-copy';
import { FORBIDDEN, ownerOf, type Ctx } from './guard';

type Result<T> = Promise<HttpResult<T>>;

function statusOf(code: string): 403 | 404 | 409 | 422 {
  switch (code) {
    case 'not_found':
      return 404;
    case 'conflict':
    case 'already_offered':
    case 'withdrawn':
    case 'not_live':
      return 409;
    case 'invalid_price':
    case 'invalid_options':
    case 'attestation_required':
    case 'invalid_reason':
    case 'no_corridor':
      return 422;
    default:
      return 403;
  }
}

const refusal = (code: string, text: (c: string) => string): HttpResult<never> => {
  const c = code === 'not_publisher' ? 'forbidden' : code;
  return { status: statusOf(c), code: c, message: text(c) };
};

// S1
export async function listOffers(a: App, ctx: Ctx): Result<unknown> {
  const actor = ownerOf(ctx, 'publisher');
  if (actor === null) return FORBIDDEN;
  const r = await a.engine.offers.list(actor);
  if (r === null) return FORBIDDEN;
  return {
    status: 200,
    body: {
      items: r.offers,
      next_cursor: null,
      environment: r.environment,
      offer_max_minor: r.offer_max_minor,
    },
  };
}

// S2
export async function createOffer(
  a: App,
  ctx: Ctx,
  input: z.infer<typeof SellerOfferCreateRequestSchema>,
): Result<unknown> {
  const actor = ownerOf(ctx, 'publisher');
  if (actor === null) return FORBIDDEN;
  const r = await a.engine.offers.create({ actor, ...input });
  return r.ok
    ? { status: 201, body: { offer_id: r.value.offer_id, version: r.value.version } }
    : refusal(r.error.code, createErrorText);
}

// S3
export async function reviseOffer(
  a: App,
  ctx: Ctx,
  offer_id: string,
  input: z.infer<typeof SellerOfferReviseRequestSchema>,
): Result<unknown> {
  const actor = ownerOf(ctx, 'publisher');
  if (actor === null) return FORBIDDEN;
  const r = await a.engine.offers.revise({ actor, offer_id, ...input });
  return r.ok
    ? { status: 200, body: { offer_id: r.value.offer_id, version: r.value.version } }
    : refusal(r.error.code, offerErrorText);
}

// S4
export async function withdrawOffer(
  a: App,
  ctx: Ctx,
  offer_id: string,
  input: z.infer<typeof SellerOfferWithdrawQuerySchema>,
): Result<unknown> {
  const actor = ownerOf(ctx, 'publisher');
  if (actor === null) return FORBIDDEN;
  const r = await a.engine.offers.withdraw({ actor, offer_id, ...input });
  return r.ok
    ? { status: 200, body: { offer_id: r.value.offer_id, version: r.value.version } }
    : refusal(r.error.code, offerErrorText);
}

// S5
export async function listSales(a: App, ctx: Ctx): Result<unknown> {
  const actor = ownerOf(ctx, 'publisher');
  if (actor === null) return FORBIDDEN;
  const items = await a.engine.publisherSales(actor);
  return items === null ? FORBIDDEN : { status: 200, body: { items, next_cursor: null } };
}
