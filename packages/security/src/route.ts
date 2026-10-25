// The one route wrapper (architecture 9.8). Every route handler is built with withRoute(); the
// RouteMeta it takes feeds scripts/route-inventory.mjs. Authorisation runs here, never in Next.js
// middleware alone.
//
// Webhook limiter (CO-3): the peek and the charge are two steps, so concurrent refused requests
// from one address can overshoot the 60 a minute by up to the number of connections that address
// holds at once. The overshoot is bounded by the connection count and accepted.
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
} from '@umsbx/contracts';
import { err, ok } from '@umsbx/contracts';
import { csrfTokenMatches, originMatches, sha256Hex } from './csrf';
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
import { resetBucket, takeToken, type RateRule } from './rate';
import { resolveSessionRecord, type SessionRecord } from './session';

export type { RateRule } from './rate';

export type AuthRule = 'public' | 'buyer' | 'publisher' | 'operator' | 'webhook';

export interface RouteMeta {
  path: string;
  method: 'GET' | 'POST';
  auth: AuthRule;
  csrf: boolean;
  rate: RateRule | null;
  /**
   * Name of an input field. With an `ip` rate, the bucket key becomes ip + hash(field value), so
   * failed attempts on one target (a passcode persona, an account) never lock other targets.
   */
  rate_target?: string;
  /**
   * An operator POST needs an MFA session. A route that can only REDUCE what the system may do (the
   * ops stop button) sets this so an operator without a second factor can still press it. It lifts
   * the MFA rule for this route only; the role, session and CSRF rules still apply. Valid on an
   * operator POST route only.
   */
  fail_safe_without_mfa?: boolean;
  max_body_bytes: number;
  idempotent: boolean;
  risk: 'low' | 'medium' | 'high';
  /**
   * CO-3. The handler gets the body as the exact text received (valid UTF-8 or a 400; a byte order
   * mark is kept) and the `paypal-*` request headers, as `{ raw_body, headers }`, and nothing is
   * parsed: a signature over the bytes is checked before any parse. Every refusal then carries an
   * empty JSON body, a wrong method is 405, and the size cap, the method and the limiter stay.
   * Valid on the one public webhook route only (RAW_BODY_ROUTES).
   */
  raw?: boolean;
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
  /** How many reverse proxies sit in front (0 = none: X-Forwarded-For is never trusted). */
  trusted_proxies?: number;
  /**
   * CO-7b (D-037). True while the app runs in maintenance mode (decided once at boot, from the host's
   * flag file). Every route except MAINTENANCE_ROUTES then answers 503 `maintenance` before it reads
   * the method, the session, the body, the limiter or the database. It can only reduce what a route
   * does; nothing here sets it, the composition root supplies it.
   */
  maintenance?: boolean;
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

/** CO-7b. The one route that keeps answering in maintenance mode: the health check (no restart loop). */
export const MAINTENANCE_ROUTES: readonly string[] = ['/healthz'];

/** CO-3. The one route that may declare `raw: true`; checked when withRoute is called. */
export const RAW_BODY_ROUTES: readonly string[] = ['/api/webhooks/paypal'];
const RAW_HEADER_PREFIX = 'paypal-';

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
  if (
    meta.raw === true &&
    (meta.method !== 'POST' ||
      meta.auth !== 'webhook' ||
      meta.csrf ||
      meta.idempotent ||
      meta.rate === null ||
      meta.rate.per !== 'ip' ||
      !RAW_BODY_ROUTES.includes(meta.path))
  )
    bad('raw is for the public webhook route only (POST, webhook auth, no csrf, an ip limiter)');
  if (meta.method === 'POST' && meta.auth !== 'webhook' && !meta.csrf) bad('POST needs csrf');
  if (
    meta.idempotent &&
    (meta.method !== 'POST' || meta.auth === 'public' || meta.auth === 'webhook')
  )
    bad('idempotent needs a POST with a session');
  if (meta.rate !== null && !(meta.rate.limit >= 1 && meta.rate.window_ms >= 1)) bad('rate');
  if (meta.rate_target !== undefined && (meta.rate === null || meta.rate.per !== 'ip'))
    bad('rate_target needs an ip rate');
  if (meta.fail_safe_without_mfa === true && (meta.auth !== 'operator' || meta.method !== 'POST'))
    bad('fail_safe_without_mfa is for operator POST routes only');
  // One route only (BU-2 review B3); scripts/route-inventory.mjs checks the same list statically.
  if (meta.fail_safe_without_mfa === true && meta.path !== '/api/ops/stop')
    bad('fail_safe_without_mfa is allowed on /api/ops/stop only');
}

const json = (status: number, body: unknown, headers: Headers): Response => {
  headers.set('content-type', 'application/json; charset=utf-8');
  return new Response(JSON.stringify(body), { status, headers });
};

