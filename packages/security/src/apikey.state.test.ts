// API-W0 (F3): API keys on a real PGlite database. Issue, verify, revoke and list, the owner-scope
// matrix, and the rules that keep a key from carrying more than its owner may give.
import { describe, expect, it, vi } from 'vitest';
import { OWNER_SCOPE_MATRIX, SCOPES } from '@umsbx/contracts';
import { hashKeySecret, issueKey, listKeys, parseKeyToken, revokeKey, verifyKey } from './apikey';
import { BUYER_A, BUYER_B, OPR_MFA, OPR_PLAIN, PUB_A, PUB_B, makeV1Rig } from './v1-support';
import { expectOffline } from './offline-guard';

vi.mock('node:net', async (orig) => (await import('./offline-guard')).netMock(await orig()));
vi.mock('node:dns', async (orig) => (await import('./offline-guard')).dnsMock(await orig()));
expectOffline();

describe('issue, verify', () => {
  it('a publisher key verifies to an api_client principal with the scopes it was given', async () => {
    const rig = await makeV1Rig();
    const k = await rig.issue(PUB_A, 'api_client', ['sales:read', 'catalogue:read']);
    const v = await verifyKey(rig.keyDeps, k.token);
    expect(v.ok).toBe(true);
    if (!v.ok) return;
    expect(v.value.key_id).toBe(k.id);
    expect(v.value.principal).toEqual({
      kind: 'api_client',
      key_id: k.id,
      owner: { kind: 'publisher', publisher_id: 'pub_w0a' },
    });
    expect([...v.value.scopes].sort()).toEqual(['catalogue:read', 'sales:read']);
  });

  it('an agent key verifies to an agent principal for the owning buyer, with no mandate yet', async () => {
    const rig = await makeV1Rig();
    const k = await rig.issue(BUYER_A, 'agent', ['agent:buy', 'catalogue:read']);
    const v = await verifyKey(rig.keyDeps, k.token);
    expect(v.ok && v.value.principal).toEqual({
      kind: 'agent',
      key_id: k.id,
      buyer_id: 'buy_w0a',
      mandate_id: null,
    });
  });

  it('an operator key verifies with owner mfa false whatever the issuing session had', async () => {
    const rig = await makeV1Rig();
    const k = await rig.issue(OPR_MFA, 'api_client', ['ops:read']);
    const v = await verifyKey(rig.keyDeps, k.token);
    expect(v.ok && v.value.principal).toEqual({
      kind: 'api_client',
      key_id: k.id,
      owner: { kind: 'operator', operator_id: 'opr_w0', mfa: false },
    });
  });

  it('scopes are stored sorted and without duplicates in the answer', async () => {
    const rig = await makeV1Rig();
    const k = await rig.issue(BUYER_A, 'api_client', [
      'orders:write',
      'catalogue:read',
      'orders:read',
    ]);
    expect(k.scopes).toEqual(['catalogue:read', 'orders:read', 'orders:write']);
    expect(k.key_kind).toBe('api_client');
    expect(k.owner_kind).toBe('buyer');
    expect(k.revoked_at).toBeNull();
    expect(k.last_used_at).toBeNull();
    expect(k.created_at).toBe(rig.clock.now().toISOString());
  });

  it('stamps last_used_at on a verified call, with the injected clock', async () => {
    const rig = await makeV1Rig();
    const k = await rig.issue(PUB_A, 'api_client', ['catalogue:read']);
    rig.clock.advance(90_000);
    await verifyKey(rig.keyDeps, k.token);
    const [view] = await listKeys(rig.keyDeps, PUB_A);
    expect(view!.last_used_at).toBe(rig.clock.now().toISOString());
  });

  it('a failed verify does not stamp last_used_at', async () => {
    const rig = await makeV1Rig();
    const k = await rig.issue(PUB_A, 'api_client', ['catalogue:read']);
    const parsed = parseKeyToken(k.token)!;
    await verifyKey(rig.keyDeps, `umk_${parsed.key_id.slice(4)}_${'A'.repeat(43)}`);
    const [view] = await listKeys(rig.keyDeps, PUB_A);
    expect(view!.last_used_at).toBeNull();
  });

  it('a stored scope the matrix no longer allows is dropped at verify time', async () => {
    const rig = await makeV1Rig();
    const k = await rig.issue(PUB_A, 'api_client', ['catalogue:read']);
    await rig.db.query(
      `UPDATE api_keys SET scopes = ARRAY['catalogue:read','ops:read','nonsense']::text[] WHERE id = $1`,
      [k.id],
    );
    const v = await verifyKey(rig.keyDeps, k.token);
    expect(v.ok && v.value.scopes).toEqual(['catalogue:read']);
  });

  it('the secret is stored as a sha256 digest only', async () => {
    const rig = await makeV1Rig();
    const k = await rig.issue(PUB_A, 'api_client', ['catalogue:read']);
    const { secret } = parseKeyToken(k.token)!;
    const row = await rig.db.query<Record<string, unknown>>(
      'SELECT * FROM api_keys WHERE id = $1',
      [k.id],
    );
    expect(row.rows[0]!['secret_hash']).toBe(hashKeySecret(secret));
    expect(JSON.stringify(row.rows[0])).not.toContain(secret);
  });
});

