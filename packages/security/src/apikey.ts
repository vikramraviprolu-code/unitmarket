// API-W0 (F3): API keys for /api/v1. A key is `umk_<26 id characters>_<43 secret characters>`. Only the
// SHA-256 of the secret is stored. Verify compares fixed-length digests with timingSafeEqual, does the same
// work for an unknown id (a dummy digest), and gives one answer for every failure. The effective scopes of
// a key are its stored scopes cut down to what the owner scope matrix allows today.
import { createHash, timingSafeEqual } from 'node:crypto';
import {
  SCOPES,
  err,
  ok,
  scopesAllowedFor,
  type Actor,
  type ApiKeyView,
  type AuditSink,
  type Clock,
  type Database,
  type Id,
  type Ids,
  type KeyKind,
  type OwnerKind,
  type Principal,
  type Result,
  type Scope,
  type SecretSource,
  type SqlExecutor,
} from '@umsbx/contracts';

/** `umk_` + 26 id characters (Crockford base32, lower case) + `_` + 43 base64url characters. */
export const KEY_TOKEN_PATTERN = /^umk_([0-9a-hjkmnp-tv-z]{26})_([A-Za-z0-9_-]{43})$/;
const KEY_ID_PATTERN = /^key_[0-9a-hjkmnp-tv-z]{26}$/;
const SECRET_BYTES = 32;
const MAX_HEADER = 200;

export interface ApiKeyDeps {
  db: Database;
  clock: Clock;
  ids: Ids;
  secrets: SecretSource;
  /** When present, issue and revoke write their audit row in the same transaction. */
  audit?: AuditSink;
}

/** The one-time issue answer: the view plus the token. */
export type IssuedKey = ApiKeyView & { token: string };

export type IssueError =
  | 'invalid_scopes'
  | 'scope_not_allowed'
  | 'mfa_required'
  | 'unknown_owner'
  | 'agent_key_needs_buyer';

export function formatKeyToken(idPart: string, secret: string): string {
  return `umk_${idPart}_${secret}`;
}

/** Splits a token on its fixed lengths (a secret may hold `-` and `_`). Null for anything else. */
export function parseKeyToken(token: string): { key_id: Id; secret: string } | null {
  const m = KEY_TOKEN_PATTERN.exec(token);
  if (m === null) return null;
  return { key_id: `key_${m[1]!}`, secret: m[2]! };
}

export function hashKeySecret(secret: string): string {
  return createHash('sha256').update(secret, 'utf8').digest('hex');
}

/**
 * The token out of an `Authorization` header. The scheme is case-insensitive; one space; no extra
 * whitespace; a length cap. Null for anything else (the caller answers one fixed 401).
 */
export function bearerToken(header: string | null): string | null {
  if (header === null || header.length > MAX_HEADER) return null;
  const m = /^[Bb][Ee][Aa][Rr][Ee][Rr] ([^\s,]+)$/.exec(header);
  return m === null ? null : m[1]!;
}

const SCOPE_SET: ReadonlySet<string> = new Set<string>(SCOPES);

const iso = (v: unknown): string =>
  v instanceof Date ? v.toISOString() : new Date(String(v)).toISOString();
const isoOrNull = (v: unknown): string | null => (v === null || v === undefined ? null : iso(v));

interface KeyRow {
  id: string;
  owner_kind: OwnerKind;
  owner_id: string;
  key_kind: KeyKind;
  agent_buyer_id: string | null;
  scopes: string[];
  secret_hash: string;
  created_at: unknown;
  revoked_at: unknown;
  last_used_at: unknown;
}

function toView(r: KeyRow): ApiKeyView {
  return {
    id: r.id,
    key_kind: r.key_kind,
    owner_kind: r.owner_kind,
    scopes: [...r.scopes].filter((s): s is Scope => SCOPE_SET.has(s)).sort(),
    created_at: iso(r.created_at),
    revoked_at: isoOrNull(r.revoked_at),
    last_used_at: isoOrNull(r.last_used_at),
  };
}

