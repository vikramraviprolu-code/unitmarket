// INT-SR0 (SR0.2): who may ask what. `scopeQuery` checks the role on the RAW keys first, before any value is
// parsed, so a bad value never hides a refusal (`environment=bogus` from a seller is still a 400). It returns
// the parsed query together with the scope the SQL must pin: a buyer to its own buyer id, a seller to its own
// publisher id, an operator to nothing. The refused fields come from REFUSED_FIELDS in contracts.
import { REFUSED_FIELDS } from '@umsbx/contracts';
import type { Actor, Principal, TxnQuery } from '@umsbx/contracts';
import { TxnSearchError } from './cursor';

/** A signed-in session (an Actor) or an API key (a Principal). */
export type TxnPrincipal = Actor | Principal;

export type TxnScope =
  | { kind: 'buyer'; buyer_id: string }
  | { kind: 'publisher'; publisher_id: string }
  /** `opaque_ids_only`: an operator API key (`mfa: false`) matches a buyer or seller by id, never by name. */
  | { kind: 'operator'; opaque_ids_only: boolean };

export interface ScopedQuery {
  query: TxnQuery;
  scope: TxnScope;
}

type RoleKey = keyof typeof REFUSED_FIELDS;

function roleOf(p: TxnPrincipal): { role: RoleKey; scope: TxnScope } {
  switch (p.kind) {
    case 'buyer':
      return { role: 'buyer', scope: { kind: 'buyer', buyer_id: p.buyer_id } };
    case 'publisher':
      return { role: 'publisher', scope: { kind: 'publisher', publisher_id: p.publisher_id } };
    case 'operator':
      return p.mfa
        ? { role: 'operator', scope: { kind: 'operator', opaque_ids_only: false } }
        : { role: 'operator_key', scope: { kind: 'operator', opaque_ids_only: true } };
    case 'agent':
      return { role: 'agent', scope: { kind: 'buyer', buyer_id: p.buyer_id } };
    case 'api_client': {
      const owner = p.owner;
      switch (owner.kind) {
        case 'buyer':
          return { role: 'buyer', scope: { kind: 'buyer', buyer_id: owner.buyer_id } };
        case 'publisher':
          return {
            role: 'publisher',
            scope: { kind: 'publisher', publisher_id: owner.publisher_id },
          };
        case 'operator':
          return { role: 'operator_key', scope: { kind: 'operator', opaque_ids_only: true } };
      }
    }
  }
  // The system actor, or a kind this code does not know: no transaction search for it.
  throw new TxnSearchError('forbidden', 'This sign-in cannot search transactions.');
}

/**
 * `raw` is the URL string map the client sent, `parsed` is parseTxnQuery(raw). A refused key present in `raw`
 * (any value, any letter case) or in `parsed` throws 400 `field_not_allowed`. Otherwise the query comes back
 * with the scope to pin.
 */
export function scopeQuery(
  principal: TxnPrincipal,
  raw: Readonly<Record<string, string | undefined>>,
  parsed: TxnQuery,
): ScopedQuery {
  const { role, scope } = roleOf(principal);
  const sent = new Set(Object.keys(raw).map((k) => k.toLowerCase()));
  for (const field of REFUSED_FIELDS[role]) {
    if (sent.has(field) || Object.hasOwn(parsed, field)) {
      throw new TxnSearchError(
        'field_not_allowed',
        `The filter "${field}" is not available to you.`,
        field,
      );
    }
  }
  return { query: parsed, scope };
}
