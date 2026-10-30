// Sessions: a signed `__Host-` cookie naming a server-side `sessions` row. Adapted from the
// simulation's apps/web/server/session.ts (never-throwing cookie parse, token shape check before
// any lookup); the persona token is replaced by a signed session id.
// Origin: AIC_Hackathon_UnitMarket@a36ddc03fd0b962000f686291c145b50ee337f90:apps/web/server/session.ts. Adapted; owned by SBX.
import { createHmac, timingSafeEqual } from 'node:crypto';
import type { Actor, Id } from '@umsbx/contracts';
import { hashCsrfToken } from './csrf';
import type { SecurityDeps } from './route';
import { UNVERIFIED_OPERATOR_ID } from './totp';

export const SESSION_COOKIE = '__Host-ums_s';
export const SESSION_ABSOLUTE_MS = 8 * 60 * 60_000;
export const SESSION_IDLE_MS = 30 * 60_000;

const SESSION_ID = /^ses_[0-9a-z]{26}$/;
const SIGNATURE = /^[A-Za-z0-9_-]{43}$/;
const MAX_COOKIE_VALUE = 200;

export interface SessionRecord {
  id: Id;
  actor: Actor;
  csrf_token_hash: string;
}

const ms = (v: unknown): number => (v instanceof Date ? v.getTime() : Date.parse(String(v)));

// CO-6: the second factor is carried by the signature. A session whose operator showed a TOTP code is
// signed under its own domain (`session-mfa:`), a plain one under `session:`; the cookie keeps one
// shape and the sessions table needs no column. Only the server, which holds the session secret,
// can make either signature, so a cookie cannot be turned into an mfa cookie.
function sign(deps: SecurityDeps, session_id: string, mfa: boolean): string {
  return createHmac('sha256', deps.session_secret.reveal())
    .update(`${mfa ? 'session-mfa' : 'session'}:${session_id}`)
    .digest('base64url');
}

function actorParts(actor: Actor): { kind: 'buyer' | 'publisher' | 'operator'; id: Id } {
  switch (actor.kind) {
    case 'buyer':
      return { kind: 'buyer', id: actor.buyer_id };
    case 'publisher':
      return { kind: 'publisher', id: actor.publisher_id };
    case 'operator':
      return { kind: 'operator', id: actor.operator_id };
    case 'system':
      throw new Error('the system actor has no session');
  }
}

// Never throws: any input that is not our cookie is simply no cookie.
export function readSessionCookie(header: string | null): string | null {
  if (header === null || header.length > 8192) return null;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0 || part.slice(0, eq).trim() !== SESSION_COOKIE) continue;
    const value = part.slice(eq + 1).trim();
    return value.length > 0 && value.length <= MAX_COOKIE_VALUE ? value : null;
  }
  return null;
}

function verifyCookie(deps: SecurityDeps, value: string): { id: Id; mfa: boolean } | null {
  const dot = value.indexOf('.');
  if (dot < 0) return null;
  const id = value.slice(0, dot);
  const sig = value.slice(dot + 1);
  if (!SESSION_ID.test(id) || !SIGNATURE.test(sig)) return null;
  const a = Buffer.from(sig);
  const matches = (mfa: boolean): boolean => {
    const b = Buffer.from(sign(deps, id, mfa));
    return a.length === b.length && timingSafeEqual(a, b);
  };
  // Both are always computed, so the answer does not depend on which one matched.
  const strong = matches(true);
  const plain = matches(false);
  if (strong) return { id, mfa: true };
  return plain ? { id, mfa: false } : null;
}

export async function createSession(
  deps: SecurityDeps,
  actor: Actor,
): Promise<{ cookie: string; csrf_token: string }> {
  const { kind, id: actor_id } = actorParts(actor);
  const mfa = actor.kind === 'operator' && actor.mfa === true;
  const id = deps.ids.next('ses');
  const csrf_token = deps.ids.nonce();
  const now = deps.clock.now().getTime();
  const created = new Date(now).toISOString();
  const expires = new Date(now + SESSION_ABSOLUTE_MS).toISOString();
  await deps.db.transaction(async (tx) => {
    await tx.query(
      `INSERT INTO sessions (id, actor_kind, actor_id, csrf_token_hash, created_at, last_seen_at, expires_at, revoked_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $5, $6, NULL, $5)`,
      [id, kind, actor_id, hashCsrfToken(csrf_token), created, expires],
    );
    await deps.audit.record(tx, {
      actor,
      action: 'session.create',
      target: id,
      reason: null,
      detail: {},
    });
  });
  const cookie = `${SESSION_COOKIE}=${id}.${sign(deps, id, mfa)}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${SESSION_ABSOLUTE_MS / 1000}`;
  return { cookie, csrf_token };
}