// Review 4 M7. The client address for the ip limiter:
//  - trusted_proxies = N > 0: the entry N places from the right of X-Forwarded-For (the one the
//    outermost trusted proxy appended); earlier entries are the client's to forge and are ignored;
//  - otherwise the socket address the composition passes in RouteCallContext.remote_addr;
//  - otherwise one shared 'no-address' bucket. The User-Agent is never used: it is rotated freely.
// A shared bucket can be filled by one client, but the per-target key (rate_target) and the scrypt
// cost bound what that gains an attacker, and it never opens extra attempts.
function clientIp(req: Request, deps: SecurityDeps, call?: RouteCallContext): string {
  const n = deps.trusted_proxies ?? 0;
  if (n > 0) {
    const parts =
      req.headers
        .get('x-forwarded-for')
        ?.split(',')
        .map((p) => p.trim()) ?? [];
    const entry = parts.length >= n ? parts[parts.length - n] : undefined;
    if (entry !== undefined && entry.length > 0 && entry.length <= 64) return entry;
  }
  const remote = call?.remote_addr;
  if (remote !== undefined && remote.length > 0 && remote.length <= 64) return remote;
  return 'no-address';
}

type StrictCapable<I> = ZodType<I> & { strict?: () => ZodType<I> };
function strictParser<I>(meta: RouteMeta, schema: ZodType<I>): ZodType<I> {
  const s = schema as StrictCapable<I>;
  if (typeof s.strict !== 'function')
    throw new Error(
      `withRoute: schema for ${meta.path} cannot be made strict; use z.object(...).strict() (L2)`,
    );
  return s.strict();
}

export interface RouteCallContext {
  /** Next.js dynamic route params (a promise in Next 15). Merged into the input; they win. */
  params?: Record<string, string> | Promise<Record<string, string>>;
  /** The socket address of the peer, from the server runtime. The composition must pass it. */
  remote_addr?: string;
}