describe('the owner-scope matrix', () => {
  it('issue accepts every scope the matrix allows, for each owner and key kind', async () => {
    const rig = await makeV1Rig();
    const cases = [
      [BUYER_A, 'api_client', OWNER_SCOPE_MATRIX.buyer],
      [BUYER_A, 'agent', OWNER_SCOPE_MATRIX.agent],
      [PUB_A, 'api_client', OWNER_SCOPE_MATRIX.publisher],
      [OPR_MFA, 'api_client', OWNER_SCOPE_MATRIX.operator],
    ] as const;
    for (const [owner, kind, scopes] of cases) {
      const r = await issueKey(rig.keyDeps, { owner, key_kind: kind, scopes });
      expect(r.ok, `${owner.kind} ${kind}`).toBe(true);
    }
  });

  it('issue refuses every known scope outside the matrix, one at a time', async () => {
    const rig = await makeV1Rig();
    const cases = [
      [BUYER_A, 'api_client', OWNER_SCOPE_MATRIX.buyer],
      [BUYER_A, 'agent', OWNER_SCOPE_MATRIX.agent],
      [PUB_A, 'api_client', OWNER_SCOPE_MATRIX.publisher],
      [OPR_MFA, 'api_client', OWNER_SCOPE_MATRIX.operator],
    ] as const;
    for (const [owner, kind, allowed] of cases) {
      for (const s of SCOPES.filter((x) => !(allowed as readonly string[]).includes(x))) {
        const r = await issueKey(rig.keyDeps, { owner, key_kind: kind, scopes: [s] });
        expect(r, `${owner.kind} ${kind} ${s}`).toEqual({ ok: false, error: 'scope_not_allowed' });
      }
    }
  });

  it('one scope outside the matrix refuses the whole request and stores nothing', async () => {
    const rig = await makeV1Rig();
    const r = await issueKey(rig.keyDeps, {
      owner: BUYER_A,
      key_kind: 'api_client',
      scopes: ['catalogue:read', 'ops:read'],
    });
    expect(r).toEqual({ ok: false, error: 'scope_not_allowed' });
    expect(await listKeys(rig.keyDeps, BUYER_A)).toEqual([]);
  });

  it('a name that is not a scope (ops:write, a wildcard) is refused as invalid', async () => {
    const rig = await makeV1Rig();
    for (const bad of ['ops:write', '*', 'orders:*', '', 'AGENT:BUY']) {
      const r = await issueKey(rig.keyDeps, {
        owner: BUYER_A,
        key_kind: 'api_client',
        scopes: [bad],
      });
      expect(r, bad).toEqual({ ok: false, error: 'invalid_scopes' });
    }
    expect(
      await issueKey(rig.keyDeps, { owner: BUYER_A, key_kind: 'api_client', scopes: [] }),
    ).toEqual({
      ok: false,
      error: 'invalid_scopes',
    });
  });

  it('a publisher or operator cannot own an agent key', async () => {
    const rig = await makeV1Rig();
    for (const owner of [PUB_A, OPR_MFA]) {
      const r = await issueKey(rig.keyDeps, { owner, key_kind: 'agent', scopes: ['agent:buy'] });
      expect(r.ok).toBe(false);
    }
  });

  it('an operator key is issued only for a session that showed a second factor', async () => {
    const rig = await makeV1Rig();
    const r = await issueKey(rig.keyDeps, {
      owner: OPR_PLAIN,
      key_kind: 'api_client',
      scopes: ['ops:read'],
    });
    expect(r).toEqual({ ok: false, error: 'mfa_required' });
    expect(await listKeys(rig.keyDeps, OPR_PLAIN)).toEqual([]);
  });

  it('an agent key for a buyer that does not exist is refused', async () => {
    const rig = await makeV1Rig();
    const r = await issueKey(rig.keyDeps, {
      owner: { kind: 'buyer', buyer_id: 'buy_ghost' },
      key_kind: 'agent',
      scopes: ['agent:buy'],
    });
    expect(r).toEqual({ ok: false, error: 'unknown_owner' });
  });
});

