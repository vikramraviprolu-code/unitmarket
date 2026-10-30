// CFG-0 (D-065 items 15, 16, 34, 35; D-066): the four names the overnight lanes read. Each has a safe
// default, a bad value stops the boot naming the variable only, and the model key never leaves its Secret.
import { readFileSync } from 'node:fs';
import { inspect } from 'node:util';
import { describe, expect, it } from 'vitest';
import { loadConfig, refusalLine } from './index';
import type { Config } from './index';
import { ENV_NAMES } from './schema';

const S1 = 'Qm7vK2pLx9RbT4zWc8NdYh3JfG6sAe1U';
const S2 = 'Zr5tB8nKd2VwXq7LmC4yHj9PgF3sEa6U';
const S3 = 'Jd4wN7xQk2ZcR9vTb5LmY8hGp3FsAe6U';
const SALT = '00112233445566778899aabbccddeeff';
const KEY = 'ab'.repeat(32);
const DEMO_HASH = `scrypt:16384:8:1:${SALT}:${KEY}`;
const DEMO_HASH_OLD_FORM = `scrypt$16384$8$1$${SALT}$${KEY}`;
const PUBLISHER_HASH = `scrypt:16384:8:1:${'cd'.repeat(16)}:${'ef'.repeat(32)}`;
const API_KEY = 'sk-test-NOT-A-REAL-KEY-0123456789abcdef';

type Over = Record<string, string | undefined>;
const base = (over: Over = {}) => ({
  UMS_SESSION_SECRET: S1,
  UMS_APPROVAL_SECRET: S2,
  UMS_LINK_SECRET: S3,
  ...over,
});
const sandbox = (over: Over = {}) =>
  base({
    UMS_MODE: 'sandbox',
    UMS_OUTBOUND_APPROVAL_REF: 'DL-2026-10-30-01',
    PAYPAL_CLIENT_ID: 'client-id-value',
    PAYPAL_CLIENT_SECRET: 'client-secret-value-xyz',
    ...over,
  });
const cfg = (env: Over): Config => {
  const r = loadConfig(env);
  if (!r.ok) throw new Error(`unexpected refusal ${r.error.code} ${r.error.name}`);
  return r.value;
};

describe('defaults when the four names are unset', () => {
  it.each([
    ['offline', base()],
    ['sandbox', sandbox()],
  ])('%s: safe defaults', (_n, env) => {
    const c = cfg(env);
    expect(c.publisher_passcode_hash).toBeNull();
    expect(c.offer_max_minor).toBe(2000);
    expect(c.ai_adapter).toBe('scripted');
    expect(c.ai_api_key).toBeNull();
  });
  it('blank values mean the default', () => {
    const c = cfg(
      base({
        UMS_PUBLISHER_PASSCODE_HASH: '  ',
        UMS_OFFER_MAX_MINOR: '',
        UMS_AI_ADAPTER: ' ',
        UMS_ANTHROPIC_API_KEY: '',
      }),
    );
    expect(c.publisher_passcode_hash).toBeNull();
    expect(c.offer_max_minor).toBe(2000);
    expect(c.ai_adapter).toBe('scripted');
    expect(c.ai_api_key).toBeNull();
  });
});

