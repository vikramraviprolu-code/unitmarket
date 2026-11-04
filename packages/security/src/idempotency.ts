// Idempotency-Key handling on `api_idempotency`. A row is reserved before the handler runs
// (response = {"pending":true}) and completed on success. A handler that returns a refusal (4xx)
// clears the reservation so the client can retry; a handler that THROWS keeps it, because side
// effects may already have happened. A pending row older than IDEMPOTENCY_PENDING_TTL_MS is
// reclaimed by the next attempt, so a crash never leaves a key stuck at 409 forever.
//
// Contract for money handlers: this layer is the first guard, not the only one. Every handler that
// moves money or calls a provider must be idempotent by its own provider request id (the order or
// payment attempt id sent as PayPal-Request-Id), so a reclaimed or retried attempt cannot pay twice.
import { sha256Hex } from './csrf';
import type { Actor } from '@umsbx/contracts';
import type { SecurityDeps } from './route';

export const IDEMPOTENCY_PENDING_TTL_MS = 5 * 60_000;

export const IDEMPOTENCY_KEY = /^[A-Za-z0-9_-]{8,128}$/;

export type StoredResponse =
  | { status: 200 | 201 | 202; body: unknown; headers?: Record<string, string> }
  | { status: 303; location: string };

export type IdemStart =
  | { kind: 'new' }
  | { kind: 'replay'; response: StoredResponse }
  | { kind: 'key_reused' }
  | { kind: 'in_progress' };

export interface IdemScope {
  actor_kind: string;
  actor_id: string;
  key: string;
}

export function scopeOf(actor: Actor, key: string): IdemScope | null {
  switch (actor.kind) {
    case 'buyer':
      return { actor_kind: 'buyer', actor_id: actor.buyer_id, key };
    case 'publisher':
      return { actor_kind: 'publisher', actor_id: actor.publisher_id, key };
    case 'operator':
      return { actor_kind: 'operator', actor_id: actor.operator_id, key };
    case 'system':
      return null;
  }
}

/** API-W0. A bearer key's reservation is scoped to the key id, so no two keys share a stored answer. */
export function keyScope(key_id: string, key: string): IdemScope {
  return { actor_kind: 'key', actor_id: key_id, key };
}

// Review 4 M8: `extra` carries the real request path and the merged route params, so the same key
// on /orders/A and /orders/B is a different request, not a replay.
export const requestHash = (route: string, method: string, rawBody: string, extra = ''): string =>
  sha256Hex(`${method} ${route}\n${extra}\n${rawBody}`);

const parse = (v: unknown): Record<string, unknown> =>
  (typeof v === 'string' ? JSON.parse(v) : v) as Record<string, unknown>;

export async function beginIdempotent(
  deps: SecurityDeps,
  scope: IdemScope,
  route: string,
  request_sha256: string,
): Promise<IdemStart> {
  const now = deps.clock.now().toISOString();
  const id = `idem_${sha256Hex(`${scope.actor_kind}|${scope.actor_id}|${scope.key}`)}`;
  const inserted = await deps.db.query(
    `INSERT INTO api_idempotency (id, key, actor_kind, actor_id, route, request_sha256, response, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $8)
     ON CONFLICT (actor_kind, actor_id, key) DO NOTHING RETURNING id`,
    [
      id,
      scope.key,
      scope.actor_kind,
      scope.actor_id,
      route,
      request_sha256,
      '{"pending":true}',
      now,
    ],
  );
  if (inserted.rows.length > 0) return { kind: 'new' };
  const res = await deps.db.query<{
    route: string;
    request_sha256: string;
    response: unknown;
    updated_at: unknown;
  }>(
    'SELECT route, request_sha256, response, updated_at FROM api_idempotency WHERE actor_kind = $1 AND actor_id = $2 AND key = $3',
    [scope.actor_kind, scope.actor_id, scope.key],
  );
  const row = res.rows[0];
  if (row === undefined) return { kind: 'in_progress' };
  if (row.route !== route || row.request_sha256 !== request_sha256) return { kind: 'key_reused' };
  const stored = parse(row.response);
  if (stored.pending === true) {
    const age = deps.clock.now().getTime() - Date.parse(String(row.updated_at));
    if (!(age > IDEMPOTENCY_PENDING_TTL_MS)) return { kind: 'in_progress' };
    // Reclaim: only one concurrent attempt wins the conditional update.
    const taken = await deps.db.query(
      `UPDATE api_idempotency SET updated_at = $4
       WHERE actor_kind = $1 AND actor_id = $2 AND key = $3
         AND response @> '{"pending":true}'::jsonb AND updated_at = $5::timestamptz
       RETURNING id`,
      [
        scope.actor_kind,
        scope.actor_id,
        scope.key,
        now,
        new Date(row.updated_at as string | number | Date).toISOString(),
      ],
    );
    return taken.rows.length > 0 ? { kind: 'new' } : { kind: 'in_progress' };
  }
  return { kind: 'replay', response: stored as unknown as StoredResponse };
}

export async function completeIdempotent(
  deps: SecurityDeps,
  scope: IdemScope,
  response: StoredResponse,
): Promise<void> {
  await deps.db.query(
    'UPDATE api_idempotency SET response = $4::jsonb, updated_at = $5 WHERE actor_kind = $1 AND actor_id = $2 AND key = $3',
    [
      scope.actor_kind,
      scope.actor_id,
      scope.key,
      JSON.stringify(response),
      deps.clock.now().toISOString(),
    ],
  );
}

export async function abandonIdempotent(deps: SecurityDeps, scope: IdemScope): Promise<void> {
  await deps.db.query(
    'DELETE FROM api_idempotency WHERE actor_kind = $1 AND actor_id = $2 AND key = $3',
    [scope.actor_kind, scope.actor_id, scope.key],
  );
}
