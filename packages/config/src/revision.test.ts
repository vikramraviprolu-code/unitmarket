import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { loadConfig } from './index';
import { ENV_NAMES } from './schema';

// INT-CL1 (R2-3): the Cloud Run revision name, read from K_REVISION by this package only (lint S3). It is
// shown on the public status route; it is not a secret and no switch depends on it.
const S1 = 'Qm7vK2pLx9RbT4zWc8NdYh3JfG6sAe1U';
const S2 = 'Zr5tB8nKd2VwXq7LmC4yHj9PgF3sEa6U';
const S3 = 'Jd4wN7xQk2ZcR9vTb5LmY8hGp3FsAe6U';
const env = (over: Record<string, string | undefined> = {}) => ({
  UMS_SESSION_SECRET: S1,
  UMS_APPROVAL_SECRET: S2,
  UMS_LINK_SECRET: S3,
  ...over,
});

describe('K_REVISION in the config', () => {
  it('is null when unset or empty (off Cloud Run)', () => {
    for (const v of [undefined, '']) {
      const r = loadConfig(env({ K_REVISION: v }));
      expect(r.ok && r.value.revision).toBeNull();
    }
  });

  it('is the revision name when it looks like one', () => {
    const r = loadConfig(env({ K_REVISION: 'unitmarket-sandbox-00031-x7k' }));
    expect(r.ok && r.value.revision).toBe('unitmarket-sandbox-00031-x7k');
  });

  it('refuses a value that is not a plain revision name', () => {
    for (const v of ['Has Space', 'x;y', 'UPPER', '../x', 'a'.repeat(100), '-lead']) {
      const r = loadConfig(env({ K_REVISION: v }));
      expect(r.ok, v).toBe(false);
      expect(!r.ok && r.error).toEqual({ code: 'invalid_value', name: 'K_REVISION' });
    }
  });

  it('is in ENV_NAMES and .env.example holds the name with an empty value', () => {
    expect(ENV_NAMES).toContain('K_REVISION');
    const lines = readFileSync(new URL('../../../.env.example', import.meta.url), 'utf8').split(
      '\n',
    );
    const i = lines.indexOf('K_REVISION=');
    expect(i).toBeGreaterThan(0);
    expect(lines[i - 1]?.startsWith('#')).toBe(true);
  });
});