async function readBody(
  req: Request,
  max: number,
  keepBom = false,
): Promise<string | 'too_large' | 'bad_encoding'> {
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
    // keepBom: the text must re-encode to the bytes that were signed, so a BOM is not stripped.
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: keepBom }).decode(
      Buffer.concat(chunks),
    );
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
): (deps: SecurityDeps) => (req: Request, call?: RouteCallContext) => Promise<Response> {
  validateMeta(meta);
  const parser = strictParser(meta, schema);

  const raw = meta.raw === true;
  const webhook = meta.auth === 'webhook';

  return (deps) => async (req, call) => {
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
      // CO-3: a raw (webhook) route never says why; the code and message stay in the handler.
      return json(status, raw ? {} : errorBody(code, message, req_id, fields), headers);
    };

    // CO-7b: maintenance mode. First, before anything is read or looked up.
    if (deps.maintenance === true && !MAINTENANCE_ROUTES.includes(meta.path))
      return json(
        503,
        errorBody('maintenance', 'The service is down for maintenance.', req_id),
        headers,
      );

    let idem: IdemScope | null = null;
    try {
      if (req.method !== meta.method)
        return raw
          ? fail(405, 'method_not_allowed', 'Method not allowed.', undefined, {
              allow: meta.method,
            })
          : fail(404, 'not_found', 'Not found.');

      const ip_hash = createHmac('sha256', deps.session_secret.reveal())
        .update(`ip:${clientIp(req, deps, call)}`)
        .digest('hex')
        .slice(0, 32);
      const tooMany = (retry_ms: number): Response =>
        fail(429, 'rate_limited', 'Too many requests. Try again later.', undefined, {
          'retry-after': String(Math.max(1, Math.ceil(retry_ms / 1000))),
        });

      // A webhook route: an address that has used up its refused-delivery tokens is turned away
      // before the body is read and before any signature work (review M2). A valid delivery
      // spends nothing; every refusal spends one (charge below).
      if (webhook && meta.rate !== null) {
        const v = await takeToken(deps, meta.rate, ip_hash, 'peek');
        if (!v.allowed) return tooMany(v.retry_after_ms);
      }
      const charge = async (): Promise<Response | null> => {
        if (!webhook || meta.rate === null) return null;
        const v = await takeToken(deps, meta.rate, ip_hash);
        return v.allowed ? null : tooMany(v.retry_after_ms);
      };
      const refuse = async (
        status: number,
        code: string,
        message: string,
        fields?: string[],
      ): Promise<Response> => (await charge()) ?? fail(status, code, message, fields);

      const declared = Number(req.headers.get('content-length') ?? '0');
      if (Number.isFinite(declared) && declared > meta.max_body_bytes)
        return refuse(413, 'too_large', 'The request is too large.');

      let targetSubject: string | null = null;
      let sharedBucketRetryMs: number | null = null;

      if (meta.rate?.per === 'ip' && meta.auth !== 'webhook' && meta.rate_target === undefined) {
        const v = await takeToken(deps, meta.rate, ip_hash);
        if (!v.allowed) return tooMany(v.retry_after_ms);
      }

      // Session and authentication rule.
      let record: SessionRecord | null = null;
      let actor: Actor = { kind: 'system' };
      if (meta.auth !== 'webhook') {
        // CO-7b: the one route left in maintenance mode never looks a session up (the database is closed).
        record =
          deps.maintenance === true
            ? null
            : await resolveSessionRecord(deps, req.headers.get('cookie'));
        if (meta.auth !== 'public') {
          if (record === null) return fail(401, 'unauthenticated', 'Sign in first.');
          if (record.actor.kind !== meta.auth)
            return fail(403, 'forbidden', 'This account cannot do that.');
          if (
            record.actor.kind === 'operator' &&
            !record.actor.mfa &&
            meta.method !== 'GET' &&
            meta.fail_safe_without_mfa !== true
          )
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
      let input: unknown;
      let rawBody = '';
      if (meta.method === 'POST') {
        const body = await readBody(req, meta.max_body_bytes, raw);
        if (body === 'too_large') return refuse(413, 'too_large', 'The request is too large.');
        if (body === 'bad_encoding')
          return refuse(400, 'bad_request', 'The request could not be read.');
        rawBody = body;
        if (raw) {
          // CO-3: nothing is parsed here. The handler verifies the signature over these bytes first.
          const picked: Record<string, string> = {};
          req.headers.forEach((v, k) => {
            if (k.startsWith(RAW_HEADER_PREFIX)) picked[k] = v;
          });
          input = { raw_body: body, headers: picked };
        } else if (body.trim() === '') input = {};
        else {
          try {
            input = JSON.parse(body);
          } catch {
            return refuse(400, 'bad_request', 'The request body is not valid JSON.');
          }
        }
      } else {
        input = Object.fromEntries(new URL(req.url).searchParams);
      }
      let paramsText = '';
      if (call?.params !== undefined && !raw) {
        const params = await call.params;
        paramsText = JSON.stringify(Object.entries(params).sort(([a], [b]) => (a < b ? -1 : 1)));
        if (typeof input === 'object' && input !== null && !Array.isArray(input))
          input = { ...(input as Record<string, unknown>), ...params };
      }
      const parsed = parser.safeParse(input);
      if (!parsed.success)
        return refuse(
          422,
          'invalid_input',
          'The request did not match the expected shape.',
          fieldNames(parsed.error.issues),
        );

      if (meta.rate?.per === 'ip' && meta.auth !== 'webhook' && meta.rate_target !== undefined) {
        const target = (input as Record<string, unknown> | null)?.[meta.rate_target];
        targetSubject = `${ip_hash}:${sha256Hex(String(target ?? '')).slice(0, 32)}`;
        const v = await takeToken(deps, meta.rate, targetSubject);
        if (!v.allowed) {
          // M3: with no client address the bucket is shared by every client, so an exhausted bucket
          // proves nothing about this caller. The handler still runs; a wrong answer is throttled
          // (429), a right one signs in. With an address the lockout is strict.
          if (clientIp(req, deps, call) !== 'no-address') return tooMany(v.retry_after_ms);
          sharedBucketRetryMs = v.retry_after_ms;
        }
      }

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
          requestHash(
            meta.path,
            meta.method,
            rawBody,
            `${new URL(req.url).pathname}|${paramsText}`,
          ),
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

      // M3: a failure against a spent shared bucket is throttled; a success resets that bucket
      // (only this target's, for the same client key).
      if (targetSubject !== null && meta.rate !== null) {
        if ('code' in result) {
          if (sharedBucketRetryMs !== null) {
            if (idem !== null) await abandonIdempotent(deps, idem);
            idem = null;
            return tooMany(sharedBucketRetryMs);
          }
        } else {
          await resetBucket(deps, meta.rate, targetSubject);
        }
      }

      // Webhook limiter counts every refused answer (400, 401, 403, 503 and the rest, with no
      // opt-out); a valid webhook is never limited.
      if (webhook && 'code' in result) {
        const limited = await charge();
        if (limited !== null) return limited;
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
      // M3: a throw keeps the reservation. Side effects may have happened; a retry gets 409 until
      // the pending row passes IDEMPOTENCY_PENDING_TTL_MS and is reclaimed.
      log.log({
        msg: 'route_error',
        level: 'error',
        fields: { err_name: e instanceof Error ? e.name : 'unknown' },
      });
      return json(500, raw ? {} : errorBody('internal', GENERIC_MESSAGE, req_id), headers);
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