function ownerParts(owner: Actor): { kind: OwnerKind; id: Id } | null {
  switch (owner.kind) {
    case 'buyer':
      return { kind: 'buyer', id: owner.buyer_id };
    case 'publisher':
      return { kind: 'publisher', id: owner.publisher_id };
    case 'operator':
      return { kind: 'operator', id: owner.operator_id };
    case 'system':
      return null;
  }
}

export interface IssueInput {
  owner: Actor;
  key_kind: KeyKind;
  scopes: readonly string[];
}

/**
 * Issues a key. The owner and kind decide which scopes may be asked for; one scope outside the matrix
 * refuses the whole request and stores nothing. An operator key needs a session that showed a second
 * factor. The audit row (when an audit sink is given) is written in the same transaction as the key.
 */
export async function issueKey(
  deps: ApiKeyDeps,
  input: IssueInput,
): Promise<Result<IssuedKey, IssueError>> {
  const owner = ownerParts(input.owner);
  if (owner === null) return err('unknown_owner');
  if (input.scopes.length === 0 || !input.scopes.every((s) => SCOPE_SET.has(s))) {
    return err('invalid_scopes');
  }
  const scopes = [...new Set(input.scopes as readonly Scope[])].sort();
  if (input.key_kind === 'agent' && owner.kind !== 'buyer') return err('agent_key_needs_buyer');
  if (input.owner.kind === 'operator' && !input.owner.mfa) return err('mfa_required');
  const allowed = scopesAllowedFor(owner.kind, input.key_kind);
  if (!scopes.every((s) => allowed.includes(s))) return err('scope_not_allowed');

  const id = deps.ids.next('key');
  if (!KEY_ID_PATTERN.test(id)) throw new Error('key id is not in the key token format');
  const secret = Buffer.from(deps.secrets.bytes(SECRET_BYTES)).toString('base64url');
  const created = deps.clock.now().toISOString();

  return deps.db.transaction(async (tx): Promise<Result<IssuedKey, IssueError>> => {
    if (input.key_kind === 'agent') {
      const buyer = await tx.query('SELECT 1 FROM buyers WHERE id = $1', [owner.id]);
      if (buyer.rows.length === 0) return err('unknown_owner');
    }
    await tx.query(
      `INSERT INTO api_keys (id, owner_kind, owner_id, key_kind, agent_buyer_id, scopes, secret_hash, created_at, revoked_at, last_used_at)
       VALUES ($1, $2, $3, $4, $5, $6::text[], $7, $8, NULL, NULL)`,
      [
        id,
        owner.kind,
        owner.id,
        input.key_kind,
        input.key_kind === 'agent' ? owner.id : null,
        scopes,
        hashKeySecret(secret),
        created,
      ],
    );
    if (deps.audit !== undefined) {
      await deps.audit.record(tx, {
        actor: input.owner,
        action: 'api_key.issued',
        target: id,
        reason: null,
        detail: { key_kind: input.key_kind, owner_kind: owner.kind, scopes: scopes.join(',') },
      });
    }
    return ok({
      id,
      key_kind: input.key_kind,
      owner_kind: owner.kind,
      scopes,
      created_at: created,
      revoked_at: null,
      last_used_at: null,
      token: formatKeyToken(id.slice('key_'.length), secret),
    });
  });
}

export interface VerifiedKey {
  key_id: Id;
  principal: Principal;
  scopes: Scope[];
}

// Compared against when the id is unknown or the token is malformed, so every path does one digest
// comparison of the same size.
const DUMMY_DIGEST = createHash('sha256').update('umk dummy digest').digest();

/**
 * Resolves a token to a principal and its effective scopes. Every failure (malformed, unknown id, wrong
 * secret, revoked) is the same `invalid_key`. A verified call stamps last_used_at with the injected clock.
 */
