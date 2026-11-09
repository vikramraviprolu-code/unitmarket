// API-A: the buyer routes B1 to B12 (docs/specs/api-a-endpoints.md). Each function is the body of the
// matching old session route, run for the owner of a bearer key. No rule of its own: the Engine decides.
// What is left out on purpose: the display lines and ceiling lines of the web screens (a client prints its
// own), and anything that needs a browser session (the content link is issued unbound to a session).
import type {
  CatalogueSearchQuerySchema,
  OfferSummary,
  QuoteRequestSchema,
  ApprovalRequestSchema,
  OrderPlaceRequestSchema,
  OrderListQuerySchema,
} from '@umsbx/contracts';
import { parseTxnQuery } from '@umsbx/contracts';
import type { HttpResult } from '@umsbx/security';
import type { z } from 'zod';
import {
  buyerLine,
  checkScope,
  exportName,
  exportTransactions,
  filterLibrary,
  isPlainLibraryQuery,
  listTransactions,
  parseLibraryQuery,
  queryHash,
  searchOffers,
  txnCsv,
} from '../../composition.server';
import type { LibraryFacts } from '../../composition.server';
import type { App, OfferPage } from '../../composition.server';
import {
  CORRIDOR_UNSUPPORTED_TEXT,
  corridorUnsupportedText,
  MIXED_CURRENCY_TEXT,
  PUBLISHER_UNVERIFIED_TEXT,
  TOO_MANY_PUBLISHERS_TEXT,
} from '../lib/composite-copy';
import { CANCEL_ANSWER } from '../lib/order-actions';
import {
  BAD_CURSOR,
  FORBIDDEN,
  NOT_FOUND,
  decodeCursor,
  encodeCursor,
  ownerOf,
  searchRefusal,
  type Ctx,
} from './guard';

type Result<T> = Promise<HttpResult<T>>;
const DEFAULT_LIMIT = 20;
const LIBRARY_PAGE = 25;

/** The buyer view of an offer: the page without the renegotiation floor, with the lowest price named. */
export function toSummary(o: OfferPage): OfferSummary {
  const prices = o.options.map((p) => p.price_minor);
  return {
    offer_id: o.offer_id,
    title: o.title,
    abstract: o.abstract,
    publisher: o.publisher,
    publisher_slug: o.publisher_slug,
    offer_code: o.offer_code,
    language: o.language,
    bytes: o.bytes,
    currency: o.currency as OfferSummary['currency'],
    options: o.options,
    min_price_minor: prices.length === 0 ? 0 : Math.min(...prices),
    renegotiation_allowed: o.renegotiation_allowed,
    rights: o.rights,
  };
}

// B1
export async function searchCatalogue(
  a: App,
  ctx: Ctx,
  q: z.infer<typeof CatalogueSearchQuerySchema>,
): Result<unknown> {
  if (ownerOf(ctx, 'buyer') === null) return FORBIDDEN;
  const offers = (await a.engine.listOffers()).filter((o) => o.on_sale);
  const found = searchOffers(
    offers.map((o) => ({ ...toSummary(o), status: 'authorised' })),
    {
      ...(q.q !== undefined ? { q: q.q } : {}),
      ...(q.publisher !== undefined ? { publisher: q.publisher } : {}),
      ...(q.max_price !== undefined ? { max_price_minor: q.max_price } : {}),
    },
  );
  // The cursor is the id of the last offer shown; the order is deterministic, so the next page follows it.
  let start = 0;
  if (q.cursor !== undefined) {
    const after = decodeCursor('s1', q.cursor);
    const at = after === null ? -1 : found.findIndex((x) => x.offer_id === after);
    if (at < 0) return BAD_CURSOR;
    start = at + 1;
  }
  const limit = q.limit ?? DEFAULT_LIMIT;
  const page = found.slice(start, start + limit);
  const more = start + limit < found.length;
  return {
    status: 200,
    body: {
      items: page.map((x) => {
        const { status, ...rest } = x;
        void status;
        return rest;
      }),
      next_cursor:
        more && page.length > 0 ? encodeCursor('s1', page[page.length - 1]!.offer_id) : null,
    },
  };
}

// B2
export async function getOffer(a: App, ctx: Ctx, id: string): Result<unknown> {
  if (ownerOf(ctx, 'buyer') === null) return FORBIDDEN;
  const offer = (await a.engine.listOffers()).find((o) => o.offer_id === id && o.on_sale);
  return offer === undefined ? NOT_FOUND('offer') : { status: 200, body: toSummary(offer) };
}

