// CO-9 / ASM-55, rewritten by PG-2 (the spec for this lane contradicts the old "postgres is not wired"
// refusal: UMS_DB=postgres now boots, see apps/web/src/postgres/boot.postgres.integration.test.ts).
// What stays pinned here, offline and with every socket route traced: a configuration that cannot be
// used (a bad URL, a missing URL) is refused at boot with a fixed message, opens no socket, and never
// prints the connection string.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../composition.server';
import { testEnv } from './support';

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
// A port out of range: the URL is parsed (and refused) before any connection is attempted.
const BAD_PORT_URL = 'postgres://app:hunter2hunter2@db.invalid:99999/unitmarket';

describe('UMS_DB=postgres: unusable configuration is refused without a socket', () => {
  it('control: the same environment with the in-memory target boots', async () => {
    const app = createApp(await testEnv({ UMS_DB: 'pglite-memory' }));
    await app.ready();
    await app.close();
  });

  it('config accepts the postgres value', async () => {
    const app = createApp(await testEnv({ UMS_DB: 'postgres', DATABASE_URL: POSTGRES_URL }));
    expect(app.config.db.kind).toBe('postgres');
  });

  it('a URL that does not parse: ready() rejects with a fixed message, and stays refused on a second try', async () => {
    const app = createApp(await testEnv({ UMS_DB: 'postgres', DATABASE_URL: BAD_PORT_URL }));
    await expect(app.ready()).rejects.toThrowError(/invalid database configuration: bad port/);
    await expect(app.ready()).rejects.toThrowError(/invalid database configuration/);
    await app.close().catch(() => undefined);
  });

  it('opens no socket and makes no lookup or request', async () => {
    const app = createApp(await testEnv({ UMS_DB: 'postgres', DATABASE_URL: BAD_PORT_URL }));
    await app.ready().catch(() => undefined);
    await app.close().catch(() => undefined);
    expect(trace.calls).toEqual([]);
  });

  it('UMS_DB=postgres without DATABASE_URL is refused at boot, naming the missing value', async () => {
    const env = await testEnv({ UMS_DB: 'postgres' });
    expect(() => createApp(env)).toThrowError(/boot refused.*missing_value.*DATABASE_URL/);
    expect(trace.calls).toEqual([]);
  });

  it('the message never prints the connection string, the host or the password', async () => {
    const app = createApp(await testEnv({ UMS_DB: 'postgres', DATABASE_URL: BAD_PORT_URL }));
    const e = await app.ready().then(
      () => null,
      (err: unknown) => err as Error,
    );
    const text = `${e?.message ?? ''}\n${e?.stack ?? ''}`;
    for (const needle of ['db.invalid', 'hunter2hunter2', 'postgres://'])
      expect(text).not.toContain(needle);
    await app.close().catch(() => undefined);
  });
});
