// The one route wrapper (architecture 9.8). Every route handler is built with withRoute(); the
// RouteMeta it takes feeds scripts/route-inventory.mjs. Authorisation runs here, never in Next.js
// middleware alone.
import { createHmac } from 'node:crypto';
import type { ZodType } from 'zod';
import type {
  Actor,
  AuditSink,
  Clock,
  Database,
  Id,
  Ids,
  Logger,
  Result,
  Secret,
} from './contracts-stub';
import { err, ok } from './contracts-stub';
import { csrfTokenMatches, originMatches } from './csrf';
import { GENERIC_MESSAGE, errorBody, fieldNames, supportCode } from './errors';
import { securityHeaders } from './headers';
import {
  IDEMPOTENCY_KEY,
  abandonIdempotent,
  beginIdempotent,
  completeIdempotent,
  requestHash,
  scopeOf,
  type IdemScope,
  type StoredResponse,
} from './idempotency';
import { takeToken, type RateRule } from './rate';
import { resolveSessionRecord, type SessionRecord } from './session';

export type { RateRule } from './rate';

export type AuthRule = 'public' | 'buyer' | 'publisher' | 'operator' | 'webhook';

export interface RouteMeta {
  path: string;
  method: 'GET' | 'POST';
  auth: AuthRule;
  csrf: boolean;
  rate: RateRule | null;
  max_body_bytes: number;
  idempotent: boolean;
  risk: 'low' | 'medium' | 'high';
}

export interface RouteContext<I> {
  actor: Actor;
  input: I;
  req_id: string;
  ip_hash: string;
  log: Logger;
}

export interface SecurityDeps {
  db: Database;
  clock: Clock;
  ids: Ids;
  log: Logger;
  audit: AuditSink;
  session_secret: Secret;
  passcode_hash: string | null;
  public_origin: string;
}

export type HttpResult<O> =
  | { status: 200 | 201 | 202; body: O; headers?: Record<string, string> }
  | { status: 303; location: string }
  | {
      status: 400 | 401 | 403 | 404 | 409 | 410 | 413 | 422 | 429 | 503;
      code: string;
      message: string;
    };

export const MAX_BODY_CEILING = 1_048_576;

export function notFoundUnlessOwner<T extends { buyer_id: Id }>(
  row: T | null,
  actor: Actor,
): Result<T, 'not_found'> {
  if (row !== null && actor.kind === 'buyer' && actor.buyer_id === row.buyer_id) return ok(row);
  return err('not_found');
}

const PATH_SHAPE = /^\/[A-Za-z0-9._~\-/[\]]*$/;

function validateMeta(meta: RouteMeta): void {
  const bad = (why: string): never => {
    throw new Error(`withRoute: invalid RouteMeta for ${meta.path}: ${why}`);
  };
  if (!PATH_SHAPE.test(meta.path)) bad('path');
  if (
    !Number.isInteger(meta.max_body_bytes) ||
    meta.max_body_bytes < 1 ||
    meta.max_body_bytes > MAX_BODY_CEILING
  )
    bad('max_body_bytes');
  if (meta.method === 'POST' && meta.auth !== 'webhook' && !meta.csrf) bad('POST needs csrf');
  if (
    meta.idempotent &&
    (meta.method !== 'POST' || meta.auth === 'public' || meta.auth === 'webhook')
  )
    bad('idempotent needs a POST with a session');
  if (meta.rate !== null && !(meta.rate.limit >= 1 && meta.rate.window_ms >= 1)) bad('rate');
}

const json = (status: number, body: unknown, headers: Headers): Response => {
  headers.set('content-type', 'application/json; charset=utf-8');
  return new Response(JSON.stringify(body), { status, headers });
};

function clientIp(req: Request): string {
  // One trusted proxy in front: its entry is the right-most one.
  const xff = req.headers.get('x-forwarded-for');
  const last = xff?.split(',').at(-1)?.trim();
  return last !== undefined && last.length > 0 && last.length <= 64 ? last : 'unknown';
}

async function readBody(req: Request, max: number): Promise<string | 'too_large' | 'bad_encoding'> {
  if (req.body === null) return '';
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      await reader.cancel();
      return 'too_large';
    }
    chunks.push(value);
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks));
  } catch {
    return 'bad_encoding';
  }
}