describe('the system actor owns no key', () => {
  it('issue, revoke and list refuse or find nothing for the system actor', async () => {
    const rig = await makeV1Rig();
    const system = { kind: 'system' } as const;
    expect(
      await issueKey(rig.keyDeps, {
        owner: system,
        key_kind: 'api_client',
        scopes: ['catalogue:read'],
      }),
    ).toEqual({ ok: false, error: 'unknown_owner' });
    const k = await rig.issue(PUB_A, 'api_client', ['catalogue:read']);
    expect(await revokeKey(rig.keyDeps, system, k.id)).toEqual({ ok: false, error: 'not_found' });
    expect(await listKeys(rig.keyDeps, system)).toEqual([]);
    expect((await verifyKey(rig.keyDeps, k.token)).ok).toBe(true);
  });
});

describe('revoke and list', () => {
  it('revoke stops the key at once and the key stays listed with revoked_at', async () => {
    const rig = await makeV1Rig();
    const k = await rig.issue(PUB_A, 'api_client', ['catalogue:read']);
    expect((await verifyKey(rig.keyDeps, k.token)).ok).toBe(true);
    rig.clock.advance(1000);
    const r = await revokeKey(rig.keyDeps, PUB_A, k.id);
    expect(r.ok).toBe(true);
    expect(await verifyKey(rig.keyDeps, k.token)).toEqual({ ok: false, error: 'invalid_key' });
    const [view] = await listKeys(rig.keyDeps, PUB_A);
    expect(view!.id).toBe(k.id);
    expect(view!.revoked_at).toBe(rig.clock.now().toISOString());
  });

  it('revoking twice keeps the first revoke time and answers ok', async () => {
    const rig = await makeV1Rig();
    const k = await rig.issue(PUB_A, 'api_client', ['catalogue:read']);
    await revokeKey(rig.keyDeps, PUB_A, k.id);
    const first = (await listKeys(rig.keyDeps, PUB_A))[0]!.revoked_at;
    rig.clock.advance(5000);
    expect((await revokeKey(rig.keyDeps, PUB_A, k.id)).ok).toBe(true);
    expect((await listKeys(rig.keyDeps, PUB_A))[0]!.revoked_at).toBe(first);
  });

  it('another owner cannot revoke the key, and learns nothing: not_found, and the key still works', async () => {
    const rig = await makeV1Rig();
    const k = await rig.issue(PUB_A, 'api_client', ['catalogue:read']);
    for (const other of [PUB_B, BUYER_A, OPR_MFA]) {
      expect(await revokeKey(rig.keyDeps, other, k.id), other.kind).toEqual({
        ok: false,
        error: 'not_found',
      });
    }
    expect(await revokeKey(rig.keyDeps, PUB_A, 'key_doesnotexist')).toEqual({
      ok: false,
      error: 'not_found',
    });
    expect((await verifyKey(rig.keyDeps, k.token)).ok).toBe(true);
  });

  it('a buyer and a publisher that share an id string do not share keys (owner kind is part of the match)', async () => {
    const rig = await makeV1Rig();
    const k = await rig.issue(PUB_A, 'api_client', ['catalogue:read']);
    const lookalike = { kind: 'buyer', buyer_id: 'pub_w0a' } as const;
    expect(await revokeKey(rig.keyDeps, lookalike, k.id)).toEqual({
      ok: false,
      error: 'not_found',
    });
    expect(await listKeys(rig.keyDeps, lookalike)).toEqual([]);
  });

  it('list shows only the owner own keys, oldest first, and never a hash or secret', async () => {
    const rig = await makeV1Rig();
    const a1 = await rig.issue(PUB_A, 'api_client', ['catalogue:read']);
    rig.clock.advance(1000);
    const a2 = await rig.issue(PUB_A, 'api_client', ['sales:read']);
    await rig.issue(PUB_B, 'api_client', ['catalogue:read']);
    await rig.issue(BUYER_B, 'agent', ['agent:buy']);
    const mine = await listKeys(rig.keyDeps, PUB_A);
    expect(mine.map((v) => v.id)).toEqual([a1.id, a2.id]);
    const text = JSON.stringify(mine);
    expect(text).not.toMatch(/secret|hash|umk_/i);
    for (const v of mine) {
      expect(Object.keys(v).sort()).toEqual(
        [
          'created_at',
          'id',
          'key_kind',
          'last_used_at',
          'owner_kind',
          'revoked_at',
          'scopes',
        ].sort(),
      );
    }
    expect((await listKeys(rig.keyDeps, BUYER_B)).map((v) => v.key_kind)).toEqual(['agent']);
  });

  it('list of an owner with no keys is empty', async () => {
    const rig = await makeV1Rig();
    expect(await listKeys(rig.keyDeps, BUYER_A)).toEqual([]);
  });
});

