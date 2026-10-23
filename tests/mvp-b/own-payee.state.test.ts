// BU-7 (D-028): the sandbox seed gives the one MVP-B publisher the owner's own merchant id from the
// owner's environment, and nothing else. No value is committed: tests build their own fake ids.
// No byte leaves the process: the Wire is a counting fake and no call is made.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createApp, installApp } from '../../apps/web/composition.server';
import type { App } from '../../apps/web/composition.server';
import { testEnv } from '../../apps/web/src/support';
import { countingWire, sandboxEnv } from './unseal-support';

vi.mock('server-only', () => ({}));

const OWN = 'SBXOWNMERCH01';
const OTHER = 'SBXOWNMERCH02';
const live: App[] = [];
const dirs: string[] = [];

async function boot(env: Record<string, string>, sandbox = true): Promise<App> {
  const counting = countingWire();
  const full = sandbox ? await sandboxEnv(env) : await testEnv(env);
  const app = createApp(full, { switch_cache_ms: 0, test_wire: counting.wire });
  installApp(app);
  live.push(app);
  await app.ready();
  expect(counting.calls).toHaveLength(0);
  return app;
}
const publishers = async (app: App) =>
  (
    await app.db.query<{
      slug: string;
      paypal_merchant_id: string | null;
      payee_verified_at: unknown;
    }>('SELECT slug, paypal_merchant_id, payee_verified_at FROM publishers ORDER BY slug')
  ).rows;

afterEach(async () => {
  while (live.length > 0) await live.pop()!.close();
  while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true });
});

describe('sandbox seed of the MVP-B publisher payee', () => {
  it('own id set: harbour-ledger gets it, verified now; the other publisher stays unset', async () => {
    const app = await boot({ UMS_OWN_MERCHANT_ID: OWN });
    const rows = await publishers(app);
    const harbour = rows.find((r) => r.slug === 'harbour-ledger');
    expect(harbour?.paypal_merchant_id).toBe(OWN);
    expect(harbour?.payee_verified_at).not.toBeNull();
    const rest = rows.filter((r) => r.slug !== 'harbour-ledger');
    expect(rest.length).toBeGreaterThan(0);
    for (const r of rest) {
      expect(r.paypal_merchant_id).toBeNull();
      expect(r.payee_verified_at).toBeNull();
    }
  });

  it('own id unset: every publisher stays without a merchant id (approval refuses, as today)', async () => {
    const app = await boot({});
    for (const r of await publishers(app)) {
      expect(r.paypal_merchant_id).toBeNull();
      expect(r.payee_verified_at).toBeNull();
    }
  });

  it('offline mode keeps its synthetic labels, never the own id', async () => {
    const app = await boot({ UMS_OWN_MERCHANT_ID: OWN }, false);
    const rows = await publishers(app);
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) {
      expect(r.paypal_merchant_id).toMatch(/^DRYRUN/);
      expect(r.paypal_merchant_id).not.toBe(OWN);
    }
  });

  it('a value already stored is never overwritten by a later start with another own id', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'bu7-seed-'));
    dirs.push(dir);
    const disk = { UMS_DB: 'pglite-disk', UMS_PGLITE_DIR: dir };

    let app = await boot({ ...disk });
    expect((await publishers(app)).every((r) => r.paypal_merchant_id === null)).toBe(true);
    await app.close();
    live.pop();

    app = await boot({ ...disk, UMS_OWN_MERCHANT_ID: OWN });
    expect(
      (await publishers(app)).find((r) => r.slug === 'harbour-ledger')?.paypal_merchant_id,
    ).toBe(OWN);
    await app.close();
    live.pop();

    app = await boot({ ...disk, UMS_OWN_MERCHANT_ID: OTHER });
    expect(
      (await publishers(app)).find((r) => r.slug === 'harbour-ledger')?.paypal_merchant_id,
    ).toBe(OWN);
  }, 60_000);

  it('the value is not written to any log line or audit row', async () => {
    const lines: string[] = [];
    const counting = countingWire();
    const app = createApp(await sandboxEnv({ UMS_OWN_MERCHANT_ID: OWN }), {
      switch_cache_ms: 0,
      log_sink: (l) => lines.push(l),
      test_wire: counting.wire,
    });
    installApp(app);
    live.push(app);
    await app.ready();
    expect(lines.join('\n')).not.toContain(OWN);
    const audit = await app.db.query<Record<string, unknown>>('SELECT * FROM audit_log');
    expect(JSON.stringify(audit.rows)).not.toContain(OWN);
  });
});