describe('UMS_PUBLISHER_PASSCODE_HASH', () => {
  const NAME = 'UMS_PUBLISHER_PASSCODE_HASH';
  it('accepts the new and the old form and trims blanks', () => {
    for (const v of [
      PUBLISHER_HASH,
      PUBLISHER_HASH.replaceAll(':', '$'),
      `  ${PUBLISHER_HASH}  `,
    ]) {
      expect(cfg(base({ [NAME]: v })).publisher_passcode_hash).toBe(v.trim());
    }
  });
  it('is independent of the demo hash when the two differ', () => {
    const c = cfg(base({ UMS_DEMO_PASSCODE_HASH: DEMO_HASH, [NAME]: PUBLISHER_HASH }));
    expect(c.passcode_hash).toBe(DEMO_HASH);
    expect(c.publisher_passcode_hash).toBe(PUBLISHER_HASH);
  });
  it.each([
    ['dotenv mangled', 'scrypt6384'],
    ['plain text', 'not a hash'],
    ['short key', `scrypt:16384:8:1:${SALT}:abcd`],
    ['zero work factor', `scrypt:0:8:1:${SALT}:${KEY}`],
    ['mixed separators', `scrypt:16384$8$1$${SALT}$${KEY}`],
  ])('refuses a malformed value (%s) with invalid_value, never printing it', (_n, v) => {
    const r = loadConfig(base({ [NAME]: v }));
    expect(!r.ok && r.error).toEqual({ code: 'invalid_value', name: NAME });
    expect(!r.ok && refusalLine(r.error)).not.toContain(v);
  });
  it('refuses a value equal to the demo hash (decision 34), in either form', () => {
    for (const [demo, pub] of [
      [DEMO_HASH, DEMO_HASH],
      [DEMO_HASH, `  ${DEMO_HASH}  `],
      [DEMO_HASH, DEMO_HASH_OLD_FORM],
      [DEMO_HASH_OLD_FORM, DEMO_HASH],
    ] as const) {
      const r = loadConfig(base({ UMS_DEMO_PASSCODE_HASH: demo, [NAME]: pub }));
      expect(!r.ok && r.error).toEqual({ code: 'equal_secrets', name: NAME });
      expect(!r.ok && refusalLine(r.error)).not.toContain(KEY);
    }
  });
  it('does not need the demo hash, and does not satisfy the production demo-hash rule', () => {
    expect(cfg(base({ [NAME]: PUBLISHER_HASH })).passcode_hash).toBeNull();
    const r = loadConfig(
      base({
        NODE_ENV: 'production',
        UMS_PUBLIC_ORIGIN: 'https://um.example.org',
        [NAME]: PUBLISHER_HASH,
      }),
    );
    expect(!r.ok && r.error).toEqual({ code: 'missing_value', name: 'UMS_DEMO_PASSCODE_HASH' });
  });
});

describe('UMS_OFFER_MAX_MINOR', () => {
  const NAME = 'UMS_OFFER_MAX_MINOR';
  it.each(['1', '250', '1999', '2000', ' 2000 '])('accepts %j', (v) => {
    expect(cfg(base({ [NAME]: v })).offer_max_minor).toBe(Number(v));
  });
  it.each([
    '0',
    '2001',
    '-1',
    '99999',
    'abc',
    '12.5',
    '1e3',
    '0x10',
    '+5',
    '2 000',
    '02000',
    '1,000',
  ])('refuses %j with invalid_value naming the variable only', (v) => {
    const r = loadConfig(base({ [NAME]: v }));
    expect(!r.ok && r.error).toEqual({ code: 'invalid_value', name: NAME });
    expect(!r.ok && refusalLine(r.error)).not.toContain(v);
  });
});

