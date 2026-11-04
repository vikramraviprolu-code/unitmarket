// API-W0 (F2): principals. A bearer key resolves to a principal; the wrapper maps it to an existing
// domain Actor after the scope check. ActorSchema is not widened.
import { describe, expect, it } from 'vitest';
import { ActorSchema } from './actor';
import {
  OWNER_SCOPE_MATRIX,
  OwnerActorSchema,
  PrincipalSchema,
  SCOPES,
  ScopeSchema,
  scopesAllowedFor,
  toActor,
} from './principal';

const agent = { kind: 'agent', key_id: 'key_1', buyer_id: 'buy_1', mandate_id: null } as const;
const client = (owner: unknown) => ({ kind: 'api_client', key_id: 'key_2', owner });

describe('PrincipalSchema', () => {
  it('round-trips an agent and an api_client for each owner kind', () => {
    const samples = [
      agent,
      { ...agent, mandate_id: 'man_1' },
      client({ kind: 'buyer', buyer_id: 'buy_1' }),
      client({ kind: 'publisher', publisher_id: 'pub_1' }),
      client({ kind: 'operator', operator_id: 'opr_1', mfa: false }),
    ];
    for (const s of samples) {
      const parsed = PrincipalSchema.parse(s);
      expect(parsed).toEqual(s);
      expect(PrincipalSchema.parse(JSON.parse(JSON.stringify(parsed)))).toEqual(s);
    }
  });

  it('refuses an unknown kind, including the existing actor kinds', () => {
    for (const kind of ['admin', 'buyer', 'publisher', 'operator', 'system', '']) {
      expect(PrincipalSchema.safeParse({ ...agent, kind }).success, kind).toBe(false);
    }
  });

  it('is strict: extra fields fail on the principal and on the owner', () => {
    expect(PrincipalSchema.safeParse({ ...agent, scopes: ['agent:buy'] }).success).toBe(false);
    expect(
      PrincipalSchema.safeParse(client({ kind: 'buyer', buyer_id: 'buy_1', mfa: true })).success,
    ).toBe(false);
    expect(
      PrincipalSchema.safeParse({ ...client({ kind: 'buyer', buyer_id: 'b' }), x: 1 }).success,
    ).toBe(false);
  });

  it('needs every field of an agent, with mandate_id nullable but present', () => {
    expect(
      PrincipalSchema.safeParse({ kind: 'agent', key_id: 'key_1', buyer_id: 'buy_1' }).success,
    ).toBe(false);
    expect(PrincipalSchema.safeParse({ ...agent, key_id: '' }).success).toBe(false);
    expect(PrincipalSchema.safeParse({ ...agent, buyer_id: ' buy_1' }).success).toBe(false);
  });

  it('refuses an owner of kind system, an agent owner, and an api_client without an owner', () => {
    expect(PrincipalSchema.safeParse(client({ kind: 'system' })).success).toBe(false);
    expect(PrincipalSchema.safeParse(client({ kind: 'agent', buyer_id: 'buy_1' })).success).toBe(
      false,
    );
    expect(PrincipalSchema.safeParse({ kind: 'api_client', key_id: 'key_2' }).success).toBe(false);
    expect(OwnerActorSchema.safeParse({ kind: 'system' }).success).toBe(false);
  });

  it('owner schema accepts exactly what ActorSchema accepts for buyer, publisher and operator', () => {
    for (const a of [
      { kind: 'buyer', buyer_id: 'buy_1' },
      { kind: 'publisher', publisher_id: 'pub_1' },
      { kind: 'operator', operator_id: 'opr_1', mfa: true },
      { kind: 'operator', operator_id: 'opr_1' },
      { kind: 'buyer', buyer_id: '' },
      { kind: 'publisher', publisher_id: 'pub_1', extra: 1 },
    ]) {
      expect(OwnerActorSchema.safeParse(a).success, JSON.stringify(a)).toBe(
        ActorSchema.safeParse(a).success,
      );
    }
  });
});

