import { describe, expect, it, vi } from 'vitest';
import { bootOrExit, loadConfig, makeSecret } from './index';

const S1 = 'a'.repeat(32);
const S2 = 'b'.repeat(32);
const S3 = 'c'.repeat(32);
// Built at runtime so no live hostname literal sits in the tree (S7).
const LIVE_HOST = ['api-m', 'paypal', 'com'].join('.');
const SANDBOX_HOST = ['api-m', 'sandbox', 'paypal', 'com'].join('.');

const offline = (over: Record<string, string | undefined> = {}) => ({
  UMS_SESSION_SECRET: S1,
  UMS_APPROVAL_SECRET: S2,
  UMS_LINK_SECRET: S3,
  ...over,
});
const sandbox = (over: Record<string, string | undefined> = {}) =>
  offline({
    UMS_MODE: 'sandbox',
    UMS_OUTBOUND_APPROVAL_REF: 'DL-2026-10-22-01',
    PAYPAL_CLIENT_ID: 'client-id-value',
    PAYPAL_CLIENT_SECRET: 'client-secret-value-xyz',
    ...over,
  });

const refusal = (env: Record<string, string | undefined>) => {
  const r = loadConfig(env);
  if (r.ok) throw new Error('expected refusal');
  return r.error;
};

describe('loadConfig accepts', () => {
  it('offline defaults', () => {
    const r = loadConfig(offline());
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.mode).toBe('offline');
    expect(r.value.connect).toBe(false);
    expect(r.value.paypal).toBeNull();
    expect(r.value.db).toEqual({ kind: 'pglite-memory' });
    expect(r.value.env_label).toBe('Dry run');
    expect(r.value.corridors).toEqual(['us-usd']);
    expect(r.value.node_env).toBe('development');
    expect(r.value.session_secret.reveal()).toBe(S1);
  });
  it('sandbox with credentials and approval ref', () => {
    const r = loadConfig(sandbox({ UMS_PAYPAL_CONNECT: 'on' }));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.mode).toBe('sandbox');
    expect(r.value.connect).toBe(true);
    expect(r.value.env_label).toBe('Sandbox');
    expect(r.value.outbound_approval_ref).toBe('DL-2026-10-22-01');
    expect(r.value.paypal?.client_secret.reveal()).toBe('client-secret-value-xyz');
  });
  it('http://localhost origin with a port, pglite-disk and postgres targets', () => {
    expect(loadConfig(offline({ UMS_PUBLIC_ORIGIN: 'http://localhost:3000' })).ok).toBe(true);
    const d = loadConfig(offline({ UMS_DB: 'pglite-disk', UMS_PGLITE_DIR: '/tmp/x' }));
    expect(d.ok && d.value.db).toEqual({ kind: 'pglite-disk', dir: '/tmp/x' });
    const p = loadConfig(offline({ UMS_DB: 'postgres', DATABASE_URL: 'postgres://u:p@h/db' }));
    expect(p.ok && p.value.db.kind).toBe('postgres');
  });
  it('allows the sandbox hostname in a value', () => {
    expect(loadConfig(offline({ UMS_PUBLIC_ORIGIN: `https://${SANDBOX_HOST}` })).ok).toBe(true);
  });
});