export function clearSessionCookie(): string {
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;
}

interface SessionRow {
  id: string;
  actor_kind: string;
  actor_id: string;
  csrf_token_hash: string;
  last_seen_at: unknown;
  expires_at: unknown;
  revoked_at: unknown;
}

// Resolves and renews. Returns null for anything that is not a live session of ours.
export async function resolveSessionRecord(
  deps: SecurityDeps,
  cookieHeader: string | null,
): Promise<SessionRecord | null> {
  const value = readSessionCookie(cookieHeader);
  if (value === null) return null;
  const verified = verifyCookie(deps, value);
  if (verified === null) return null;
  const { id } = verified;
  const res = await deps.db.query<SessionRow>(
    'SELECT id, actor_kind, actor_id, csrf_token_hash, last_seen_at, expires_at, revoked_at FROM sessions WHERE id = $1',
    [id],
  );
  const row = res.rows[0];
  if (row === undefined || row.revoked_at !== null) return null;
  const now = deps.clock.now().getTime();
  if (now >= ms(row.expires_at)) return null;
  if (now - ms(row.last_seen_at) >= SESSION_IDLE_MS) return null;
  let actor: Actor;
  if (row.actor_kind === 'buyer') actor = { kind: 'buyer', buyer_id: row.actor_id };
  else if (row.actor_kind === 'publisher')
    actor = { kind: 'publisher', publisher_id: row.actor_id };
  else if (row.actor_kind === 'operator')
    // Defence in depth: mfa needs the mfa signature AND a named operator row. The unverified
    // operator (`opr_demo`) never has it, whatever the cookie says.
    actor = {
      kind: 'operator',
      operator_id: row.actor_id,
      mfa: verified.mfa && row.actor_id !== UNVERIFIED_OPERATOR_ID,
    };
  else return null;
  await deps.db.query('UPDATE sessions SET last_seen_at = $2, updated_at = $2 WHERE id = $1', [
    id,
    new Date(now).toISOString(),
  ]);
  return { id, actor, csrf_token_hash: row.csrf_token_hash };
}

export async function resolveSession(
  deps: SecurityDeps,
  cookieHeader: string | null,
): Promise<Actor | null> {
  return (await resolveSessionRecord(deps, cookieHeader))?.actor ?? null;
}

/**
 * FIX-FLOW D1: sign out. Ends the one session `id` of this actor and no other: demo personas are shared,
 * so another session of the same persona stays live. False when the session was already ended or
 * belongs to a different actor (a replay is harmless).
 */
export async function revokeSession(
  deps: SecurityDeps,
  s: { id: string; actor: Actor },
): Promise<boolean> {
  const { kind, id: actor_id } = actorParts(s.actor);
  return deps.db.transaction(async (tx) => {
    const res = await tx.query<{ id: string }>(
      `UPDATE sessions SET revoked_at = $4, updated_at = $4
       WHERE id = $1 AND actor_kind = $2 AND actor_id = $3 AND revoked_at IS NULL RETURNING id`,
      [s.id, kind, actor_id, deps.clock.now().toISOString()],
    );
    if (res.rows.length === 0) return false;
    await deps.audit.record(tx, {
      actor: s.actor,
      action: 'session.revoke',
      target: s.id,
      reason: null,
      detail: {},
    });
    return true;
  });
}

export async function revokeAllSessions(deps: SecurityDeps, actor: Actor): Promise<number> {
  const { kind, id } = actorParts(actor);
  return deps.db.transaction(async (tx) => {
    const res = await tx.query<{ id: string }>(
      `UPDATE sessions SET revoked_at = $3, updated_at = $3
       WHERE actor_kind = $1 AND actor_id = $2 AND revoked_at IS NULL RETURNING id`,
      [kind, id, deps.clock.now().toISOString()],
    );
    await deps.audit.record(tx, {
      actor,
      action: 'session.revoke_all',
      target: null,
      reason: null,
      detail: { count: res.rows.length },
    });
    return res.rows.length;
  });
}
