// JUDGE-A: UMS_JUDGE_PASSCODE_HASH. Optional, same shape as the demo hash, never equal to the demo or the
// publisher hash. A bad value stops the boot naming the variable only.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { loadConfig } from './index';
import { refusalLine } from './refusal';
import { ENV_NAMES } from './schema';
import type { Config } from './schema';

const S1 = 'Qm7vK2pLx9RbT4zWc8NdYh3JfG6sAe1U';
const S2 = 'Zr5tB8nKd2VwXq7LmC4yHj9PgF3sEa6U';
const S3 = 'Jd4wN7xQk2ZcR9vTb5LmY8hGp3FsAe6U';
const SALT = '00112233445566778899aabbccddeeff';
const KEY = 'ab'.repeat(32);
const DEMO = `scrypt:16384:8:1:${SALT}:${KEY}`;
const DEMO_OLD = `scrypt$16384$8$1$${SALT}$${KEY}`;
const PUB = `scrypt:16384:8:1:${'cd'.repeat(16)}:${'ef'.repeat(32)}`;
const JUDGE = `scrypt:16384:8:1:${'12'.repeat(16)}:${'34'.repeat(32)}`;
const NAME = 'UMS_JUDGE_PASSCODE_HASH';

type Over = Record<string, string | undefined>;
const base = (over: Over = {}) => ({
  UMS_SESSION_SECRET: S1,
  UMS_APPROVAL_SECRET: S2,
  UMS_LINK_SECRET: S3,
  ...over,
});
const cfg = (env: Over): Config => {
  const r = loadConfig(env);
  if (!r.ok) throw new Error(`unexpected refusal ${r.error.code} ${r.error.name}`);
  return r.value;
};

describe('UMS_JUDGE_PASSCODE_HASH', () => {
  it('defaults to null, and a blank value means unset', () => {
    expect(cfg(base()).judge_passcode_hash).toBeNull();
    expect(cfg(base({ [NAME]: '   ' })).judge_passcode_hash).toBeNull();
  });
  it('accepts the colon and the dollar form and trims blanks', () => {
    for (const v of [JUDGE, JUDGE.replaceAll(':', '$'), `  ${JUDGE}  `]) {
      expect(cfg(base({ [NAME]: v })).judge_passcode_hash).toBe(v.trim());
    }
  });
  it('is independent of the demo and publisher hashes when all three differ', () => {
    const c = cfg(
      base({ UMS_DEMO_PASSCODE_HASH: DEMO, UMS_PUBLISHER_PASSCODE_HASH: PUB, [NAME]: JUDGE }),
    );
    expect(c.passcode_hash).toBe(DEMO);
    expect(c.publisher_passcode_hash).toBe(PUB);
    expect(c.judge_passcode_hash).toBe(JUDGE);
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
  it('refuses a value equal to the demo hash, in either form', () => {
    for (const [demo, judge] of [
      [DEMO, DEMO],
      [DEMO, `  ${DEMO}  `],
      [DEMO, DEMO_OLD],
      [DEMO_OLD, DEMO],
    ] as const) {
      const r = loadConfig(base({ UMS_DEMO_PASSCODE_HASH: demo, [NAME]: judge }));
      expect(!r.ok && r.error).toEqual({ code: 'equal_secrets', name: NAME });
      expect(!r.ok && refusalLine(r.error)).not.toContain(KEY);
    }
  });
  it('refuses a value equal to the publisher hash, in either form', () => {
    for (const [pub, judge] of [
      [PUB, PUB],
      [PUB, PUB.replaceAll(':', '$')],
      [PUB.replaceAll(':', '$'), `  ${PUB}  `],
    ] as const) {
      const r = loadConfig(base({ UMS_PUBLISHER_PASSCODE_HASH: pub, [NAME]: judge }));
      expect(!r.ok && r.error).toEqual({ code: 'equal_secrets', name: NAME });
      expect(!r.ok && refusalLine(r.error)).not.toContain('ef'.repeat(32));
    }
  });
  it('is not satisfied by the production demo-hash rule', () => {
    const r = loadConfig(
      base({ NODE_ENV: 'production', UMS_PUBLIC_ORIGIN: 'https://um.example.org', [NAME]: JUDGE }),
    );
    expect(!r.ok && r.error).toEqual({ code: 'missing_value', name: 'UMS_DEMO_PASSCODE_HASH' });
  });
  it('is in ENV_NAMES, and .env.example holds the name with an empty value', () => {
    expect(ENV_NAMES).toContain(NAME);
    const lines = readFileSync(new URL('../../../.env.example', import.meta.url), 'utf8').split(
      '\n',
    );
    const i = lines.indexOf(`${NAME}=`);
    expect(i).toBeGreaterThan(0);
    expect(lines[i - 1]?.startsWith('#')).toBe(true);
  });
});
