// Guard only (BU-6). The owner-run sandbox subset no longer lives here: it is run by
// `pnpm sandbox:conformance` (scripts/sandbox-conformance.mjs, plain Node) and rehearsed offline in
// tests/mvp-b/b-l2-sandbox.contract.test.ts. This file keeps the offline guard: with
// UMS_SANDBOX_TESTS unset, the PayPal package opens no socket and calls no fetch.
import { describe, expect, it, vi } from 'vitest';

// Vitest mirrors the environment into import.meta.env. Only packages/config may read process.env
// (lint S3), and this one opt-in flag is not a config value, so it is read from there.
const viteEnv = (import.meta as { env?: Record<string, string | undefined> }).env;
const enabled = viteEnv?.['UMS_SANDBOX_TESTS'] === '1';

describe('PayPal sandbox contract guard', () => {
  it.skipIf(enabled)('without UMS_SANDBOX_TESTS=1 nothing is built and no socket opens', () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    expect(fetchSpy).not.toHaveBeenCalled();
    const open = process
      .getActiveResourcesInfo()
      .filter((r) => r === 'TCPSocketWrap' || r === 'TCPConnectWrap' || r === 'TLSWrap');
    expect(open).toEqual([]);
    fetchSpy.mockRestore();
  });
});
