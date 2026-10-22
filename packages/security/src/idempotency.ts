// Idempotency-Key handling on `api_idempotency`. A row is reserved before the handler runs
// (response = {"pending":true}), completed on success and deleted on failure so a client can retry.
import { sha256Hex } from './csrf';
import type { Actor } from '@umsbx/contracts';
import type { SecurityDeps } from './route';

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

export const requestHash = (route: string, method: string, rawBody: string): string =>
  sha256Hex(`${method} ${route}\n${rawBody}`);

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
  const res = await deps.db.query<{ route: string; request_sha256: string; response: unknown }>(
    'SELECT route, request_sha256, response FROM api_idempotency WHERE actor_kind = $1 AND actor_id = $2 AND key = $3',
    [scope.actor_kind, scope.actor_id, scope.key],
  );
  const row = res.rows[0];
  if (row === undefined) return { kind: 'in_progress' };
  if (row.route !== route || row.request_sha256 !== request_sha256) return { kind: 'key_reused' };
  const stored = parse(row.response);
  if (stored.pending === true) return { kind: 'in_progress' };
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
