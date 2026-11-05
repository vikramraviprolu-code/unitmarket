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
  Principal,
  Result,
  Scope,
  Secret,
  TraceContext,
} from '@umsbx/contracts';
import { SCOPES, err, ok, toActor } from '@umsbx/contracts';
import { uaFamilyOf, withTraceContext } from '@umsbx/obs';
import { bearerToken, hasScopes, verifyKey } from './apikey';
import { csrfTokenMatches, originMatches, sha256Hex } from './csrf';
import { GENERIC_MESSAGE, errorBody, fieldNames, supportCode } from './errors';
import { securityHeaders } from './headers';
import {
  IDEMPOTENCY_KEY,
  abandonIdempotent,
  beginIdempotent,
  completeIdempotent,
  keyScope,
  requestHash,
  scopeOf,
  type IdemScope,
  type StoredResponse,
} from './idempotency';
import { resetBucket, takeToken, type RateRule } from './rate';
import { SESSION_COOKIE, resolveSessionRecord, type SessionRecord } from './session';

export type { RateRule } from './rate';

/**
 * `owner` (API-W0): a session of any owner kind (buyer, publisher or operator), for the routes that manage
 * a person's own API keys. `apikey` (API-W0): a bearer key, only under /api/v1/, with the scopes it names.
 */
export type AuthRule =
  'public' | 'buyer' | 'publisher' | 'operator' | 'webhook' | 'owner' | 'apikey';

