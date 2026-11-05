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
import {
  checkScope,
  exportName,
  exportTransactions,
  isPlainQuery,
  listTransactions,
  sellerLine,
  txnCsv,
} from '../../composition.server';
import { FORBIDDEN, ownerOf, searchRefusal, type Ctx } from './guard';

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

// S5. INT-SR1: with no query parameters the answer is what it was (every sale, next_cursor null); any filter,
// limit or cursor pages by keyset over txn_rows with the seller columns (no buyer, no agent key, no mandate).
export async function listSales(
  a: App,
  ctx: Ctx,
  raw: Record<string, string> = {},
): Result<unknown> {
  const actor = ownerOf(ctx, 'publisher');
  if (actor === null) return FORBIDDEN;
  if (isPlainQuery(raw)) {
    // A refused field is still refused when its value would parse to nothing: the role check reads raw keys.
    try {
      checkScope(actor, raw);
    } catch (e) {
      const refused = searchRefusal(e);
      if (refused !== null) return refused;
      throw e;
    }
    const items = await a.engine.publisherSales(actor);
    return items === null ? FORBIDDEN : { status: 200, body: { items, next_cursor: null } };
  }
  const now = a.security.clock.now();
  try {
    const r = await listTransactions(a.db, actor, raw, { now });
    return {
      status: 200,
      body: { items: r.rows.map((row) => sellerLine(row, now)), next_cursor: r.next_cursor },
    };
  } catch (e) {
    const refused = searchRefusal(e);
    if (refused !== null) return refused;
    throw e;
  }
}

// INT-SR1: the current filter as CSV text in a JSON answer. No buyer column.
export async function exportSales(a: App, ctx: Ctx, raw: Record<string, string>): Result<unknown> {
  const actor = ownerOf(ctx, 'publisher');
  if (actor === null) return FORBIDDEN;
  const now = a.security.clock.now();
  try {
    const r = await exportTransactions(a.db, actor, raw, { now });
    return {
      status: 200,
      body: {
        filename: exportName('seller', now),
        csv: txnCsv(
          'seller',
          r.rows.map((row) => sellerLine(row, now)),
        ),
        truncated: r.truncated,
      },
    };
  } catch (e) {
    const refused = searchRefusal(e);
    if (refused !== null) return refused;
    throw e;
  }
}
