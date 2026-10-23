import { describe, expect, it } from 'vitest';
import { loadConfig, terminalEnv } from './index';

// BU-2 (ASM-51): the scope the app serves comes from UMS_OUTBOUND_SCOPE; the default is the MVP-B
// phase; an unknown value refuses boot instead of falling back to something wider.
const S1 = 'Qm7vK2pLx9RbT4zWc8NdYh3JfG6sAe1U';
const S2 = 'Zr5tB8nKd2VwXq7LmC4yHj9PgF3sEa6U';
const S3 = 'Jd4wN7xQk2ZcR9vTb5LmY8hGp3FsAe6U';
const base = (over: Record<string, string | undefined> = {}) => ({
  UMS_SESSION_SECRET: S1,
  UMS_APPROVAL_SECRET: S2,
  UMS_LINK_SECRET: S3,
  ...over,
});
const sandbox = (over: Record<string, string | undefined> = {}) =>
  base({
    UMS_MODE: 'sandbox',
    UMS_OUTBOUND_APPROVAL_REF: 'DL-2026-10-23-01',
    PAYPAL_CLIENT_ID: 'client-id-value',
    PAYPAL_CLIENT_SECRET: 'client-secret-value-xyz',
    ...over,
  });

describe('UMS_OUTBOUND_SCOPE', () => {
  it('defaults to mvp_b_polling, in both modes', () => {
    for (const env of [base(), sandbox()]) {
      const r = loadConfig(env);
      expect(r.ok && r.value.outbound_scope).toBe('mvp_b_polling');
    }
  });
  it.each(['mvp_b_polling', 'mvp_c_refunds'])('accepts %s', (scope) => {
    const r = loadConfig(sandbox({ UMS_OUTBOUND_SCOPE: scope }));
    expect(r.ok && r.value.outbound_scope).toBe(scope);
  });
  it.each(['', '  '])('an empty value %j means the default', (v) => {
    const r = loadConfig(sandbox({ UMS_OUTBOUND_SCOPE: v }));
    expect(r.ok && r.value.outbound_scope).toBe('mvp_b_polling');
  });
  it.each(['mvp_d_everything', 'MVP_C_REFUNDS', 'mvp_c_refunds,mvp_b_polling', 'live', 'spike'])(
    'refuses %j with invalid_value naming the variable, never the value',
    (v) => {
      const r = loadConfig(sandbox({ UMS_OUTBOUND_SCOPE: v }));
      expect(r.ok).toBe(false);
      if (r.ok) return;
      expect(r.error.name === 'UMS_OUTBOUND_SCOPE' || r.error.code === 'live_not_available').toBe(
        true,
      );
      expect(JSON.stringify(r.error)).not.toContain('mvp_d_everything');
    },
  );
});

describe('terminalEnv', () => {
  it('reports the CI and AI-session markers and nothing else', () => {
    const keys = Object.keys(terminalEnv()).sort();
    expect(keys).toEqual(['CI', 'CLAUDECODE', 'CLAUDE_CODE_REMOTE', 'GITHUB_ACTIONS']);
  });
});
