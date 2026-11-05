// API-A: the owner-kind check every lane A route makes first. A key reaches the routes of its own owner kind
// and nothing else: a buyer key (api_client) the buyer routes, a publisher key the seller routes, an
// operator key the operator routes. An agent key reaches none of them (agents come with lane B). The scope
// check in the wrapper already refuses a key that lacks the scope; this closes the owner-kind gap that a
// shared scope (catalogue:read) leaves.
import type { Actor, Principal } from '@umsbx/contracts';
import type { HttpResult } from '@umsbx/security';

export const FORBIDDEN: HttpResult<never> = {
  status: 403,
  code: 'forbidden',
  message: 'This key cannot do that.',
};

export const NOT_FOUND = (what: string): HttpResult<never> => ({
  status: 404,
  code: 'not_found',
  message: `We could not find that ${what}.`,
});

export interface Ctx {
  actor: Actor;
  principal: Principal | null;
}

type Owned<K extends Actor['kind']> = Extract<Actor, { kind: K }>;

export function ownerOf<K extends 'buyer' | 'publisher' | 'operator'>(
  ctx: Ctx,
  kind: K,
): Owned<K> | null {
  return ctx.principal?.kind === 'api_client' && ctx.actor.kind === kind
    ? (ctx.actor as Owned<K>)
    : null;
}

/** A cursor is the base64url of `<tag>:<id>`; anything else, or a wrong tag, is not a cursor. */
export const encodeCursor = (tag: string, id: string): string =>
  Buffer.from(`${tag}:${id}`, 'utf8').toString('base64url');

export function decodeCursor(tag: string, cursor: string): string | null {
  if (!/^[A-Za-z0-9_-]{4,500}$/.test(cursor)) return null;
  const text = Buffer.from(cursor, 'base64url').toString('utf8');
  if (!text.startsWith(`${tag}:`)) return null;
  const id = text.slice(tag.length + 1);
  return id.length > 0 && id.length <= 200 && /^[\x21-\x7e]+$/.test(id) ? id : null;
}

export const BAD_CURSOR: HttpResult<never> = {
  status: 400,
  code: 'bad_cursor',
  message: 'That page marker is not valid. Start again from the first page.',
};

/** INT-SR1: a search refusal (field_not_allowed, bad_cursor, forbidden) as the answer the route gives. */
export function searchRefusal(e: unknown): HttpResult<never> | null {
  if (typeof e !== 'object' || e === null || (e as { name?: unknown }).name !== 'TxnSearchError')
    return null;
  const t = e as { status: 400 | 403; code: string; message: string };
  return { status: t.status, code: t.code, message: t.message };
}