const SAFE_LOCATION = /^\/(?![/\\])[^\s\\]*$/;
const PROTECTED_HEADERS = new Set([
  'content-type',
  'x-request-id',
  ...Object.keys(securityHeaders('0'.repeat(16))).map((h) => h.toLowerCase()),
]);

export function withRoute<I, O>(
  meta: RouteMeta,
  schema: ZodType<I>,
  handler: (ctx: RouteContext<I>) => Promise<HttpResult<O>>,
): (deps: SecurityDeps) => (req: Request) => Promise<Response> {
  validateMeta(meta);
  const strict = schema as ZodType<I> & { strict?: () => ZodType<I> };
  const parser: ZodType<I> = typeof strict.strict === 'function' ? strict.strict() : schema;

  return (deps) => async (req) => {
    const req_id = deps.ids.nonce();
    const log = deps.log.child({ req_id, route: meta.path });
    const headers = new Headers({
      ...securityHeaders(deps.ids.nonce()),
      'cache-control': 'no-store',
      'x-request-id': req_id,
    });
    const fail = (
      status: number,
      code: string,
      message: string,
      fields?: string[],
      extra?: Record<string, string>,
    ): Response => {
      for (const [k, v] of Object.entries(extra ?? {})) headers.set(k, v);
      return json(status, errorBody(code, message, req_id, fields), headers);
    };

    let idem: IdemScope | null = null;
    try {
      if (req.method !== meta.method) return fail(404, 'not_found', 'Not found.');

      const declared = Number(req.headers.get('content-length') ?? '0');
      if (Number.isFinite(declared) && declared > meta.max_body_bytes)
        return fail(413, 'too_large', 'The request is too large.');

      const ip_hash = createHmac('sha256', deps.session_secret.reveal())
        .update(`ip:${clientIp(req)}`)
        .digest('hex')
        .slice(0, 32);
      const tooMany = (retry_ms: number): Response =>
        fail(429, 'rate_limited', 'Too many requests. Try again later.', undefined, {
          'retry-after': String(Math.max(1, Math.ceil(retry_ms / 1000))),
        });

      if (meta.rate?.per === 'ip' && meta.auth !== 'webhook') {
        const v = await takeToken(deps, meta.rate, ip_hash);
        if (!v.allowed) return tooMany(v.retry_after_ms);
      }

      // Session and authentication rule.
      let record: SessionRecord | null = null;
      let actor: Actor = { kind: 'system' };
      if (meta.auth !== 'webhook') {
        record = await resolveSessionRecord(deps, req.headers.get('cookie'));
        if (meta.auth !== 'public') {
          if (record === null) return fail(401, 'unauthenticated', 'Sign in first.');
          if (record.actor.kind !== meta.auth)
            return fail(403, 'forbidden', 'This account cannot do that.');
          if (record.actor.kind === 'operator' && !record.actor.mfa && meta.method !== 'GET')
            return fail(403, 'mfa_required', 'Operator changes need a second factor.');
        }
        if (record !== null) actor = record.actor;
      }

      if (meta.rate?.per === 'actor') {
        const subject = actorSubject(actor) ?? ip_hash;
        const v = await takeToken(deps, meta.rate, subject);
        if (!v.allowed) return tooMany(v.retry_after_ms);
      }

      // CSRF for state-changing routes.
      if (meta.csrf && meta.method === 'POST') {
        if (!originMatches(req.headers.get('origin'), deps.public_origin))
          return fail(403, 'csrf', 'The request was refused.');
        if (meta.auth !== 'public' && meta.auth !== 'webhook') {
          if (
            record === null ||
            !csrfTokenMatches(req.headers.get('x-csrf-token'), record.csrf_token_hash)
          )
            return fail(403, 'csrf', 'The request was refused.');
        }
      }

      // Input.
      let raw: unknown;
      let rawBody = '';
      if (meta.method === 'POST') {
        const body = await readBody(req, meta.max_body_bytes);
        if (body === 'too_large') return fail(413, 'too_large', 'The request is too large.');
        if (body === 'bad_encoding')
          return fail(400, 'bad_request', 'The request could not be read.');
        rawBody = body;
        if (body.trim() === '') raw = {};
        else {
          try {
            raw = JSON.parse(body);
          } catch {
            return fail(400, 'bad_request', 'The request body is not valid JSON.');
          }
        }
      } else {
        raw = Object.fromEntries(new URL(req.url).searchParams);
      }
      const parsed = parser.safeParse(raw);
      if (!parsed.success)
        return fail(
          422,
          'invalid_input',
          'The request did not match the expected shape.',
          fieldNames(parsed.error.issues),
        );

      // Idempotency.
      if (meta.idempotent) {
        const key = req.headers.get('idempotency-key');
        if (key === null || !IDEMPOTENCY_KEY.test(key))
          return fail(
            422,
            'idempotency_key',
            'An Idempotency-Key header of 8 to 128 safe characters is required.',
          );
        const scope = scopeOf(actor, key);
        if (scope === null) return fail(401, 'unauthenticated', 'Sign in first.');
        const start = await beginIdempotent(
          deps,
          scope,
          meta.path,
          requestHash(meta.path, meta.method, rawBody),
        );
        if (start.kind === 'key_reused')
          return fail(
            422,
            'idempotency_key_reused',
            'That Idempotency-Key was used with a different request.',
          );
        if (start.kind === 'in_progress')
          return fail(409, 'in_progress', 'The first request is still running.');
        if (start.kind === 'replay') return render(start.response, headers, deps, true);
        idem = scope;
      }

      const result = await handler({ actor, input: parsed.data, req_id, ip_hash, log });

      // Webhook limiter counts only rejected requests; a valid webhook is never limited.
      if (
        meta.auth === 'webhook' &&
        meta.rate !== null &&
        'code' in result &&
        [400, 401, 403].includes(result.status)
      ) {
        const v = await takeToken(deps, meta.rate, ip_hash);
        if (!v.allowed) return tooMany(v.retry_after_ms);
      }

      if ('code' in result) {
        if (idem !== null) await abandonIdempotent(deps, idem);
        idem = null;
        return fail(result.status, result.code, result.message);
      }
      const stored = toStored(result);
      const res = render(
        stored,
        headers,
        deps,
        false,
        'headers' in result ? result.headers : undefined,
      );
      if (idem !== null) {
        await completeIdempotent(deps, idem, stored);
        idem = null;
      }
      return res;
    } catch (e) {
      if (idem !== null) {
        try {
          await abandonIdempotent(deps, idem);
        } catch {
          /* the reservation stays pending; a retry gets 409 until it is cleaned up */
        }
      }
      log.log({
        msg: 'route_error',
        level: 'error',
        fields: { err_name: e instanceof Error ? e.name : 'unknown' },
      });
      return json(500, errorBody('internal', GENERIC_MESSAGE, req_id), headers);
    }
  };
}

function actorSubject(actor: Actor): string | null {
  switch (actor.kind) {
    case 'buyer':
      return actor.buyer_id;
    case 'publisher':
      return actor.publisher_id;
    case 'operator':
      return actor.operator_id;
    case 'system':
      return null;
  }
}

function toStored<O>(r: Extract<HttpResult<O>, { status: 200 | 201 | 202 | 303 }>): StoredResponse {
  if (r.status === 303) {
    if (!SAFE_LOCATION.test(r.location)) throw new Error('unsafe redirect location');
    return { status: 303, location: r.location };
  }
  return { status: r.status, body: r.body };
}

function render(
  stored: StoredResponse,
  headers: Headers,
  deps: SecurityDeps,
  replay: boolean,
  extra?: Record<string, string>,
): Response {
  void deps;
  for (const [k, v] of Object.entries(extra ?? {})) {
    if (!PROTECTED_HEADERS.has(k.toLowerCase())) headers.set(k, v);
  }
  if (replay) headers.set('idempotent-replay', 'true');
  if (stored.status === 303) {
    headers.set('location', stored.location);
    return new Response(null, { status: 303, headers });
  }
  return json(stored.status, stored.body, headers);
}

export { supportCode };