describe('toActor', () => {
  it('maps an agent to its buyer', () => {
    expect(toActor(PrincipalSchema.parse(agent))).toEqual({ kind: 'buyer', buyer_id: 'buy_1' });
    expect(toActor(PrincipalSchema.parse({ ...agent, mandate_id: 'man_9' }))).toEqual({
      kind: 'buyer',
      buyer_id: 'buy_1',
    });
  });

  it('maps an api_client to its owner actor', () => {
    expect(toActor(PrincipalSchema.parse(client({ kind: 'buyer', buyer_id: 'buy_7' })))).toEqual({
      kind: 'buyer',
      buyer_id: 'buy_7',
    });
    expect(
      toActor(PrincipalSchema.parse(client({ kind: 'publisher', publisher_id: 'pub_7' }))),
    ).toEqual({
      kind: 'publisher',
      publisher_id: 'pub_7',
    });
  });

  it('always gives an operator owner mfa false, even if the stored owner says true', () => {
    for (const mfa of [true, false]) {
      expect(
        toActor(PrincipalSchema.parse(client({ kind: 'operator', operator_id: 'opr_1', mfa }))),
      ).toEqual({ kind: 'operator', operator_id: 'opr_1', mfa: false });
    }
  });

  it('only ever returns a value ActorSchema accepts, and never the system actor', () => {
    for (const p of [
      agent,
      client({ kind: 'buyer', buyer_id: 'b' }),
      client({ kind: 'publisher', publisher_id: 'p' }),
      client({ kind: 'operator', operator_id: 'o', mfa: true }),
    ]) {
      const a = toActor(PrincipalSchema.parse(p));
      expect(ActorSchema.safeParse(a).success).toBe(true);
      expect(a.kind).not.toBe('system');
    }
  });
});

describe('scopes', () => {
  it('the scope enum is closed and holds exactly the ten MVP 1 scopes (no write scope for operators)', () => {
    expect([...SCOPES].sort()).toEqual(
      [
        'agent:buy',
        'catalogue:read',
        'events:read',
        'library:read',
        'mandates:write',
        'offers:write',
        'ops:read',
        'orders:read',
        'orders:write',
        'sales:read',
      ].sort(),
    );
    for (const bad of ['ops:write', 'ops:*', '*', 'admin', '', 'orders:*', 'agent:Buy']) {
      expect(ScopeSchema.safeParse(bad).success, bad).toBe(false);
    }
    for (const s of SCOPES) expect(ScopeSchema.parse(s)).toBe(s);
  });

  it('the matrix gives each owner and key kind exactly the spec scopes', () => {
    expect([...scopesAllowedFor('buyer', 'api_client')].sort()).toEqual(
      [
        'catalogue:read',
        'orders:read',
        'orders:write',
        'library:read',
        'mandates:write',
        'events:read',
      ].sort(),
    );
    expect([...scopesAllowedFor('buyer', 'agent')].sort()).toEqual(
      ['catalogue:read', 'orders:read', 'library:read', 'agent:buy'].sort(),
    );
    expect([...scopesAllowedFor('publisher', 'api_client')].sort()).toEqual(
      ['catalogue:read', 'offers:write', 'sales:read', 'events:read'].sort(),
    );
    expect([...scopesAllowedFor('operator', 'api_client')].sort()).toEqual([
      'events:read',
      'ops:read',
    ]);
  });

  it('an agent key exists only for a buyer, so no other combination has any scope', () => {
    expect(scopesAllowedFor('publisher', 'agent')).toEqual([]);
    expect(scopesAllowedFor('operator', 'agent')).toEqual([]);
  });

  it('no owner can hold agent:buy except through an agent key, and only operators hold ops scopes', () => {
    expect(scopesAllowedFor('buyer', 'api_client')).not.toContain('agent:buy');
    expect(scopesAllowedFor('publisher', 'api_client')).not.toContain('agent:buy');
    for (const [who, scopes] of Object.entries(OWNER_SCOPE_MATRIX)) {
      if (who === 'operator') continue;
      expect(
        scopes.some((s) => s.startsWith('ops:')),
        who,
      ).toBe(false);
    }
  });
});
