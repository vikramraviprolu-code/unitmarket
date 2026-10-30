// PUB-APPLY review fix 1: when no client address is known (UMS_TRUSTED_PROXIES is 0, the default, or nothing
// could be read) every visitor would share one bucket, so one visitor could fill it for everyone. The
// application is then refused as busy, before any token is spent and before anything is stored. This file
// boots its own app with the default proxy count 0 (the app singleton is per file).
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { bootRefundWorld } from './refund-support';
import type { RefundWorld } from './refund-support';
import { ORIGIN } from './support';

vi.mock('server-only', () => ({}));

let w: RefundWorld;
let apply: typeof import('./app/api/applications/route');
beforeAll(async () => {
  w = await bootRefundWorld({});
  apply = await import('./app/api/applications/route');
});
afterAll(async () => {
  await w.app.close();
});

const body = {
  display_name: 'No Address Press',
  country: 'GB',
  note: 'https://press.example, we publish local reports',
};
const post = (headers: Record<string, string> = {}) =>
  apply.POST(
    new Request(`${ORIGIN}/api/applications`, {
      method: 'POST',
      headers: { origin: ORIGIN, 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({}) },
  );
const count = async (sql: string): Promise<number> =>
  Number((await w.app.db.query<{ c: string }>(sql)).rows[0]!.c);

describe('no known client address', () => {
  it('refuses with busy (503), stores nothing and spends no apply token, even with a forged forwarded address', async () => {
    const pubs = await count('SELECT count(*) AS c FROM publishers');
    const audits = await count('SELECT count(*) AS c FROM audit_log');
    for (const headers of [
      {},
      { 'x-forwarded-for': '203.0.113.9' },
      { 'x-forwarded-for': '1.2.3.4, 5.6.7.8' },
    ]) {
      const res = await post(headers);
      expect(res.status).toBe(503);
      const text = await res.text();
      expect(JSON.parse(text).error.code).toBe('busy');
      expect(text).not.toMatch(/pub_|aud_/);
    }
    expect(await count('SELECT count(*) AS c FROM publishers')).toBe(pubs);
    expect(await count('SELECT count(*) AS c FROM audit_log')).toBe(audits);
    expect(
      await count("SELECT count(*) AS c FROM rate_buckets WHERE bucket_key LIKE 'apply:%'"),
    ).toBe(0);
  });

  it('the engine refuses an unknown address too, and the status read still works', async () => {
    const r = await w.app.engine.applyToPublish({
      ...body,
      trap: '',
      ip_hash: 'abc',
      ip_known: false,
    });
    expect(r).toEqual({ ok: false, code: 'busy' });
    expect(await w.app.engine.applicationStatus({ ref: 'no-address-press-000000000000' })).toBe(
      'unknown',
    );
  });
});
