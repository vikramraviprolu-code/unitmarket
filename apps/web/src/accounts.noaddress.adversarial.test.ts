// ID-ACCOUNTS: when no client address is known (UMS_TRUSTED_PROXIES is 0, the default) every visitor would
// share one bucket, so signup answers busy before anything is read, spent or stored, exactly like
// /api/applications. Sign in still works: a shared bucket never locks a right password out (M3).
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { bootAccounts, errorOf, got, post, signupBody } from './accounts-support';
import type { AccountsWorld } from './accounts-support';

vi.mock('server-only', () => ({}));

let w: AccountsWorld;
beforeAll(async () => {
  w = await bootAccounts({});
});
afterAll(async () => {
  await w.app.close();
});
const count = async (sql: string): Promise<number> =>
  Number((await w.app.db.query<{ c: string }>(sql)).rows[0]!.c);

describe('signup with no known client address', () => {
  it('answers busy (503), stores nothing, spends no signup token, even with a forged forwarded address', async () => {
    const buyers = await count('SELECT count(*) AS c FROM buyers');
    const audits = await count('SELECT count(*) AS c FROM audit_log');
    for (const headers of [
      {},
      { 'x-forwarded-for': '203.0.113.9' },
      { 'x-forwarded-for': '1.2.3.4, 5.6.7.8' },
    ]) {
      const g = await got(
        await post(w.signup.POST, '/api/accounts', signupBody(), {
          headers: { ...headers, 'x-forwarded-for': headers['x-forwarded-for'] ?? '' },
        }),
      );
      expect(g.status).toBe(503);
      expect(errorOf(g).code).toBe('busy');
      expect(g.text).not.toMatch(/buy_|aud_/);
    }
    expect(await count('SELECT count(*) AS c FROM buyers')).toBe(buyers);
    expect(await count('SELECT count(*) AS c FROM audit_log')).toBe(audits);
    expect(
      await count(
        "SELECT count(*) AS c FROM rate_buckets WHERE bucket_key LIKE 'account-signup:%'",
      ),
    ).toBe(0);
  });
});