// B3
export async function createBrief(a: App, ctx: Ctx, input: { need: string }): Result<unknown> {
  const actor = ownerOf(ctx, 'buyer');
  if (actor === null) return FORBIDDEN;
  if (!(await a.engine.aiEnabled()))
    return {
      status: 503,
      code: 'ai_off',
      message: 'Finding articles for a need is paused. You can still open an article link.',
    };
  const r = await a.engine.parseNeed({ actor, text: input.need });
  if (r.ok) return { status: 200, body: r.value };
  return r.error.code === 'too_long'
    ? { status: 422, code: 'too_long', message: 'Please shorten your need to 2000 characters.' }
    : {
        status: 422,
        code: 'unparseable',
        message: 'We could not read that need. Try fewer words.',
      };
}

// B4: the brief is read again from the store, by id and by buyer. Another buyer's brief is a 404.
export async function discoverBrief(a: App, ctx: Ctx, brief_id: string): Result<unknown> {
  const actor = ownerOf(ctx, 'buyer');
  if (actor === null) return FORBIDDEN;
  const row = (
    await a.db.query<{ raw_text: string }>(
      'SELECT raw_text FROM briefs WHERE id = $1 AND buyer_id = $2',
      [brief_id, actor.buyer_id],
    )
  ).rows[0];
  if (row === undefined) return NOT_FOUND('brief');
  const d = await a.engine.discover({ actor, text: row.raw_text });
  if (d.ai_off)
    return {
      status: 503,
      code: 'ai_off',
      message: 'Finding articles for a need is paused. You can still open an article link.',
    };
  const r = d.result;
  if ('parse_error' in r)
    return r.parse_error === 'too_long'
      ? { status: 422, code: 'too_long', message: 'Please shorten your need to 2000 characters.' }
      : {
          status: 422,
          code: 'unparseable',
          message: 'We could not read that need. Try fewer words.',
        };
  if (!r.ok) return NOT_FOUND('need');
  return { status: 200, body: r.value };
}

// B5
export async function createQuote(
  a: App,
  ctx: Ctx,
  input: z.infer<typeof QuoteRequestSchema>,
): Result<unknown> {
  const actor = ownerOf(ctx, 'buyer');
  if (actor === null) return FORBIDDEN;
  const r = await a.engine.quote({
    offer: { publisher_slug: input.publisher, offer_code: input.offer },
    actor,
    source: 'direct',
    ...(input.option !== undefined ? { option: input.option } : {}),
    ...(input.ceiling_minor !== undefined ? { ceiling_minor: input.ceiling_minor } : {}),
    ...(input.proposed_minor !== undefined ? { proposed_minor: input.proposed_minor } : {}),
  });
  if (!r.ok)
    return r.error.code === 'unknown_offer'
      ? { status: 404, code: 'not_found', message: 'That offer does not exist.' }
      : {
          status: 422,
          code: 'invalid_input',
          message: 'Check the amount and option and try again.',
        };
  // An open unpaid order is named, with its reference.
  if (r.value.kind === 'no_match' && r.value.reason === 'unpaid_order') {
    const order_ref = await a.engine.unpaidOrderRef({
      publisher: input.publisher,
      offer: input.offer,
      actor,
    });
    return { status: 200, body: order_ref === null ? r.value : { ...r.value, order_ref } };
  }
  return { status: 200, body: r.value };
}

