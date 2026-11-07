// INT-OPS-C / OPS-C.3: the pure parts of the Agents and API tab. The webhook host is cut from the stored URL here,
// inside the read, so a path or a query never reaches the page (C1, N-C3). The reason codes and their words are
// the closed list of the operator revoke (C4).
import { maskId } from './ops-entity-view';

export const REVOKE_REASONS = ['abuse', 'owner_request', 'compromised', 'other'] as const;
export type RevokeReason = (typeof REVOKE_REASONS)[number];

export const REVOKE_REASON_WORD: Record<RevokeReason, string> = {
  abuse: 'Abuse',
  owner_request: 'The owner asked',
  compromised: 'Key or cap compromised',
  other: 'Other',
};

/** The host of a stored https URL, lower case, no port, path, query or user. Null when it does not parse. */
export function webhookHost(url: string): string | null {
  try {
    const u = new URL(url);
    return u.protocol === 'https:' && u.hostname !== '' ? u.hostname.toLowerCase() : null;
  } catch {
    return null;
  }
}

/** A key id as it may show: whole with the second factor, the last four without. */
export const keyShown = (id: string, mfa: boolean): string => (mfa ? id : maskId(id)!);

/** Money left and count left of a cap; null where the cap has no such limit. */
export function remaining(c: {
  max_total_minor: number | null;
  max_count: number | null;
  spent_minor: number;
  used_count: number;
}): { remaining_total_minor: number | null; remaining_count: number | null } {
  return {
    remaining_total_minor:
      c.max_total_minor === null ? null : Math.max(0, c.max_total_minor - c.spent_minor),
    remaining_count: c.max_count === null ? null : Math.max(0, c.max_count - c.used_count),
  };
}

/** What a revoke route answer means, in words for the form. */
export function revokeOutcome(status: number): string {
  if (status === 200) return 'Revoked. The change is in the journal.';
  if (status === 403) return 'Refused: this needs a sign-in with your authenticator code.';
  if (status === 404) return 'Not found. It may have been removed.';
  if (status === 429) return 'Too many revokes in the last hour. Try again later.';
  return 'That did not work. Nothing was changed.';
}

export interface RawCap {
  id: string;
  buyer_id: string;
  agent_key_id: string;
  currency: string;
  max_total_minor: number | string | null;
  max_count: number | string | null;
  max_per_purchase_minor: number | string | null;
  spent_minor: number | string;
  used_count: number | string;
  expires_at: string | Date;
  revoked_at: string | Date | null;
  exhausted_at: string | Date | null;
  created_at: string | Date;
}

export interface CapRow {
  id: string;
  /** The buyer id with the second factor; null without it. */
  buyer: string | null;
  /** The agent key id, whole with the second factor and the last four without. */
  agent_key: string;
  currency: string;
  max_total_minor: number | null;
  max_count: number | null;
  max_per_purchase_minor: number | null;
  spent_minor: number;
  used_count: number;
  remaining_total_minor: number | null;
  remaining_count: number | null;
  expires_at: string;
  revoked_at: string | null;
  state: 'active' | 'revoked' | 'expired' | 'exhausted';
}

const isoOf = (v: string | Date): string => new Date(v).toISOString();
const isoOrNull = (v: string | Date | null): string | null => (v === null ? null : isoOf(v));
const numOrNull = (v: number | string | null): number | null => (v === null ? null : Number(v));

/** One cap as the operator pages show it, under the identity rule. */
export function capRow(r: RawCap, now: string, mfa: boolean): CapRow {
  const base = {
    max_total_minor: numOrNull(r.max_total_minor),
    max_count: numOrNull(r.max_count),
    spent_minor: Number(r.spent_minor),
    used_count: Number(r.used_count),
  };
  const expires_at = isoOf(r.expires_at);
  const revoked_at = isoOrNull(r.revoked_at);
  const exhausted_at = isoOrNull(r.exhausted_at);
  const state =
    revoked_at !== null
      ? 'revoked'
      : Date.parse(expires_at) <= Date.parse(now)
        ? 'expired'
        : exhausted_at !== null
          ? 'exhausted'
          : 'active';
  return {
    id: r.id,
    buyer: mfa ? r.buyer_id : null,
    agent_key: keyShown(r.agent_key_id, mfa),
    currency: r.currency,
    ...base,
    max_per_purchase_minor: numOrNull(r.max_per_purchase_minor),
    ...remaining(base),
    expires_at,
    revoked_at,
    state,
  };
}

/** The columns a cap read selects, and nothing else. */
export const CAP_COLUMNS =
  'id, buyer_id, agent_key_id, currency, max_total_minor, max_count, max_per_purchase_minor, spent_minor, used_count, expires_at, revoked_at, exhausted_at, created_at';
/** The columns a key read selects: never the secret hash. */
export const KEY_COLUMNS =
  'id, owner_kind, owner_id, key_kind, scopes, created_at, revoked_at, last_used_at';

export interface RawKey {
  id: string;
  owner_kind: string;
  owner_id: string;
  key_kind: string;
  scopes: string[];
  created_at: string | Date;
  revoked_at: string | Date | null;
  last_used_at: string | Date | null;
}

export interface KeyRow {
  id: string;
  key_kind: string;
  owner_kind: string;
  /** The owner id with the second factor; null without it. */
  owner: string | null;
  scopes: string[];
  created_at: string;
  revoked_at: string | null;
  last_used_at: string | null;
}

export function keyRow(r: RawKey, mfa: boolean): KeyRow {
  return {
    id: keyShown(r.id, mfa),
    key_kind: r.key_kind,
    owner_kind: r.owner_kind,
    owner: mfa ? r.owner_id : null,
    scopes: [...r.scopes].sort(),
    created_at: isoOf(r.created_at),
    revoked_at: isoOrNull(r.revoked_at),
    last_used_at: isoOrNull(r.last_used_at),
  };
}

/** How an operator revoke error becomes an HTTP answer. Plain words; no identity. */
export function revokeErrorResult(
  what: 'cap' | 'key',
  code: 'not_found' | 'not_operator' | 'mfa_required' | 'invalid_reason',
): { status: 403 | 404 | 422; code: string; message: string } {
  switch (code) {
    case 'not_found':
      return {
        status: 404,
        code,
        message: what === 'cap' ? 'We could not find that cap.' : 'We could not find that key.',
      };
    case 'mfa_required':
      return { status: 403, code, message: 'This needs a sign-in with your authenticator code.' };
    case 'invalid_reason':
      return { status: 422, code: 'bad_input', message: 'That reason is not on the list.' };
    default:
      return { status: 403, code: 'forbidden', message: 'Only an operator can do that.' };
  }
}

/** The jump links of Agents and API, in page order. */
export const OPS_AGENTS_SECTIONS: { id: string; label: string }[] = [
  { id: 'agents-caps', label: 'Caps' },
  { id: 'agents-reservations', label: 'Reservations' },
  { id: 'agents-purchases', label: 'Agent purchases' },
  { id: 'agents-keys', label: 'Keys' },
  { id: 'agents-webhooks', label: 'Webhooks' },
];
