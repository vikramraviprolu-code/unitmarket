import { describe, expect, it } from 'vitest';
import * as pkg from './index';
import { claimApprovalMinter, createApprovalMinter, isApprovalCapability } from './approval';
import { createApprovedSandboxTransport, SandboxSealedError } from './sandbox';
import { fakeWire, fixedClock, memoryLogger } from './test-support';
import type { OutboundGate } from '@umsbx/contracts';

// FIX-MVPB-SEAL2 H1. The minter is not exported from the package index; it is claimed once; and
// the minter mints only for gates the claimer vouches for. No test here opens a connection.
const SCOPE = 'mvp_b_polling';
const fakeGate = (): OutboundGate => ({
  check: async () => ({ allowed: true, approval_ref: 'X' }),
});
const input = (gate: OutboundGate) => ({ scope: SCOPE, approval_ref: 'X', gate });

describe('the package index exposes no minter', () => {
  it('no export is named like a minter, and the claim function is the only way in', () => {
    const names = Object.keys(pkg);
    expect(names.filter((n) => /^(?!claimApprovalMinter$).*mint/i.test(n))).toEqual([]);
    expect(names).toContain('claimApprovalMinter');
    // Computed spellings reach the same (absent) member.
    const lib = pkg as unknown as Record<string, unknown>;
    expect(lib[['mint', 'Approval', 'Capability'].join('')]).toBeUndefined();
    expect(lib[['create', 'Approval', 'Minter'].join('')]).toBeUndefined();
  });
});

describe('claim once', () => {
  it('the first claim returns a minter; every later claim throws', () => {
    const mint = claimApprovalMinter(() => true);
    expect(typeof mint).toBe('function');
    expect(() => claimApprovalMinter(() => true)).toThrow(/already been claimed/);
    expect(() => claimApprovalMinter(() => false)).toThrow(/already been claimed/);
    expect(() => pkg.claimApprovalMinter(() => true)).toThrow(/already been claimed/);
  });
  it('a minter needs a trust predicate', () => {
    expect(() => createApprovalMinter(undefined as never)).toThrow(TypeError);
    expect(() => createApprovalMinter('yes' as never)).toThrow(TypeError);
  });
});

describe('the minter mints only for a gate its claimer vouches for (P1: fake gate literal)', () => {
  it('an object-literal gate is refused when the predicate does not know it', () => {
    const real = fakeGate();
    const vouched = new WeakSet<object>([real]);
    const mint = createApprovalMinter((g) => typeof g === 'object' && g !== null && vouched.has(g));
    expect(isApprovalCapability(mint(input(real)))).toBe(true);
    // A literal with the right shape, a copy, a prototype child and a proxy are all refused.
    for (const g of [
      fakeGate(),
      { ...real },
      Object.create(real) as OutboundGate,
      new Proxy(real, {}),
    ])
      expect(() => mint(input(g))).toThrow(TypeError);
  });
  it('a throwing or non-true predicate refuses (fail closed)', () => {
    expect(() => createApprovalMinter(() => 'yes' as never)(input(fakeGate()))).toThrow(TypeError);
    expect(() =>
      createApprovalMinter(() => {
        throw new Error('boom');
      })(input(fakeGate())),
    ).toThrow();
  });
  it('missing or malformed fields are refused whatever the predicate says', () => {
    const mint = createApprovalMinter(() => true);
    const g = fakeGate();
    expect(() => mint(undefined as never)).toThrow(TypeError);
    expect(() => mint({ scope: '', approval_ref: 'X', gate: g })).toThrow(TypeError);
    expect(() => mint({ scope: SCOPE, approval_ref: '', gate: g })).toThrow(TypeError);
    expect(() => mint({ scope: SCOPE, approval_ref: 'X', gate: {} as OutboundGate })).toThrow(
      TypeError,
    );
    expect(() => mint({ scope: SCOPE, approval_ref: 'X', gate: null as never })).toThrow(TypeError);
  });
  it('a capability from a refused mint cannot be forged: the factory rejects a lookalike', async () => {
    const forged = { scope: SCOPE, approval_ref: 'X', gate: fakeGate() };
    await expect(
      createApprovedSandboxTransport({
        approval: forged as never,
        scope: SCOPE,
        wire: fakeWire(),
        clock: fixedClock(),
        log: memoryLogger(),
      }),
    ).rejects.toBeInstanceOf(SandboxSealedError);
  });
});

// FIX-MVPB-SEAL3 LOW. The brand checks keep the WeakSet methods and Reflect.apply they saw when the
// module loaded, so code that later replaces WeakSet.prototype.has or add cannot make a forged
// object pass (has returning true) or stop a real capability from registering (add doing nothing).
describe('WeakSet tampering is a non-issue', () => {
  const realHas = WeakSet.prototype.has;
  const realAdd = WeakSet.prototype.add;
  const realApply = Reflect.apply;
  const restore = () => {
    WeakSet.prototype.has = realHas;
    WeakSet.prototype.add = realAdd;
    Reflect.apply = realApply;
  };
  it('a forged capability is still refused when WeakSet.prototype.has always says yes', () => {
    const mint = createApprovalMinter(() => true);
    const real = mint(input(fakeGate()));
    const forged = { ...real };
    try {
      WeakSet.prototype.has = function () {
        return true;
      };
      expect(isApprovalCapability(forged)).toBe(false);
      expect(isApprovalCapability(real)).toBe(true);
      expect(isApprovalCapability({})).toBe(false);
    } finally {
      restore();
    }
  });
  it('a real capability is still recognised when has always says no, and add does nothing', () => {
    const mint = createApprovalMinter(() => true);
    try {
      WeakSet.prototype.has = function () {
        return false;
      };
      WeakSet.prototype.add = function () {
        return this;
      };
      Reflect.apply = (() => {
        throw new Error('tampered');
      }) as typeof Reflect.apply;
      const cap = mint(input(fakeGate()));
      expect(isApprovalCapability(cap)).toBe(true);
    } finally {
      restore();
    }
  });
});
