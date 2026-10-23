import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanProcess, loadHttpsWire, setExecArgv, unloadHttpsWire } from './https-fake';
import { netSpies } from './test-support';

// BU-1. wireSelfCheck() reports on the production Wire without any I/O. It is loaded here against
// fake node:https, node:tls and node:dns modules so "replaced after load" can be shown for real.
let restoreArgv: (() => void) | null = null;
afterEach(() => {
  restoreArgv?.();
  restoreArgv = null;
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  unloadHttpsWire();
});

describe('selfcheck makes no I/O and names node-https', () => {
  it('reports the four fields, on a clean process', async () => {
    restoreArgv = cleanProcess();
    const { wireSelfCheck } = await loadHttpsWire();
    expect(wireSelfCheck()).toEqual({
      impl: 'node-https',
      env_override: false,
      builtins_intact: true,
      global_fetch_changed_since_load: false,
    });
  });

  it('opens nothing: no socket, lookup, request or fetch, and creates no request', async () => {
    restoreArgv = cleanProcess();
    const { wireSelfCheck, world } = await loadHttpsWire();
    const spies = netSpies();
    try {
      wireSelfCheck();
      wireSelfCheck();
      spies.assertZero();
      expect(world.calls).toHaveLength(0);
      expect(world.lookup).not.toHaveBeenCalled();
      expect(world.connect).not.toHaveBeenCalled();
    } finally {
      spies.spies['global fetch'].mockRestore();
      for (const s of Object.values(spies.spies)) s.mockRestore();
    }
  });

  it('env_override follows the process environment and Node flags', async () => {
    restoreArgv = cleanProcess();
    const { wireSelfCheck } = await loadHttpsWire();
    vi.stubEnv('HTTPS_PROXY', 'http://127.0.0.1:9');
    expect(wireSelfCheck().env_override).toBe(true);
    vi.stubEnv('HTTPS_PROXY', '');
    expect(wireSelfCheck().env_override).toBe(false);
    setExecArgv(['--import', 'x.mjs']);
    expect(wireSelfCheck().env_override).toBe(true);
    setExecArgv(['--preserve-symlinks']);
    expect(wireSelfCheck().env_override).toBe(true);
  });

  it('builtins_intact turns false when https.request, tls.connect or dns.lookup is replaced, and back when restored', async () => {
    restoreArgv = cleanProcess();
    const { wireSelfCheck, world } = await loadHttpsWire();
    for (const [mod, key] of [
      [world.https, 'request'],
      [world.tls, 'connect'],
      [world.dns, 'lookup'],
    ] as const) {
      const original = mod[key];
      mod[key] = () => undefined;
      expect(wireSelfCheck().builtins_intact, key).toBe(false);
      mod[key] = original;
      expect(wireSelfCheck().builtins_intact, key).toBe(true);
    }
  });

  it('global_fetch_changed_since_load is a report only', async () => {
    restoreArgv = cleanProcess();
    const { wireSelfCheck } = await loadHttpsWire();
    const before = globalThis.fetch;
    vi.stubGlobal('fetch', async () => new Response('{}'));
    expect(wireSelfCheck()).toMatchObject({
      global_fetch_changed_since_load: true,
      builtins_intact: true,
      env_override: false,
    });
    vi.stubGlobal('fetch', before);
    expect(wireSelfCheck().global_fetch_changed_since_load).toBe(false);
  });

  it('before any wire is loaded the check fails closed', async () => {
    vi.resetModules();
    const { wireSelfCheck } = await import('./wire-selfcheck');
    expect(wireSelfCheck()).toMatchObject({
      impl: 'node-https',
      env_override: true,
      builtins_intact: false,
    });
  });

  it('the package index exports wireSelfCheck and nothing of the Wire itself', async () => {
    const idx = await import('./index');
    expect(typeof idx.wireSelfCheck).toBe('function');
    expect(
      Object.keys(idx)
        .filter((k) => /wire/i.test(k))
        .sort(),
    ).toEqual([['PRODUCTION', 'WIRE'].join('_'), 'wireSelfCheck']);
  });
});
