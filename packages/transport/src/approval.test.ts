import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import * as pkg from './index';
import { claimApprovalMinter, isApprovalCapability } from './approval';
import * as approval from './approval';
import type { GateTrust } from './approval';
import type { OutboundGate } from '@umsbx/contracts';

// FIX-MVPB-SEAL2 H1, reworked in SEAL4 item 1. There is no exported minter factory: the only way to
// get a minter is claimApprovalMinter, once per module registry. This file claims it at the top with
// a trust predicate it can switch, and every test below uses that one minter. It deliberately does
// not import test-support.ts (which claims the minter for the other transport tests). No test here
// opens a connection.
const SCOPE = 'mvp_b_polling';
const fakeGate = (): OutboundGate => ({
  check: async () => ({ allowed: true, approval_ref: 'X' }),
});
const input = (gate: OutboundGate) => ({ scope: SCOPE, approval_ref: 'X', gate });

let trust: GateTrust = () => true;
const mint = claimApprovalMinter((g) => trust(g));

describe('the package and the approval module expose no minter factory', () => {
  it('no export of the index is named like a minter except the claim function', () => {
    const names = Object.keys(pkg);
    expect(names.filter((n) => /^(?!claimApprovalMinter$).*mint/i.test(n))).toEqual([]);
    expect(names).toContain('claimApprovalMinter');
    const lib = pkg as unknown as Record<string, unknown>;
    expect(lib[['mint', 'Approval', 'Capability'].join('')]).toBeUndefined();
    expect(lib[['create', 'Approval', 'Minter'].join('')]).toBeUndefined();
  });
  it('approval.ts itself exports only the claim function and the capability check', () => {
    expect(Object.keys(approval).sort()).toEqual(['claimApprovalMinter', 'isApprovalCapability']);
    const src = readFileSync(new URL('./approval.ts', import.meta.url), 'utf8');
    const exported = [...src.matchAll(/^export (?:async )?(?:function|const|class) (\w+)/gm)].map(
      (m) => m[1],
    );
    expect(exported.sort()).toEqual(['claimApprovalMinter', 'isApprovalCapability']);
  });
});

describe('claim once', () => {
  it('the claim at the top of this file returned a minter; every later claim throws', () => {
    expect(typeof mint).toBe('function');
    expect(() => claimApprovalMinter(() => true)).toThrow(/already been claimed/);
    expect(() => claimApprovalMinter(() => false)).toThrow(/already been claimed/);
    expect(() => pkg.claimApprovalMinter(() => true)).toThrow(/already been claimed/);
  });
  it('a claim needs a trust predicate (checked before the claim state)', () => {
    expect(() => claimApprovalMinter(undefined as never)).toThrow(TypeError);
    expect(() => claimApprovalMinter('yes' as never)).toThrow(TypeError);
  });
});

describe('the minter mints only for a gate its claimer vouches for (P1: fake gate literal)', () => {
  it('an object-literal gate is refused when the predicate does not know it', () => {
    const real = fakeGate();
    const vouched = new WeakSet<object>([real]);
    trust = (g) => typeof g === 'object' && g !== null && vouched.has(g);
    try {
      expect(isApprovalCapability(mint(input(real)))).toBe(true);
      // A literal with the right shape, a copy, a prototype child and a proxy are all refused.
      for (const g of [
        fakeGate(),
        { ...real },
        Object.create(real) as OutboundGate,
        new Proxy(real, {}),
      ])
        expect(() => mint(input(g))).toThrow(TypeError);
    } finally {
      trust = () => true;
    }
  });
  it('a throwing or non-true predicate refuses (fail closed)', () => {
    try {
      trust = () => 'yes' as never;
      expect(() => mint(input(fakeGate()))).toThrow(TypeError);
      trust = () => {
        throw new Error('boom');
      };
      expect(() => mint(input(fakeGate()))).toThrow();
    } finally {
      trust = () => true;
    }
  });
  it('missing or malformed fields are refused whatever the predicate says', () => {
    const g = fakeGate();
    expect(() => mint(undefined as never)).toThrow(TypeError);
    expect(() => mint({ scope: '', approval_ref: 'X', gate: g })).toThrow(TypeError);
    expect(() => mint({ scope: SCOPE, approval_ref: '', gate: g })).toThrow(TypeError);
    expect(() => mint({ scope: SCOPE, approval_ref: 'X', gate: {} as OutboundGate })).toThrow(
      TypeError,
    );
    expect(() => mint({ scope: SCOPE, approval_ref: 'X', gate: null as never })).toThrow(TypeError);
  });
  it('a lookalike object is not a capability', () => {
    const real = mint(input(fakeGate()));
    expect(isApprovalCapability(real)).toBe(true);
    for (const x of [{ ...real }, Object.create(real), JSON.parse(JSON.stringify(real)), null, 1])
      expect(isApprovalCapability(x)).toBe(false);
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
