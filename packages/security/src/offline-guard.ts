// Test support for @umsbx/security (API-W0). Not exported from index. The offline proof: with fetch,
// net.connect and dns.lookup replaced by functions that record the call and throw, the W0 suites must
// finish with an empty record. A suite registers the module mocks itself (vi.mock is file-local):
//   vi.mock('node:net', async (orig) => (await import('./offline-guard')).netMock(await orig()));
//   vi.mock('node:dns', async (orig) => (await import('./offline-guard')).dnsMock(await orig()));
//   expectOffline();
// No network module is imported here; the mocks receive the original module from vitest.
import { afterAll, beforeAll, expect, vi } from 'vitest';

export const offlineTrace: { calls: string[] } = { calls: [] };

const blocked =
  (label: string) =>
  (...args: unknown[]): never => {
    void args;
    offlineTrace.calls.push(label);
    throw new Error(`${label}: this suite runs offline`);
  };

type Mod = Record<string, unknown>;

function patch(actual: unknown, names: readonly string[], label: string): Mod {
  const base = actual as Mod;
  const patched: Mod = { ...base };
  const shared = (base['default'] ?? {}) as Mod;
  const sharedPatched: Mod = { ...shared };
  for (const n of names) {
    patched[n] = blocked(`${label}.${n}`);
    sharedPatched[n] = blocked(`${label}.${n}`);
  }
  return { ...patched, default: sharedPatched };
}

export const netMock = (actual: unknown): Mod =>
  patch(actual, ['connect', 'createConnection'], 'net');

export const dnsMock = (actual: unknown): Mod => {
  const names = Object.keys(actual as Mod).filter((k) => /^(lookup|resolve|reverse)/.test(k));
  return patch(actual, names, 'dns');
};

/** Replaces fetch for the file and, after the last test, requires an empty record. */
export function expectOffline(): void {
  beforeAll(() => {
    vi.stubGlobal('fetch', blocked('fetch'));
  });
  afterAll(() => {
    vi.unstubAllGlobals();
    expect(offlineTrace.calls).toEqual([]);
  });
}
