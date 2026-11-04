// API-W0 (F3): API key format, hashing and verification details. Unit level: format and digest rules,
// plus a spy on timingSafeEqual and the "same answer for every failure" rule. Database behaviour (issue,
// revoke, list, matrix) is in apikey.state.test.ts.
import { timingSafeEqual } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import {
  KEY_TOKEN_PATTERN,
  formatKeyToken,
  hashKeySecret,
  issueKey,
  parseKeyToken,
  verifyKey,
} from './apikey';
import { BUYER_A, PUB_A, fixedSecrets, makeV1Rig } from './v1-support';
import { expectOffline } from './offline-guard';

vi.mock('node:net', async (orig) => (await import('./offline-guard')).netMock(await orig()));
vi.mock('node:dns', async (orig) => (await import('./offline-guard')).dnsMock(await orig()));
vi.mock('node:crypto', async (orig) => {
  const actual = await orig<typeof import('node:crypto')>();
  return { ...actual, timingSafeEqual: vi.fn(actual.timingSafeEqual) };
});
expectOffline();

const ID26 = '0n31eja83zq8mgv3pbmdjtgswv';
const SECRET43 = 'A'.repeat(43);

describe('key token format', () => {
  it('is umk_<26 id characters>_<43 secret characters>', () => {
    const t = formatKeyToken(ID26, SECRET43);
    expect(t).toBe(`umk_${ID26}_${SECRET43}`);
    expect(KEY_TOKEN_PATTERN.test(t)).toBe(true);
    expect(parseKeyToken(t)).toEqual({ key_id: `key_${ID26}`, secret: SECRET43 });
  });

  it('a secret may contain - and _ and still parses on the fixed lengths', () => {
    const secret = `a_b-${'c'.repeat(39)}`;
    expect(secret.length).toBe(43);
    expect(parseKeyToken(formatKeyToken(ID26, secret))).toEqual({ key_id: `key_${ID26}`, secret });
  });

  it('refuses anything else: wrong prefix, lengths, characters, spaces, case of the id', () => {
    const bad = [
      '',
      'umk_',
      `umk_${ID26}_${'A'.repeat(42)}`,
      `umk_${ID26}_${'A'.repeat(44)}`,
      `umk_${ID26.slice(1)}_${SECRET43}`,
      `UMK_${ID26}_${SECRET43}`,
      `umk_${ID26.toUpperCase()}_${SECRET43}`,
      `umk_${ID26}-${SECRET43}`,
      `umk_${ID26}_${'A'.repeat(42)}!`,
      ` umk_${ID26}_${SECRET43}`,
      `umk_${ID26}_${SECRET43} `,
      `umk_${ID26}_${SECRET43}\n`,
      `xmk_${ID26}_${SECRET43}`,
      `umk_${ID26.replace('0', 'i')}_${SECRET43}`,
    ];
    for (const t of bad) expect(parseKeyToken(t), JSON.stringify(t)).toBeNull();
  });
});

describe('hashing', () => {
  it('stores sha256 hex, never the secret', () => {
    const h = hashKeySecret(SECRET43);
    expect(h).toMatch(/^[a-f0-9]{64}$/);
    expect(h).not.toBe(SECRET43);
    expect(h).not.toContain(SECRET43);
    expect(hashKeySecret(SECRET43)).toBe(h);
    expect(hashKeySecret(`${SECRET43}x`)).not.toBe(h);
  });
});