export interface RouteMeta {
  path: string;
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  auth: AuthRule;
  /**
   * API-W0. For `apikey` routes only: the scopes a key must hold, all of them. Non-empty, from the closed
   * scope list. Any other auth rule must not set it.
   */
  scopes?: readonly Scope[] | undefined;
  csrf: boolean;
  rate: RateRule | null;
  /**
   * AI-H. An extra `ip` rule charged next to `rate`, after authentication and BEFORE the actor rule, so a
   * visitor refused here never spends the allowance of a shared actor (the demo buyer personas are shared).
   * It is not charged when no client address is known (no trusted proxy and no remote address): one
   * bucket for every client would let a single visitor starve all of them.
   */
  rate_ip?: RateRule;
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
  /** API-W0. The principal behind a bearer key (agent or api_client), or null on a session or public route. */
  principal: Principal | null;
  /** API-B. The effective scopes of the bearer key (empty on a session or public route). */
  scopes: readonly Scope[];
  input: I;
  /** The id of the live session behind this request, or null (a public route with no session). */
  session_id: string | null;
  req_id: string;
  ip_hash: string;
  /** False when no client address is known (no trusted proxy and no socket address): ip_hash is then one bucket shared by every client. */
  ip_known: boolean;
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
  | {
      status: 200 | 201 | 202;
      body: O;
      headers?: Record<string, string>;
      /**
       * API-W0. When set, this is what the idempotency record stores and a replay returns, instead of
       * `body`. A key-issue answer sets it to the view without the token, so a replay never holds a secret.
       */
      replay_body?: unknown;
    }
  | { status: 303; location: string }
  | {
      status: 400 | 401 | 403 | 404 | 409 | 410 | 413 | 422 | 429 | 500 | 503;
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

const V1_PREFIX = '/api/v1/';
const BEARER_REFUSAL = 'A valid API key is required.';
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
  // API-W0: every state change on a session route needs csrf (POST, PATCH and DELETE); a bearer route has
  // no cookie, so csrf does not apply to it.
  if (meta.method !== 'GET' && meta.auth !== 'webhook' && meta.auth !== 'apikey' && !meta.csrf)
    bad('a state change needs csrf');
  if (
    meta.idempotent &&
    (meta.method === 'GET' || meta.auth === 'public' || meta.auth === 'webhook')
  )
    bad('idempotent needs a state change with a session or a key');
  const v1 = meta.path.startsWith(V1_PREFIX);
  if (v1 && meta.method !== 'GET' && !meta.idempotent)
    bad('a state change under /api/v1 needs idempotent: true');
  if (meta.scopes !== undefined && meta.auth !== 'apikey') bad('scopes are for apikey routes only');
  if (meta.auth === 'apikey') {
    if (!v1) bad('an apikey route lives under /api/v1/');
    if (meta.csrf) bad('an apikey route has no csrf');
    if (
      meta.scopes === undefined ||
      meta.scopes.length === 0 ||
      !meta.scopes.every((sc) => (SCOPES as readonly string[]).includes(sc))
    )
      bad('an apikey route needs one or more known scopes');
    if (meta.rate === null || meta.rate.per !== 'actor')
      bad('an apikey route needs a rate rule per actor (the key id)');
    if (meta.idempotent !== (meta.method !== 'GET'))
      bad('an apikey route is idempotent exactly when it is not a GET');
  }
  if (meta.rate !== null && !(meta.rate.limit >= 1 && meta.rate.window_ms >= 1)) bad('rate');
  if (
    meta.rate_ip !== undefined &&
    (meta.rate_ip.per !== 'ip' || !(meta.rate_ip.limit >= 1 && meta.rate_ip.window_ms >= 1))
  )
    bad('rate_ip must be an ip rule with a positive limit and window');
  if (meta.rate_ip !== undefined && meta.auth === 'webhook')
    bad('rate_ip is not for webhook routes');
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

  return (deps) => {
    const run = async (
      req: Request,
      call: RouteCallContext | undefined,
      via: ViaKey,
    ): Promise<Response> => {
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

        const v1 = meta.path.startsWith(V1_PREFIX);
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
        let principal: Principal | null = null;
        let held: readonly Scope[] = [];
        if (meta.auth === 'apikey') {
          // API-W0. A bearer key and nothing else: the header is parsed strictly, no session cookie may
          // sit next to it, and every failure (malformed, unknown, wrong secret, revoked) is one answer.
          const cookie = req.headers.get('cookie');
          const token = bearerToken(req.headers.get('authorization'));
          if (token === null || (cookie !== null && cookie.includes(SESSION_COOKIE)))
            return fail(401, 'unauthenticated', BEARER_REFUSAL);
          const verified = await verifyKey(deps, token);
          if (!verified.ok) return fail(401, 'unauthenticated', BEARER_REFUSAL);
          principal = verified.value.principal;
          held = verified.value.scopes;
          actor = toActor(principal);
          via.principal = principal;
          via.actor = actor;
          // A key is never a second factor: every MFA-gated operator change refuses an operator key.
          if (actor.kind === 'operator' && meta.method !== 'GET')
            return fail(403, 'mfa_required', 'Operator changes need a second factor.');
        } else if (
          meta.auth !== 'webhook' &&
          meta.path.startsWith(V1_PREFIX) &&
          req.headers.get('authorization') !== null
        ) {
          // A session route under /api/v1 never mixes in a bearer header.
          return fail(401, 'unauthenticated', 'Sign in first.');
        } else if (meta.auth !== 'webhook') {
          // CO-7b: the one route left in maintenance mode never looks a session up (the database is closed).
          record =
            deps.maintenance === true
              ? null
              : await resolveSessionRecord(deps, req.headers.get('cookie'));
          if (meta.auth !== 'public') {
            if (record === null) return fail(401, 'unauthenticated', 'Sign in first.');
            if (meta.auth !== 'owner' && record.actor.kind !== meta.auth)
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

        if (meta.rate_ip !== undefined && clientIp(req, deps, call) !== 'no-address') {
          const v = await takeToken(deps, meta.rate_ip, ip_hash);
          if (!v.allowed) return tooMany(v.retry_after_ms);
        }

        if (meta.rate?.per === 'actor') {
          // A key has its own bucket (its id), so two keys of one owner never share a limit.
          const subject = principal !== null ? principal.key_id : (actorSubject(actor) ?? ip_hash);
          const v = await takeToken(deps, meta.rate, subject);
          if (!v.allowed) return tooMany(v.retry_after_ms);
        }

        // API-W0. The key must hold every scope the route names; the matrix already cut the key's scopes.
        if (meta.auth === 'apikey' && !hasScopes(held, meta.scopes ?? []))
          return fail(403, 'forbidden', 'This key cannot do that.');

        // CSRF for state-changing routes.
        if (meta.csrf && meta.method !== 'GET') {
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
        if (meta.method === 'POST' || meta.method === 'PATCH') {
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
              v1 ? 400 : 422,
              'idempotency_key',
              'An Idempotency-Key header of 8 to 128 safe characters is required.',
            );
          const scope = principal !== null ? keyScope(principal.key_id, key) : scopeOf(actor, key);
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
              v1 ? 409 : 422,
              'idempotency_key_reused',
              'That Idempotency-Key was used with a different request.',
            );
          if (start.kind === 'in_progress')
            return fail(409, 'in_progress', 'The first request is still running.');
          if (start.kind === 'replay') return render(start.response, headers, deps, true);
          idem = scope;
        }

        // INT-TR0: from here the writes of this request carry who made them. The context is opened once the
        // actor is known, so nothing written before authentication is attributed to a guess.
        const routeCtx: RouteContext<I> = {
          actor,
          principal,
          scopes: held,
          input: parsed.data,
          session_id: record?.id ?? null,
          req_id,
          ip_hash,
          ip_known: clientIp(req, deps, call) !== 'no-address',
          log,
        };
        // Maintenance mode never opens the database, so there is nothing to attribute.
        const result =
          deps.maintenance === true
            ? await handler(routeCtx)
            : await withTraceContext(
                (via.trace = requestTrace(deps, req, meta, { req_id, ip_hash, actor, principal })),
                () => handler(routeCtx),
              );

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
          await completeIdempotent(deps, idem, toReplay(result, stored));
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
    return async (req, call) => {
      const via: ViaKey = { principal: null, actor: null, trace: null };
      const res = await run(req, call, via);
      if (via.principal !== null && via.actor !== null) {
        const { principal, actor } = via;
        // The audit row of a bearer request is written in the context of that request.
        if (via.trace !== null)
          await withTraceContext(via.trace, () =>
            auditRequest(deps, meta, principal, actor, res.status),
          );
        else await auditRequest(deps, meta, principal, actor, res.status);
      }
      return res;
    };
  };
}

/** Set by the wrapper once a bearer key is verified; read after the answer to write the audit row. */
interface ViaKey {
  principal: Principal | null;
  actor: Actor | null;
  /** The journal context opened for the request (INT-TR0), once the actor is known. */
  trace: TraceContext | null;
}

/**
 * INT-TR0: the journal context of one request. Ids and enums only. The address is already a keyed hash
 * (`ip_hash`, 32 hex); the User-Agent is reduced to a family and never kept.
 */
function requestTrace(
  deps: SecurityDeps,
  req: Request,
  meta: RouteMeta,
  o: { req_id: string; ip_hash: string; actor: Actor; principal: Principal | null },
): TraceContext {
  const base = {
    id: `ctx_${o.req_id}`,
    at: deps.clock.now().toISOString(),
    req_id: o.req_id,
    ip_hash: o.ip_hash,
    ua_family: uaFamilyOf(req.headers.get('user-agent')),
    job: null,
    tool: null,
  };
  const channel =
    meta.auth === 'webhook' ? 'webhook' : meta.path.startsWith(V1_PREFIX) ? 'api' : 'web';
  if (meta.auth === 'webhook') {
    return {
      ...base,
      channel,
      actor_kind: 'paypal',
      actor_id: null,
      on_behalf_of: null,
      mandate_id: null,
      mfa: false,
      api_key_id: null,
    };
  }
  if (o.principal !== null) {
    const p = o.principal;
    const owner =
      p.kind === 'agent'
        ? p.buyer_id
        : p.owner.kind === 'buyer'
          ? p.owner.buyer_id
          : p.owner.kind === 'publisher'
            ? p.owner.publisher_id
            : p.owner.operator_id;
    return {
      ...base,
      channel,
      actor_kind: p.kind,
      actor_id: p.key_id,
      on_behalf_of: owner,
      mandate_id: p.kind === 'agent' ? p.mandate_id : null,
      mfa: false,
      api_key_id: p.key_id,
    };
  }
  const a = o.actor;
  return {
    ...base,
    channel,
    actor_kind: a.kind,
    actor_id:
      a.kind === 'buyer'
        ? a.buyer_id
        : a.kind === 'publisher'
          ? a.publisher_id
          : a.kind === 'operator'
            ? a.operator_id
            : null,
    on_behalf_of: null,
    mandate_id: null,
    mfa: a.kind === 'operator' ? a.mfa : false,
    api_key_id: null,
  };
}

// API-W0. The wrapper writes its own audit row for an authenticated bearer request (domain code is not
// touched). A failing audit sink is logged and never changes the answer.
async function auditRequest(
  deps: SecurityDeps,
  meta: RouteMeta,
  principal: Principal,
  actor: Actor,
  status: number,
): Promise<void> {
  try {
    await deps.db.transaction((tx) =>
      deps.audit.record(tx, {
        actor,
        action: 'api.request',
        target: null,
        reason: null,
        detail: {
          via_kind: principal.kind,
          via_key_id: principal.key_id,
          route: meta.path,
          method: meta.method,
          status,
        },
      }),
    );
  } catch (e) {
    deps.log.log({
      msg: 'audit_error',
      level: 'error',
      fields: { route: meta.path, err_name: e instanceof Error ? e.name : 'unknown' },
    });
  }
}

function toReplay<O>(
  r: Extract<HttpResult<O>, { status: 200 | 201 | 202 | 303 }>,
  stored: StoredResponse,
): StoredResponse {
  if (r.status === 303 || r.replay_body === undefined) return stored;
  return { status: r.status, body: r.replay_body };
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