describe('audit of key changes', () => {
  it('issue and revoke write one audit row each, naming the key and never the secret', async () => {
    const rig = await makeV1Rig();
    const k0 = await rig.issue(PUB_A, 'api_client', ['catalogue:read']);
    void k0;
    rig.audit.length = 0;
    const deps = { ...rig.keyDeps, audit: rig.deps.audit };
    const issued = await issueKey(deps, {
      owner: PUB_A,
      key_kind: 'api_client',
      scopes: ['sales:read', 'catalogue:read'],
    });
    if (!issued.ok) throw new Error('issue failed');
    await revokeKey(deps, PUB_A, issued.value.id);
    await revokeKey(deps, PUB_B, issued.value.id);
    expect(rig.audit.map((e) => e.action)).toEqual(['api_key.issued', 'api_key.revoked']);
    expect(rig.audit[0]).toMatchObject({
      actor: PUB_A,
      target: issued.value.id,
      detail: {
        key_kind: 'api_client',
        owner_kind: 'publisher',
        scopes: 'catalogue:read,sales:read',
      },
    });
    expect(rig.audit[1]).toMatchObject({ actor: PUB_A, target: issued.value.id });
    const secret = parseKeyToken(issued.value.token)!.secret;
    expect(JSON.stringify(rig.audit)).not.toContain(secret);
    expect(JSON.stringify(rig.audit)).not.toContain('umk_');
  });

  it('a refused issue writes no audit row and no key', async () => {
    const rig = await makeV1Rig();
    const deps = { ...rig.keyDeps, audit: rig.deps.audit };
    await issueKey(deps, { owner: PUB_A, key_kind: 'api_client', scopes: ['agent:buy'] });
    expect(rig.audit).toEqual([]);
    expect(await listKeys(rig.keyDeps, PUB_A)).toEqual([]);
  });

  it('if the audit write fails the key is not created (same transaction)', async () => {
    const rig = await makeV1Rig();
    const deps = {
      ...rig.keyDeps,
      audit: {
        async record() {
          throw new Error('audit down');
        },
      },
    };
    await expect(
      issueKey(deps, { owner: PUB_A, key_kind: 'api_client', scopes: ['catalogue:read'] }),
    ).rejects.toThrow();
    expect(await listKeys(rig.keyDeps, PUB_A)).toEqual([]);
  });
});
