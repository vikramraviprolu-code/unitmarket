// FIX-MVPB-SEAL4 item 1. Importing the transport or safety sources by PATH (plain, percent-encoded,
// or through test-support) must not give the importer a minter. @umsbx/safety is loaded first, as in
// the product, so it holds the one claim; every path import below either fails to load or yields a
// module whose claim is spent and which exports no minter factory. A lint exemption pins this file:
// it is the one place that spells these paths on purpose. No network, no database.
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { createOutboundGate } from '@umsbx/safety';

const KEYS = (m: unknown) => Object.keys(m as object).sort();
const FACTORY = ['create', 'Approval', 'Minter'].join('');
const FORGED = {
  scope: 'mvp_b_polling',
  approval_ref: 'X',
  gate: { check: async () => ({ allowed: true, approval_ref: 'X' }) },
};

type Loader = () => Promise<unknown>;
const outcome: Record<string, 'loaded' | 'refused'> = {};
const approvalSpellings: Record<string, Loader> = {
  plain: () => import('../../packages/transport/src/approval'),
  // Node ESM and URL resolution decode %6F to "o"; the probe used this to dodge a string match.
  // @ts-expect-error the percent-encoded name does not exist for TypeScript
  'pct dir': () => import('../../packages/transp%6Frt/src/approval.ts'),
  // @ts-expect-error the percent-encoded name does not exist for TypeScript
  'pct file': () => import('../../packages/transport/src/appr%6Fval.ts'),
};

describe('a path import cannot mint a capability', () => {
  it('safety loaded first and holds the claim', () => {
    expect(typeof createOutboundGate).toBe('function');
  });

  it.each(Object.entries(approvalSpellings))('approval.ts by %s', async (_name, load) => {
    let mod: unknown;
    try {
      mod = await load();
      outcome[_name] = 'loaded';
    } catch {
      outcome[_name] = 'refused';
      return; // cannot even be loaded: nothing to mint with
    }
    // Loaded, so it is a module with the claim function only, and the claim is already spent.
    expect(KEYS(mod)).toEqual(['claimApprovalMinter', 'isApprovalCapability']);
    expect((mod as Record<string, unknown>)[FACTORY]).toBeUndefined();
    const claim = (mod as { claimApprovalMinter: (t: unknown) => unknown }).claimApprovalMinter;
    expect(() => claim(() => true)).toThrow(/already been claimed/);
  });

  it('node URL resolution decodes the percent-encoded probe to the real file (why lint refuses %)', () => {
    const real = fileURLToPath(
      new URL('../../packages/transport/src/approval.ts', import.meta.url),
    );
    const probe = fileURLToPath(
      new URL('../../packages/transp%6Frt/src/approval.ts', import.meta.url),
    );
    expect(probe).toBe(real);
  });

  it('the plain path does load (so the checks above ran on a real module)', () => {
    expect(outcome['plain']).toBe('loaded');
  });

  it('sandbox.ts by path builds no transport from a forged capability or a string wire', async () => {
    const mod = (await import('../../packages/transport/src/sandbox')) as unknown as {
      createApprovedSandboxTransport: (o: unknown) => Promise<unknown>;
      SandboxSealedError: new (...a: never[]) => Error;
    };
    const wire = { request: async () => ({ kind: 'error', error: 'other' }) };
    const log = { log: () => undefined, child: () => ({}) };
    const clock = { now: () => new Date(0) };
    for (const wireValue of [wire, 'production', ['prod', 'uction'].join('')])
      await expect(
        mod.createApprovedSandboxTransport({
          approval: FORGED,
          scope: 'mvp_b_polling',
          wire: wireValue,
          clock,
          log,
        }),
      ).rejects.toBeInstanceOf(mod.SandboxSealedError);
  });

  it('test-support.ts by path fails to load (its claim is spent) and so offers no permissive minter', async () => {
    await expect(import('../../packages/transport/src/test-support')).rejects.toThrow(
      /already been claimed/,
    );
  });

  it('safety scoped-gate.ts by path: the minter refuses a gate its factory did not build', async () => {
    const mod = (await import('../../packages/safety/src/scoped-gate')) as unknown as {
      mintCapability: (i: unknown) => unknown;
    };
    expect(() => mod.mintCapability(FORGED)).toThrow(TypeError);
  });
});