describe('UMS_AI_ADAPTER and UMS_ANTHROPIC_API_KEY', () => {
  const NAME = 'UMS_AI_ADAPTER';
  const KEY_NAME = 'UMS_ANTHROPIC_API_KEY';
  it('accepts scripted without a key', () => {
    const c = cfg(base({ [NAME]: 'scripted' }));
    expect(c.ai_adapter).toBe('scripted');
    expect(c.ai_api_key).toBeNull();
  });
  it('claude with a key wraps it as a Secret', () => {
    const c = cfg(base({ [NAME]: 'claude', [KEY_NAME]: API_KEY }));
    expect(c.ai_adapter).toBe('claude');
    expect(c.ai_api_key?.reveal()).toBe(API_KEY);
  });
  it('claude works in sandbox mode too', () => {
    expect(cfg(sandbox({ [NAME]: 'claude', [KEY_NAME]: API_KEY })).ai_adapter).toBe('claude');
  });
  it.each([undefined, '', '   '])('refuses claude without a key (%j) with missing_value', (v) => {
    const r = loadConfig(base({ [NAME]: 'claude', [KEY_NAME]: v }));
    expect(!r.ok && r.error).toEqual({ code: 'missing_value', name: KEY_NAME });
  });
  it.each(['live', 'production', 'Claude', 'SCRIPTED', 'openai', 'claude,scripted', 'none'])(
    'refuses the adapter %j with invalid_value naming the variable only',
    (v) => {
      const r = loadConfig(base({ [NAME]: v, [KEY_NAME]: API_KEY }));
      expect(!r.ok && r.error).toEqual({ code: 'invalid_value', name: NAME });
      expect(!r.ok && refusalLine(r.error)).not.toContain(API_KEY);
    },
  );
  it('reads the key only when the adapter is claude (scripted ignores it)', () => {
    for (const env of [
      base({ [KEY_NAME]: API_KEY }),
      base({ [NAME]: 'scripted', [KEY_NAME]: API_KEY }),
    ]) {
      expect(cfg(env).ai_api_key).toBeNull();
    }
  });
  it('never picks up ANTHROPIC_API_KEY from the environment', () => {
    const c = cfg(base({ [NAME]: 'scripted', ANTHROPIC_API_KEY: API_KEY }));
    expect(c.ai_api_key).toBeNull();
    const r = loadConfig(base({ [NAME]: 'claude', ANTHROPIC_API_KEY: API_KEY }));
    expect(!r.ok && r.error).toEqual({ code: 'missing_value', name: KEY_NAME });
  });
});

describe('the key never leaves its Secret', () => {
  const c = cfg(base({ UMS_AI_ADAPTER: 'claude', UMS_ANTHROPIC_API_KEY: API_KEY }));
  it('is absent from JSON, string conversion and inspect of the config', () => {
    expect(JSON.stringify(c)).not.toContain(API_KEY);
    expect(inspect(c, { depth: 6 })).not.toContain(API_KEY);
    expect(String(c.ai_api_key)).not.toContain(API_KEY);
    expect(JSON.stringify(c)).toContain('[redacted]');
  });
  it('is absent from every refusal line raised with the key present', () => {
    const bad: Over[] = [
      { UMS_OFFER_MAX_MINOR: '0' },
      { UMS_PUBLISHER_PASSCODE_HASH: 'scrypt6384' },
      { UMS_AI_ADAPTER: 'claude', UMS_SESSION_SECRET: 'short' },
      { UMS_MODE: 'live' },
    ];
    for (const over of bad) {
      const r = loadConfig(
        base({ UMS_ANTHROPIC_API_KEY: API_KEY, UMS_AI_ADAPTER: 'claude', ...over }),
      );
      expect(r.ok).toBe(false);
      if (!r.ok) expect(refusalLine(r.error)).not.toContain(API_KEY);
    }
  });
});

describe('names', () => {
  const NAMES = [
    'UMS_PUBLISHER_PASSCODE_HASH',
    'UMS_OFFER_MAX_MINOR',
    'UMS_AI_ADAPTER',
    'UMS_ANTHROPIC_API_KEY',
  ];
  it('ENV_NAMES lists the four, and not the bare provider name', () => {
    for (const n of NAMES) expect(ENV_NAMES).toContain(n);
    expect(ENV_NAMES).not.toContain('ANTHROPIC_API_KEY');
  });
  it('.env.example holds them with empty values and a comment above', () => {
    const lines = readFileSync(new URL('../../../.env.example', import.meta.url), 'utf8').split(
      '\n',
    );
    for (const n of NAMES) {
      const i = lines.indexOf(`${n}=`);
      expect(i, n).toBeGreaterThan(0);
      expect(lines[i - 1]?.startsWith('#'), `${n} has a comment`).toBe(true);
    }
    expect(lines.some((l) => /^ANTHROPIC_API_KEY=/.test(l))).toBe(false);
  });
});
