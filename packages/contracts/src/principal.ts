// API-W0 (F2): principals. A bearer key resolves to a principal. After the scope check the route wrapper
// maps the principal to an existing domain Actor (toActor), so domain code, sessions and the audit schema
// never see a new actor kind. ActorSchema is not widened (API-W0 spec).
import { z } from 'zod';
import type { Actor } from './actor';
import { IdSchema } from './primitives';

/**
 * The closed set of scopes. A route lists the scopes it needs; a key holds the scopes it was issued with.
 * There is no write scope for operators: no v1 route changes an operator control, and a scope no route
 * uses cannot be picked up by accident later. `events:read` covers only the owner's own resources.
 */
export const SCOPES = [
  'catalogue:read',
  'orders:read',
  'orders:write',
  'library:read',
  'mandates:write',
  'events:read',
  'agent:buy',
  'offers:write',
  'sales:read',
  'ops:read',
] as const;
export const ScopeSchema = z.enum(SCOPES);
export type Scope = z.infer<typeof ScopeSchema>;

export const KEY_KINDS = ['api_client', 'agent'] as const;
export const KeyKindSchema = z.enum(KEY_KINDS);
export type KeyKind = z.infer<typeof KeyKindSchema>;

/** The three actors that can own a key. The system actor owns none. Same shapes as ActorSchema. */
export const OwnerActorSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('buyer'), buyer_id: IdSchema }).strict(),
  z.object({ kind: z.literal('publisher'), publisher_id: IdSchema }).strict(),
  z.object({ kind: z.literal('operator'), operator_id: IdSchema, mfa: z.boolean() }).strict(),
]);
export type OwnerActor = z.infer<typeof OwnerActorSchema>;
export type OwnerKind = OwnerActor['kind'];

export const PrincipalSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('agent'),
      key_id: IdSchema,
      buyer_id: IdSchema,
      mandate_id: IdSchema.nullable(),
    })
    .strict(),
  z.object({ kind: z.literal('api_client'), key_id: IdSchema, owner: OwnerActorSchema }).strict(),
]);
export type Principal = z.infer<typeof PrincipalSchema>;

/**
 * The domain actor a principal acts as. An agent acts as its buyer. An api_client acts as its owner;
 * an operator owner is always `mfa: false`, so every MFA-gated operator action refuses a key.
 */
export function toActor(p: Principal): Actor {
  if (p.kind === 'agent') return { kind: 'buyer', buyer_id: p.buyer_id };
  const owner = p.owner;
  switch (owner.kind) {
    case 'buyer':
      return { kind: 'buyer', buyer_id: owner.buyer_id };
    case 'publisher':
      return { kind: 'publisher', publisher_id: owner.publisher_id };
    case 'operator':
      return { kind: 'operator', operator_id: owner.operator_id, mfa: false };
  }
}

/** What each kind of owner may hand to a key. `issue` refuses anything outside the row. */
export const OWNER_SCOPE_MATRIX = {
  buyer: [
    'catalogue:read',
    'orders:read',
    'orders:write',
    'library:read',
    'mandates:write',
    'events:read',
  ],
  agent: ['catalogue:read', 'orders:read', 'library:read', 'agent:buy'],
  publisher: ['catalogue:read', 'offers:write', 'sales:read', 'events:read'],
  operator: ['ops:read', 'events:read'],
} as const satisfies Record<'buyer' | 'agent' | 'publisher' | 'operator', readonly Scope[]>;

/** The scopes an owner of this kind may give a key of this kind. An agent key exists only for a buyer. */
export function scopesAllowedFor(owner_kind: OwnerKind, key_kind: KeyKind): readonly Scope[] {
  if (key_kind === 'agent') return owner_kind === 'buyer' ? OWNER_SCOPE_MATRIX.agent : [];
  return OWNER_SCOPE_MATRIX[owner_kind];
}