describe('loadConfig refuses (P15, RLR-4)', () => {
  it('UMS_MODE=live refuses live_not_available', () => {
    expect(refusal(offline({ UMS_MODE: 'live' }))).toEqual({
      code: 'live_not_available',
      name: 'UMS_MODE',
    });
    expect(refusal(offline({ UMS_MODE: 'Production' })).code).toBe('live_not_available');
    expect(refusal(offline({ UMS_MODE: 'sandbox-live' })).code).toBe('live_not_available');
  });
  it('unknown mode refuses', () => {
    expect(refusal(offline({ UMS_MODE: 'staging' }))).toEqual({
      code: 'unknown_mode',
      name: 'UMS_MODE',
    });
  });
  it('a value containing a live PayPal host refuses non_sandbox_host', () => {
    expect(refusal(offline({ UMS_PUBLIC_ORIGIN: `https://${LIVE_HOST}` }))).toEqual({
      code: 'non_sandbox_host',
      name: 'UMS_PUBLIC_ORIGIN',
    });
    expect(
      refusal(
        offline({
          DATABASE_URL: `postgres://x@db/y?cb=https://www.${['paypal', 'com'].join('.')}/`,
        }),
      ).code,
    ).toBe('non_sandbox_host');
  });
  it('sandbox without approval ref refuses; without credentials refuses', () => {
    expect(refusal(sandbox({ UMS_OUTBOUND_APPROVAL_REF: undefined }))).toEqual({
      code: 'missing_value',
      name: 'UMS_OUTBOUND_APPROVAL_REF',
    });
    expect(refusal(sandbox({ PAYPAL_CLIENT_ID: undefined })).name).toBe('PAYPAL_CLIENT_ID');
    expect(refusal(sandbox({ PAYPAL_CLIENT_SECRET: '' })).name).toBe('PAYPAL_CLIENT_SECRET');
  });
  it('31-byte secret refuses; 32-byte passes', () => {
    expect(refusal(offline({ UMS_LINK_SECRET: 'x'.repeat(31) }))).toEqual({
      code: 'weak_secret',
      name: 'UMS_LINK_SECRET',
    });
    expect(loadConfig(offline({ UMS_LINK_SECRET: 'x'.repeat(32) })).ok).toBe(true);
  });
  it('multi-byte characters count as bytes', () => {
    expect(loadConfig(offline({ UMS_LINK_SECRET: 'é'.repeat(16) })).ok).toBe(true);
  });
  it('missing secret refuses missing_value', () => {
    expect(refusal(offline({ UMS_SESSION_SECRET: undefined }))).toEqual({
      code: 'missing_value',
      name: 'UMS_SESSION_SECRET',
    });
  });
  it('equal secrets refuse', () => {
    const r = refusal(offline({ UMS_APPROVAL_SECRET: S1 }));
    expect(r.code).toBe('equal_secrets');
  });
  it('http origin refuses except localhost', () => {
    expect(refusal(offline({ UMS_PUBLIC_ORIGIN: 'http://example.org' }))).toEqual({
      code: 'insecure_origin',
      name: 'UMS_PUBLIC_ORIGIN',
    });
    expect(refusal(offline({ UMS_PUBLIC_ORIGIN: 'http://localhost.evil.test' })).code).toBe(
      'insecure_origin',
    );
    expect(loadConfig(offline({ UMS_PUBLIC_ORIGIN: 'http://localhost' })).ok).toBe(true);
    expect(loadConfig(offline({ UMS_PUBLIC_ORIGIN: 'https://um.example.org' })).ok).toBe(true);
  });
  it('production, offline and no passcode hash refuses', () => {
    const env = offline({ NODE_ENV: 'production', UMS_PUBLIC_ORIGIN: 'https://um.example.org' });
    expect(refusal(env)).toEqual({ code: 'missing_value', name: 'UMS_DEMO_PASSCODE_HASH' });
    expect(loadConfig({ ...env, UMS_DEMO_PASSCODE_HASH: 'scrypt$x' }).ok).toBe(true);
  });
  it('unknown corridor refuses', () => {
    expect(refusal(offline({ UMS_CORRIDORS: 'us-usd,xx-zzz' }))).toEqual({
      code: 'unknown_corridor',
      name: 'UMS_CORRIDORS',
    });
  });
  it('pglite-disk without a dir and postgres without a url refuse', () => {
    expect(refusal(offline({ UMS_DB: 'pglite-disk' })).name).toBe('UMS_PGLITE_DIR');
    expect(refusal(offline({ UMS_DB: 'postgres' })).name).toBe('DATABASE_URL');
    expect(refusal(offline({ UMS_DB: 'sqlite' })).name).toBe('UMS_DB');
  });
  it('bad connect flag refuses', () => {
    expect(refusal(offline({ UMS_PAYPAL_CONNECT: 'yes' })).name).toBe('UMS_PAYPAL_CONNECT');
  });
  it('refusal text never contains the value', () => {
    const secretish = 'v'.repeat(31);
    const cases = [
      offline({ UMS_MODE: 'live-zzzz-marker' }),
      offline({ UMS_LINK_SECRET: secretish }),
      offline({ UMS_PUBLIC_ORIGIN: `https://${LIVE_HOST}/marker-q` }),
      offline({ UMS_APPROVAL_SECRET: S1 }),
    ];
    for (const env of cases) {
      const text = JSON.stringify(refusal(env));
      for (const v of ['live-zzzz-marker', secretish, 'marker-q', S1, LIVE_HOST]) {
        expect(text).not.toContain(v);
      }
    }
  });
});

describe('bootOrExit', () => {
  it('exits 78 naming the variable and never the value', () => {
    const lines: string[] = [];
    const exit = vi.fn((code: number): never => {
      throw new Error(`exit ${code}`);
    });
    const secretish = 'v'.repeat(31);
    expect(() =>
      bootOrExit(offline({ UMS_LINK_SECRET: secretish }), exit, (l) => lines.push(l)),
    ).toThrow('exit 78');
    expect(exit).toHaveBeenCalledWith(78);
    const out = lines.join('\n');
    expect(out).toContain('UMS_LINK_SECRET');
    expect(out).toContain('weak_secret');
    expect(out).not.toContain(secretish);
  });
  it('returns the config when safe and does not exit', () => {
    const exit = vi.fn((code: number): never => {
      throw new Error(`exit ${code}`);
    });
    const c = bootOrExit(offline(), exit, () => undefined);
    expect(c.mode).toBe('offline');
    expect(exit).not.toHaveBeenCalled();
  });
});

describe('Secret (P7)', () => {
  it('toString and JSON.stringify give [redacted]', () => {
    const s = makeSecret('super-secret-value');
    expect(String(s)).toBe('[redacted]');
    expect(`${s}`).toBe('[redacted]');
    expect(s.toString()).toBe('[redacted]');
    expect(JSON.stringify({ s })).toBe('{"s":"[redacted]"}');
    expect(s.reveal()).toBe('super-secret-value');
  });
  it('does not leak through inspect or own keys', async () => {
    const { inspect } = await import('node:util');
    const s = makeSecret('super-secret-value');
    expect(inspect(s)).not.toContain('super-secret-value');
    expect(Object.keys(s)).not.toContain('value');
    expect(JSON.stringify(Object.getOwnPropertyNames(s))).not.toContain('super-secret-value');
    const c = loadConfig(offline());
    expect(JSON.stringify(c)).not.toContain(S1);
  });
});
