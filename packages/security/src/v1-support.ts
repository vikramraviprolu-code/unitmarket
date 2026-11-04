// Test support for the API-W0 suites. Not exported from index. A rig with a real PGlite database
// (migrated with the common set, including api_keys), a fixed SecretSource (never the seeded Rng), two
// buyers that agent keys may point at, and helpers that issue keys and build bearer requests.
import { createHash } from 'node:crypto';
import type { Actor, AuditEntry, Clock, SecretSource } from '@umsbx/contracts';
import { issueKey, type ApiKeyDeps, type IssuedKey } from './apikey';
import type { Scope } from '@umsbx/contracts';
import { ORIGIN, makeRig, type TestRig } from './test-support';

export { ORIGIN };

/** Deterministic bytes per call: sha256(seed:n), extended by counter blocks when more are asked for. */
export function fixedSecrets(seed = 'w0-fixed'): SecretSource {
  let n = 0;
  return {
    bytes(len: number): Uint8Array {
      const out: number[] = [];
      let block = 0;
      while (out.length < len) {
        out.push(...createHash('sha256').update(`${seed}:${n}:${block++}`).digest());
      }
      n += 1;
      return Uint8Array.from(out.slice(0, len));
    },
  };
}

export const BUYER_A: Actor = { kind: 'buyer', buyer_id: 'buy_w0a' };
export const BUYER_B: Actor = { kind: 'buyer', buyer_id: 'buy_w0b' };
export const PUB_A: Actor = { kind: 'publisher', publisher_id: 'pub_w0a' };
export const PUB_B: Actor = { kind: 'publisher', publisher_id: 'pub_w0b' };
export const OPR_MFA: Actor = { kind: 'operator', operator_id: 'opr_w0', mfa: true };
export const OPR_PLAIN: Actor = { kind: 'operator', operator_id: 'opr_w0', mfa: false };

export interface V1Rig extends TestRig {
  secrets: SecretSource;
  keyDeps: ApiKeyDeps;
  /** Issue a key and return its token, id and the audit entries written so far. */
  issue(
    owner: Actor,
    key_kind: 'api_client' | 'agent',
    scopes: readonly Scope[],
  ): Promise<IssuedKey>;
  bearer(
    token: string,
    init?: { method?: string; url?: string; body?: unknown; headers?: Record<string, string> },
  ): Request;
  auditOf(action: string): AuditEntry[];
}

export async function makeV1Rig(): Promise<V1Rig> {
  const rig = await makeRig();
  await rig.db.exec('TRUNCATE api_keys CASCADE');
  for (const id of ['buy_w0a', 'buy_w0b']) {
    await rig.db.query(
      `INSERT INTO buyers (id, display_name, auth_subject, country, created_at, updated_at)
       VALUES ($1, 'W0', $2, 'GB', $3, $3) ON CONFLICT (id) DO NOTHING`,
      [id, `w0:${id}`, rig.clock.now().toISOString()],
    );
  }
  const secrets = fixedSecrets();
  const keyDeps: ApiKeyDeps = {
    db: rig.deps.db,
    clock: rig.deps.clock as Clock,
    ids: rig.deps.ids,
    secrets,
  };
  return {
    ...rig,
    secrets,
    keyDeps,
    async issue(owner, key_kind, scopes) {
      if (owner.kind === 'system') throw new Error('system cannot own a key');
      const r = await issueKey(keyDeps, { owner, key_kind, scopes });
      if (!r.ok) throw new Error(`issue refused: ${r.error}`);
      return r.value;
    },
    bearer(token, init = {}) {
      const method = init.method ?? 'GET';
      const headers: Record<string, string> = {
        authorization: `Bearer ${token}`,
        ...(init.headers ?? {}),
      };
      const req: RequestInit = { method, headers };
      if (init.body !== undefined) {
        req.body = typeof init.body === 'string' ? init.body : JSON.stringify(init.body);
        headers['content-type'] = 'application/json';
      }
      return new Request(`${ORIGIN}${init.url ?? '/api/v1/ping'}`, req);
    },
    auditOf: (action) => rig.audit.filter((e) => e.action === action),
  };
}
