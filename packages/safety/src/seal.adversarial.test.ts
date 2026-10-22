import { describe, expect, it } from 'vitest';
import * as T from '@umsbx/transport';
import type { Clock, Database, OutboundGate, SwitchReader } from '@umsbx/contracts';
import { createOutboundGate } from './index';
import { isIssuedGate, mintCapability } from './scoped-gate';

// FIX-MVPB-SEAL2 H1, review probe P1 and the namespace-import evasion. Safety claims the one
// approval minter when it loads; it mints only for a gate its own factory built. No database is
// touched and nothing here opens a connection.
const clock: Clock = { now: () => new Date('2026-10-22T10:00:00Z') };
const switches: SwitchReader = { isOn: async () => true } as unknown as SwitchReader;
const realGate = (): OutboundGate =>
  createOutboundGate({
    db: {} as Database,
    clock,
    switches,
    config: { mode: 'sandbox', connect: true, outbound_approval_ref: 'DL-2026-10-22-01' },
  });
const fakeLiteral = (): OutboundGate => ({
  check: async () => ({ allowed: true, approval_ref: 'X' }),
});
const input = (gate: OutboundGate) => ({ scope: 'mvp_b_polling', approval_ref: 'X', gate });

describe('P1: a fake gate literal cannot become an approval capability', () => {
  it('the real minter refuses an object-literal gate, a copy, a prototype child and a proxy', () => {
    for (const g of [
      fakeLiteral(),
      { ...realGate() },
      Object.create(realGate()) as OutboundGate,
      new Proxy(realGate(), {}),
    ])
      expect(() => mintCapability(input(g))).toThrow(TypeError);
  });
  it('the same minter accepts a gate built by the safety gate factory, and the factory takes the result', async () => {
    const g = realGate();
    expect(isIssuedGate(g)).toBe(true);
    const t = await T.createApprovedSandboxTransport({
      approval: mintCapability(input(g)),
      scope: 'mvp_b_polling',
      wire: { request: async () => ({ kind: 'error', error: 'other' }) },
      clock,
      log: { log: () => undefined, child: () => ({ log: () => undefined }) } as never,
    });
    expect(t.kind).toBe('sandbox');
  });
  it('no other object is vouched for', () => {
    for (const x of [fakeLiteral(), {}, null, undefined, 'gate', () => undefined])
      expect(isIssuedGate(x)).toBe(false);
  });
});

describe('evasion: the namespace import and computed names reach no minter', () => {
  // This is the review's evil.ts, run instead of linted: `import * as T` plus a computed name.
  const lib = T as unknown as Record<string, unknown>;
  it('no export of the package is a minter, whatever the spelling', () => {
    expect(Object.keys(lib).filter((k) => /^(?!claimApprovalMinter$).*mint/i.test(k))).toEqual([]);
    for (const parts of [
      ['mint', 'Approval', 'Capability'],
      ['create', 'Approval', 'Minter'],
      ['mint', 'Capability'],
    ])
      expect(lib[parts.join('')]).toBeUndefined();
  });
  it('the claim function is spent: safety claimed the minter when it loaded', () => {
    expect(() => T.claimApprovalMinter(() => true)).toThrow(/already been claimed/);
    const claim = lib[['claim', 'Approval', 'Minter'].join('')] as (t: unknown) => unknown;
    expect(() => claim(() => true)).toThrow(/already been claimed/);
  });
  it('a capability forged from a fake gate does not build a transport', async () => {
    const forged = { scope: 'mvp_b_polling', approval_ref: 'X', gate: fakeLiteral() };
    const make = lib['createApprovedSandboxTransport'] as (o: unknown) => Promise<unknown>;
    await expect(
      make({
        approval: forged,
        scope: 'mvp_b_polling',
        wire: { request: async () => ({ kind: 'error', error: 'other' }) },
        clock,
        log: { log: () => undefined, child: () => ({}) },
      }),
    ).rejects.toMatchObject({ name: 'SandboxSealedError' });
  });
});
