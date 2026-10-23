// CO-9 / ASM-55: the PGlite single-process facts behind the waiver of real-Postgres race tests hold
// only while no Postgres target can boot. This pins that an app built with UMS_DB=postgres refuses to
// start with a clear message and opens no socket (net, tls, dns, http, https, fetch all traced).
// Offline; the connection string is a placeholder with no credentials.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadConfig } from '@umsbx/config';
import { createApp } from '../../apps/web/composition.server';
import { testEnv } from '../../apps/web/src/support';

vi.mock('server-only', () => ({}));

const { trace, traced } = vi.hoisted(() => {
  const calls: string[] = [];
  type Fn = (...a: unknown[]) => unknown;
  const wrap = (mod: string, names: string[]) => async (importOriginal: () => Promise<unknown>) => {
    const actual = (await importOriginal()) as Record<string, unknown>;
    const patched: Record<string, unknown> = { ...actual };
    for (const name of names) {
      const original = actual[name] as Fn | undefined;
      if (typeof original !== 'function') continue;
      patched[name] = (...a: unknown[]) => {
        calls.push(`${mod}.${name}`);
        return original(...a);
      };
    }
    return { ...patched, default: patched };
  };
  return { trace: { calls }, traced: wrap };
});
vi.mock('node:net', traced('net', ['connect', 'createConnection']));
vi.mock('node:tls', traced('tls', ['connect']));
vi.mock('node:dns', traced('dns', ['lookup', 'resolve', 'resolve4', 'resolve6']));
vi.mock('node:http', traced('http', ['request', 'get']));
vi.mock('node:https', traced('https', ['request', 'get']));

beforeEach(() => {
  trace.calls.length = 0;
  vi.stubGlobal('fetch', (...a: unknown[]) => {
    trace.calls.push(`fetch ${String(a[0])}`);
    return Promise.reject(new Error('fetch is not available in this test'));
  });
});
afterEach(() => {
  vi.unstubAllGlobals();
});

const POSTGRES_URL = 'postgres://app@db.invalid/unitmarket';

describe('CO-9: UMS_DB=postgres is refused', () => {
  it('control: the same environment with the in-memory target boots', async () => {
    const app = createApp(await testEnv({ UMS_DB: 'pglite-memory' }));
    await app.ready();
    await app.close();
  });

  it('config accepts the postgres value, so the refusal below is the composition', async () => {
    const loaded = loadConfig(await testEnv({ UMS_DB: 'postgres', DATABASE_URL: POSTGRES_URL }));
    expect(loaded.ok).toBe(true);
    if (loaded.ok) expect(loaded.value.db.kind).toBe('postgres');
  });

  it('the app does not start: ready() rejects with a clear message', async () => {
    const app = createApp(await testEnv({ UMS_DB: 'postgres', DATABASE_URL: POSTGRES_URL }));
    await expect(app.ready()).rejects.toThrowError(/postgres is not wired/i);
    await expect(app.ready()).rejects.toThrowError(/postgres/i); // stays refused on a second try
    await app.close().catch(() => undefined); // close() re-raises the refused open; tolerated here
  });

  it('opens no socket and makes no lookup or request', async () => {
    const app = createApp(await testEnv({ UMS_DB: 'postgres', DATABASE_URL: POSTGRES_URL }));
    await app.ready().catch(() => undefined);
    await app.close().catch(() => undefined);
    expect(trace.calls).toEqual([]);
  });

  it('UMS_DB=postgres without DATABASE_URL is refused at boot, naming the missing value', async () => {
    const env = await testEnv({ UMS_DB: 'postgres' });
    expect(() => createApp(env)).toThrowError(/boot refused.*missing_value.*DATABASE_URL/);
    expect(trace.calls).toEqual([]);
  });

  it('the message never prints the connection string', async () => {
    const app = createApp(await testEnv({ UMS_DB: 'postgres', DATABASE_URL: POSTGRES_URL }));
    const e = await app.ready().then(
      () => null,
      (err: unknown) => err as Error,
    );
    expect(e?.message ?? '').not.toContain('db.invalid');
    await app.close().catch(() => undefined);
  });
});