const APPROVAL_STATUS: Record<string, 400 | 403 | 404 | 409 | 410 | 422> = {
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
const APPROVAL_TEXT: Record<string, string> = {
  quote_expired: 'That quote expired. Please start again to see the current price.',
  offer_changed: 'The offer changed. Please start again to see the current price.',
  consent_missing: 'Please accept the terms to continue.',
  unknown_selection: 'We could not find that selection.',
  mixed_currency: MIXED_CURRENCY_TEXT,
  corridor_unsupported: CORRIDOR_UNSUPPORTED_TEXT,
  publisher_unverified: PUBLISHER_UNVERIFIED_TEXT,
  too_many_publishers: TOO_MANY_PUBLISHERS_TEXT,
};

// B6: the token is returned in the body and nowhere else.
export async function createApproval(
  a: App,
  ctx: Ctx,
  input: z.infer<typeof ApprovalRequestSchema>,
): Result<unknown> {
  const actor = ownerOf(ctx, 'buyer');
  if (actor === null) return FORBIDDEN;
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
  const r = await a.engine.requestApproval({ actor, selection, consent: input.consent });
  if (!r.ok)
    return {
      status: APPROVAL_STATUS[r.error.code] ?? 422,
      code: r.error.code,
      message:
        r.error.code === 'corridor_unsupported'
          ? corridorUnsupportedText(selection.kind === 'proposal' ? selection.offer_ids.length : 1)
          : (APPROVAL_TEXT[r.error.code] ?? 'We could not prepare that approval.'),
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
}

// B7
export async function placeOrder(
  a: App,
  ctx: Ctx,
  input: z.infer<typeof OrderPlaceRequestSchema>,
): Result<unknown> {
  const actor = ownerOf(ctx, 'buyer');
  if (actor === null) return FORBIDDEN;
  const r = await a.engine.payments.placeOrder({ ...input, actor });
  if (r.ok) return { status: 201, body: r.value };
  const e = r.error;
  if (e.code === 'order_open')
    return { status: 409, code: 'order_open', message: 'You already have an open order for this.' };
  if (e.code === 'already_owned')
    return {
      status: 409,
      code: 'already_owned',
      message: 'You already have this. Nothing was charged.',
    };
  if (e.code === 'payee_unavailable')
    return {
      status: 409,
      code: 'payee_unavailable',
      message: 'This publisher cannot take payment right now. Nothing was charged.',
    };
  if (e.code === 'checkout_off')
    return {
      status: 503,
      code: 'checkout_off',
      message: 'Checkout is paused. Nothing was charged.',
    };
  return { status: e.http, code: 'approval', message: 'That approval can no longer be used.' };
}

// B8: a read of the buyer's own orders, newest first. INT-SR1: a call with no filter, with or without a
// `limit`, and with no cursor or an old `o1` cursor, is answered as before (the cursor is the id of the last
// order shown; the existing B8 contract test pages that way with `limit=1`). Any TxnQuery filter, or a new
// cursor, switches to keyset paging over the lines (default 25, max 100); an `o1` cursor sent with a filter
// is `bad_cursor`.
export async function listOrders(
  a: App,
  ctx: Ctx,
  q: z.infer<typeof OrderListQuerySchema>,
): Result<unknown> {
  const actor = ownerOf(ctx, 'buyer');
  if (actor === null) return FORBIDDEN;
  const parsed = parseTxnQuery(q);
  const keys = Object.keys(parsed);
  const filters = keys.filter((k) => k !== 'limit' && k !== 'cursor');
  const oldCursor = parsed.cursor !== undefined && decodeCursor('o1', parsed.cursor) !== null;
  const legacy = filters.length === 0 && (parsed.cursor === undefined || oldCursor);
  if (!legacy) {
    const now = a.security.clock.now();
    try {
      const r = await listTransactions(a.db, actor, q, { now });
      return {
        status: 200,
        body: { items: r.rows.map((row) => buyerLine(row, now)), next_cursor: r.next_cursor },
      };
    } catch (e) {
      const refused = searchRefusal(e);
      if (refused !== null) return refused;
      throw e;
    }
  }
  try {
    checkScope(actor, q);
  } catch (e) {
    const refused = searchRefusal(e);
    if (refused !== null) return refused;
    throw e;
  }
  return legacyOrders(
    a,
    actor.buyer_id,
    Math.min(parsed.limit ?? DEFAULT_LIMIT, 50),
    parsed.cursor,
  );
}

async function legacyOrders(
  a: App,
  buyer_id: string,
  limit: number,
  cursor: string | undefined,
): Result<unknown> {
  let after: string | null = null;
  if (cursor !== undefined) {
    after = decodeCursor('o1', cursor);
    if (after === null) return BAD_CURSOR;
    const known = await a.db.query('SELECT 1 FROM orders WHERE id = $1 AND buyer_id = $2', [
      after,
      buyer_id,
    ]);
    if (known.rows.length === 0) return BAD_CURSOR;
  }
  const rows = (
    await a.db.query<{
      id: string;
      order_ref: string;
      status: string;
      environment: string;
      currency: string;
      total_minor: string | number;
      created_at: unknown;
    }>(
      `SELECT id, order_ref, status, environment, currency, total_minor, created_at FROM orders
        WHERE buyer_id = $1
          AND ($2::text IS NULL OR (created_at, id) < (SELECT created_at, id FROM orders WHERE id = $2))
        ORDER BY created_at DESC, id DESC
        LIMIT $3`,
      [buyer_id, after, limit + 1],
    )
  ).rows;
  const page = rows.slice(0, limit);
  return {
    status: 200,
    body: {
      items: page.map((o) => ({
        order_ref: o.order_ref,
        status: o.status,
        environment: o.environment,
        currency: o.currency,
        total_minor: Number(o.total_minor),
        created_at: new Date(o.created_at as string | number | Date).toISOString(),
      })),
      next_cursor: rows.length > limit ? encodeCursor('o1', page[page.length - 1]!.id) : null,
    },
  };
}

// INT-SR1: the current filter as CSV text in a JSON answer.
export async function exportOrders(
  a: App,
  ctx: Ctx,
  q: z.infer<typeof OrderListQuerySchema>,
): Result<unknown> {
  const actor = ownerOf(ctx, 'buyer');
  if (actor === null) return FORBIDDEN;
  const now = a.security.clock.now();
  try {
    const r = await exportTransactions(a.db, actor, q, { now });
    return {
      status: 200,
      body: {
        filename: exportName('buyer', now),
        csv: txnCsv(
          'buyer',
          r.rows.map((row) => buyerLine(row, now)),
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

// B9: another buyer's order and a missing one answer the same.
export async function getOrder(a: App, ctx: Ctx, order_ref: string): Result<unknown> {
  const actor = ownerOf(ctx, 'buyer');
  if (actor === null) return FORBIDDEN;
  const v = await a.engine.orderView({ order_ref, actor });
  return v === null ? NOT_FOUND('order') : { status: 200, body: v };
}

// B10
export async function cancelOrder(a: App, ctx: Ctx, order_ref: string): Result<unknown> {
  const actor = ownerOf(ctx, 'buyer');
  if (actor === null) return FORBIDDEN;
  const order = await a.engine.orderView({ order_ref, actor });
  if (order === null) return NOT_FOUND('order');
  const r = await a.engine.payments.cancelOrder({ order_id: order.order_id, actor });
  if (r.ok) return { status: 200, body: r.value };
  switch (r.error.code) {
    case 'not_found':
      return NOT_FOUND('order');
    case 'unavailable':
      return { status: 503, code: 'unavailable', message: CANCEL_ANSWER.unavailable };
    case 'payment_started':
      return { status: 409, code: 'payment_started', message: CANCEL_ANSWER.payment_started };
    default:
      return { status: 409, code: 'wrong_state', message: CANCEL_ANSWER.wrong_state };
  }
}

// B11. INT-SR1 (SR1.6): with no parameters, every entry and next_cursor null, as before. Filters: from and to
// (purchased date), seller (name, slug or id), q (item text) and access (available, ended, revoked). A filter,
// a limit or a cursor pages (default 25, max 100); the cursor is bound to the filter and the buyer.
export async function listLibrary(
  a: App,
  ctx: Ctx,
  raw: Record<string, string> = {},
): Result<unknown> {
  const actor = ownerOf(ctx, 'buyer');
  if (actor === null) return FORBIDDEN;
  const all = await a.engine.library({ actor });
  const query = parseLibraryQuery(raw);
  if (isPlainLibraryQuery(query)) return { status: 200, body: { items: all, next_cursor: null } };
  const found = await a.db.query<{
    id: string;
    created_at: unknown;
    publisher_id: string;
    slug: string;
  }>(
    `SELECT e.id, e.created_at, p.id AS publisher_id, p.slug
       FROM entitlements e
       JOIN articles ar ON ar.id = e.article_id
       JOIN publishers p ON p.id = ar.publisher_id
      WHERE e.buyer_id = $1`,
    [actor.buyer_id],
  );
  const facts = new Map<string, LibraryFacts>(
    found.rows.map((r) => [
      r.id,
      {
        created_at: new Date(r.created_at as string | number | Date).toISOString(),
        publisher_id: r.publisher_id,
        publisher_slug: r.slug,
      },
    ]),
  );
  const { cursor, limit, ...filters } = query;
  const hash = queryHash(
    { ...filters, ...(limit !== undefined ? { limit } : {}) } as Parameters<typeof queryHash>[0],
    `library:${actor.buyer_id}`,
  );
  const matching = filterLibrary(all, facts, query);
  let start = 0;
  if (cursor !== undefined) {
    const at = decodeCursor('l1', cursor);
    const dot = at === null ? -1 : at.indexOf('.');
    if (at === null || dot < 0 || at.slice(0, dot) !== hash) return BAD_CURSOR;
    const idx = matching.findIndex((e) => e.entitlement_id === at.slice(dot + 1));
    if (idx < 0) return BAD_CURSOR;
    start = idx + 1;
  }
  const size = limit ?? LIBRARY_PAGE;
  const page = matching.slice(start, start + size);
  const more = start + size < matching.length;
  return {
    status: 200,
    body: {
      items: page,
      next_cursor: more
        ? encodeCursor('l1', `${hash}.${page[page.length - 1]!.entitlement_id}`)
        : null,
    },
  };
}

// B12: the link is not bound to a browser session (a key has none).
export async function issueLibraryLink(a: App, ctx: Ctx, entitlement_id: string): Result<unknown> {
  const actor = ownerOf(ctx, 'buyer');
  if (actor === null) return FORBIDDEN;
  const r = await a.engine.issueLink({ entitlement_id, actor });
  if (r.ok) return { status: 200, body: { url: r.value.url, expires_at: r.value.expires_at } };
  switch (r.error.code) {
    case 'not_found':
      return NOT_FOUND('item');
    case 'window_ended':
      return {
        status: 403,
        code: 'window_ended',
        message: 'The access window for this item has ended.',
      };
    case 'not_available':
      return { status: 403, code: 'not_available', message: 'This item is not ready yet.' };
    default:
      return {
        status: 503,
        code: 'store_unavailable',
        message: 'The content is temporarily unavailable. You have not lost time.',
      };
  }
}