export async function verifyKey(
  deps: Pick<ApiKeyDeps, 'db' | 'clock'>,
  token: string,
): Promise<Result<VerifiedKey, 'invalid_key'>> {
  const parsed = parseKeyToken(token);
  let row: KeyRow | null = null;
  if (parsed !== null) {
    const r = await deps.db.query<KeyRow>(
      `SELECT id, owner_kind, owner_id, key_kind, agent_buyer_id, scopes, secret_hash, created_at, revoked_at, last_used_at
         FROM api_keys WHERE id = $1`,
      [parsed.key_id],
    );
    row = r.rows[0] ?? null;
  }
  const presented = createHash('sha256')
    .update(parsed?.secret ?? '', 'utf8')
    .digest();
  const stored = row === null ? DUMMY_DIGEST : Buffer.from(row.secret_hash, 'hex');
  const same = stored.length === presented.length && timingSafeEqual(stored, presented);
  if (parsed === null || row === null || !same || row.revoked_at !== null) {
    return err('invalid_key');
  }

  const allowed = scopesAllowedFor(row.owner_kind, row.key_kind);
  const scopes = [...new Set(row.scopes)]
    .filter((s): s is Scope => SCOPE_SET.has(s) && allowed.includes(s as Scope))
    .sort();
  let principal: Principal;
  if (row.key_kind === 'agent') {
    // The table CHECK makes an agent key's buyer its owner, so the owner id is the buyer id.
    principal = { kind: 'agent', key_id: row.id, buyer_id: row.owner_id, mandate_id: null };
  } else if (row.owner_kind === 'buyer') {
    principal = {
      kind: 'api_client',
      key_id: row.id,
      owner: { kind: 'buyer', buyer_id: row.owner_id },
    };
  } else if (row.owner_kind === 'publisher') {
    principal = {
      kind: 'api_client',
      key_id: row.id,
      owner: { kind: 'publisher', publisher_id: row.owner_id },
    };
  } else {
    principal = {
      kind: 'api_client',
      key_id: row.id,
      owner: { kind: 'operator', operator_id: row.owner_id, mfa: false },
    };
  }
  await deps.db.query('UPDATE api_keys SET last_used_at = $2 WHERE id = $1', [
    row.id,
    deps.clock.now().toISOString(),
  ]);
  return ok({ key_id: row.id, principal, scopes });
}

/** True when every required scope is among the held scopes. */
export function hasScopes(held: readonly Scope[], required: readonly Scope[]): boolean {
  return required.every((s) => held.includes(s));
}

/**
 * Revokes one of the owner's own keys. A key of another owner (or none) is `not_found`, with no hint
 * which. Revoking again keeps the first time and writes no second audit row.
 */
export async function revokeKey(
  deps: ApiKeyDeps,
  owner: Actor,
  key_id: string,
): Promise<Result<ApiKeyView, 'not_found'>> {
  const parts = ownerParts(owner);
  if (parts === null) return err('not_found');
  return deps.db.transaction(async (tx: SqlExecutor): Promise<Result<ApiKeyView, 'not_found'>> => {
    const found = await tx.query<KeyRow>(
      `SELECT id, owner_kind, owner_id, key_kind, agent_buyer_id, scopes, secret_hash, created_at, revoked_at, last_used_at
         FROM api_keys WHERE id = $1 AND owner_kind = $2 AND owner_id = $3`,
      [key_id, parts.kind, parts.id],
    );
    const row = found.rows[0];
    if (row === undefined) return err('not_found');
    if (row.revoked_at !== null) return ok(toView(row));
    const at = deps.clock.now().toISOString();
    await tx.query('UPDATE api_keys SET revoked_at = $2 WHERE id = $1', [row.id, at]);
    if (deps.audit !== undefined) {
      await deps.audit.record(tx, {
        actor: owner,
        action: 'api_key.revoked',
        target: row.id,
        reason: null,
        detail: { key_kind: row.key_kind, owner_kind: row.owner_kind },
      });
    }
    return ok(toView({ ...row, revoked_at: at }));
  });
}

/** The owner's own keys, oldest first. Never a hash or a secret. */
export async function listKeys(deps: Pick<ApiKeyDeps, 'db'>, owner: Actor): Promise<ApiKeyView[]> {
  const parts = ownerParts(owner);
  if (parts === null) return [];
  const r = await deps.db.query<KeyRow>(
    `SELECT id, owner_kind, owner_id, key_kind, agent_buyer_id, scopes, secret_hash, created_at, revoked_at, last_used_at
       FROM api_keys WHERE owner_kind = $1 AND owner_id = $2 ORDER BY created_at, id`,
    [parts.kind, parts.id],
  );
  return r.rows.map(toView);
}