describe('issue', () => {
  it('draws the secret from the injected SecretSource (32 bytes, base64url), not from the Rng', async () => {
    const rig = await makeV1Rig();
    const issued = await rig.issue(PUB_A, 'api_client', ['catalogue:read']);
    const expectedSecret = Buffer.from(fixedSecrets().bytes(32)).toString('base64url');
    expect(expectedSecret.length).toBe(43);
    expect(issued.token.endsWith(`_${expectedSecret}`)).toBe(true);
    expect(issued.token.startsWith('umk_')).toBe(true);
    expect(KEY_TOKEN_PATTERN.test(issued.token)).toBe(true);
    expect(issued.token).toContain(issued.id.slice('key_'.length));
  });

  it('two keys from one source differ, and the stored hash is the hash of the secret only', async () => {
    const rig = await makeV1Rig();
    const a = await rig.issue(PUB_A, 'api_client', ['catalogue:read']);
    const b = await rig.issue(PUB_A, 'api_client', ['catalogue:read']);
    expect(a.token).not.toBe(b.token);
    expect(a.id).not.toBe(b.id);
    const parsed = parseKeyToken(a.token)!;
    const row = await rig.db.query<{ secret_hash: string }>(
      'SELECT secret_hash FROM api_keys WHERE id = $1',
      [a.id],
    );
    expect(row.rows[0]!.secret_hash).toBe(hashKeySecret(parsed.secret));
    expect(row.rows[0]!.secret_hash).not.toBe(parsed.secret);
    expect(JSON.stringify(row.rows)).not.toContain(parsed.secret);
  });

  it('the issue answer shows the secret once: the view fields hold no secret', async () => {
    const rig = await makeV1Rig();
    const issued = await rig.issue(BUYER_A, 'agent', ['agent:buy']);
    const secret = parseKeyToken(issued.token)!.secret;
    const { token, ...view } = issued;
    void token;
    expect(JSON.stringify(view)).not.toContain(secret);
    const direct = await issueKey(rig.keyDeps, {
      owner: BUYER_A,
      key_kind: 'agent',
      scopes: ['agent:buy'],
    });
    expect(direct.ok).toBe(true);
  });
});

describe('verify', () => {
  it('compares fixed-length digests with timingSafeEqual', async () => {
    const rig = await makeV1Rig();
    const issued = await rig.issue(PUB_A, 'api_client', ['catalogue:read']);
    const spy = vi.mocked(timingSafeEqual);
    spy.mockClear();
    const r = await verifyKey(rig.keyDeps, issued.token);
    expect(r.ok).toBe(true);
    expect(spy).toHaveBeenCalled();
    for (const [a, b] of spy.mock.calls) {
      expect(Buffer.from(a as Uint8Array).length).toBe(32);
      expect(Buffer.from(b as Uint8Array).length).toBe(32);
    }
  });

  it('still compares (against a dummy digest) when the id is unknown, so the path does the same work', async () => {
    const rig = await makeV1Rig();
    const spy = vi.mocked(timingSafeEqual);
    spy.mockClear();
    const r = await verifyKey(rig.keyDeps, formatKeyToken(ID26, SECRET43));
    expect(r.ok).toBe(false);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('gives the same answer for unknown id, wrong secret, malformed token and revoked key', async () => {
    const rig = await makeV1Rig();
    const issued = await rig.issue(PUB_A, 'api_client', ['catalogue:read']);
    const parsed = parseKeyToken(issued.token)!;
    const unknownId = await verifyKey(rig.keyDeps, formatKeyToken(ID26, parsed.secret));
    const wrongSecret = await verifyKey(
      rig.keyDeps,
      formatKeyToken(parsed.key_id.slice(4), SECRET43),
    );
    const malformed = await verifyKey(rig.keyDeps, 'umk_nonsense');
    await rig.db.query('UPDATE api_keys SET revoked_at = $2 WHERE id = $1', [
      issued.id,
      rig.clock.now().toISOString(),
    ]);
    const revoked = await verifyKey(rig.keyDeps, issued.token);
    for (const r of [unknownId, wrongSecret, malformed, revoked]) {
      expect(r).toEqual({ ok: false, error: 'invalid_key' });
    }
    expect(JSON.stringify(unknownId)).toBe(JSON.stringify(wrongSecret));
    expect(JSON.stringify(wrongSecret)).toBe(JSON.stringify(revoked));
    expect(JSON.stringify(malformed)).toBe(JSON.stringify(unknownId));
  });

  it('a secret that differs in one character fails', async () => {
    const rig = await makeV1Rig();
    const issued = await rig.issue(PUB_A, 'api_client', ['catalogue:read']);
    const { key_id, secret } = parseKeyToken(issued.token)!;
    const flipped = `${secret.slice(0, -1)}${secret.endsWith('A') ? 'B' : 'A'}`;
    expect((await verifyKey(rig.keyDeps, formatKeyToken(key_id.slice(4), flipped))).ok).toBe(false);
    expect((await verifyKey(rig.keyDeps, issued.token)).ok).toBe(true);
  });
});
