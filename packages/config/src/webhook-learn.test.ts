// CO-1d (D-038): the webhook certificate learn window is controlled by one variable, read only here.
// Sandbox mode only, a strict UTC time, never a value in an error. The 24 h cap is checked against
// the injected clock by webhookLearnWindow (composition passes its clock; config never reads time).
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { loadConfig, webhookLearnWindow } from './index';
import { ENV_NAMES } from './schema';
import { refusalLine } from './refusal';

const NAME = 'UMS_WEBHOOK_CERT_LEARN_UNTIL';
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
    UMS_OUTBOUND_APPROVAL_REF: 'DL-2026-10-25-01',
    PAYPAL_CLIENT_ID: 'client-id-value',
    PAYPAL_CLIENT_SECRET: 'client-secret-value-xyz',
    ...over,
  });
const refusal = (env: Record<string, string | undefined>) => {
  const r = loadConfig(env);
  if (r.ok) throw new Error('expected refusal');
  return r.error;
};

describe('UMS_WEBHOOK_CERT_LEARN_UNTIL in loadConfig', () => {
  it('is a known variable name and is listed in .env.example with no value', () => {
    expect(ENV_NAMES).toContain(NAME);
    const lines = readFileSync(new URL('../../../.env.example', import.meta.url), 'utf8').split(
      '\n',
    );
    expect(lines).toContain(`${NAME}=`);
  });

  it('unset or blank: no window', () => {
    for (const v of [undefined, '', '   ']) {
      const r = loadConfig(sandbox({ [NAME]: v }));
      expect(r.ok && r.value.webhook_cert_learn_until).toBeNull();
    }
    const o = loadConfig(base());
    expect(o.ok && o.value.webhook_cert_learn_until).toBeNull();
  });

  it('sandbox mode with a strict UTC time: stored as an ISO string', () => {
    const r = loadConfig(sandbox({ [NAME]: '2026-10-25T18:30:00Z' }));
    expect(r.ok && r.value.webhook_cert_learn_until).toBe('2026-10-25T18:30:00.000Z');
  });

  it('milliseconds are accepted when written as exactly three digits (what Date.toISOString prints)', () => {
    const r = loadConfig(sandbox({ [NAME]: '2026-10-25T18:30:00.250Z' }));
    expect(r.ok && r.value.webhook_cert_learn_until).toBe('2026-10-25T18:30:00.250Z');
  });

  it('a value in the past still boots (the window is simply closed)', () => {
    const r = loadConfig(sandbox({ [NAME]: '2020-01-01T00:00:00Z' }));
    expect(r.ok).toBe(true);
  });

  it.each([
    'tomorrow',
    '2026-10-25',
    '2026-10-25T18:30:00',
    '2026-10-25T18:30:00+02:00',
    '2026-10-25T18:30:00.5Z',
    '2026-10-25T18:30:00.1234Z',
    '2026-10-25 18:30:00Z',
    '2026-02-30T00:00:00Z',
    '2026-10-25T24:00:00Z',
    '2026-10-25T18:60:00Z',
    '1793000000',
    '0',
    'on',
    '2026-10-25T18:30:00Zjunk',
  ])('refuses the malformed value %s, naming the variable and never the value', (v) => {
    const e = refusal(sandbox({ [NAME]: v }));
    expect(e).toEqual({ code: 'invalid_value', name: NAME });
    expect(refusalLine(e)).not.toContain(v);
  });

  it('refuses any value outside sandbox mode, even a past one', () => {
    expect(refusal(base({ [NAME]: '2026-10-25T18:30:00Z' }))).toEqual({
      code: 'invalid_value',
      name: NAME,
    });
    expect(refusal(base({ UMS_MODE: 'offline', [NAME]: '2020-01-01T00:00:00Z' }))).toEqual({
      code: 'invalid_value',
      name: NAME,
    });
  });

  it('does not make the PayPal or live word checks fire on the new name', () => {
    expect(
      loadConfig(sandbox({ [NAME]: '2026-10-25T18:30:00Z', UMS_PAYPAL_CONNECT: 'on' })).ok,
    ).toBe(true);
  });
});

describe('webhookLearnWindow (pure; the clock is the caller’s)', () => {
  const NOW = new Date('2026-10-25T12:00:00Z');
  const H = 3_600_000;
  const at = (ms: number) => new Date(NOW.getTime() + ms).toISOString();

  it('no value: closed', () => {
    expect(webhookLearnWindow(null, NOW)).toBe('closed');
  });
  it('open strictly before the end, closed at the end and after', () => {
    expect(webhookLearnWindow(at(1), NOW)).toBe('open');
    expect(webhookLearnWindow(at(30 * 60_000), NOW)).toBe('open');
    expect(webhookLearnWindow(at(0), NOW)).toBe('closed');
    expect(webhookLearnWindow(at(-1), NOW)).toBe('closed');
    expect(webhookLearnWindow(at(-100 * H), NOW)).toBe('closed');
  });
  it('exactly 24 h ahead is open; one millisecond more is too far', () => {
    expect(webhookLearnWindow(at(24 * H), NOW)).toBe('open');
    expect(webhookLearnWindow(at(24 * H + 1), NOW)).toBe('too_far');
    expect(webhookLearnWindow(at(72 * H), NOW)).toBe('too_far');
  });
  it('an unreadable value is never open', () => {
    expect(webhookLearnWindow('not a time', NOW)).not.toBe('open');
    expect(webhookLearnWindow('', NOW)).not.toBe('open');
  });
  it('the window closes by itself as the clock moves, with the same value', () => {
    const until = at(2 * H);
    expect(webhookLearnWindow(until, NOW)).toBe('open');
    expect(webhookLearnWindow(until, new Date(NOW.getTime() + 2 * H - 1))).toBe('open');
    expect(webhookLearnWindow(until, new Date(NOW.getTime() + 2 * H))).toBe('closed');
  });
});
