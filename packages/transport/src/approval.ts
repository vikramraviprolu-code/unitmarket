import type { OutboundGate } from '@umsbx/contracts';

// The approval capability (FIX-BPREP M3, sealed again in FIX-MVPB-SEAL2 H1). The approved sandbox
// transport is built only from a capability minted here. A structurally typed object cannot be
// one: the interface carries a private unique-symbol member (TypeScript) and the runtime checks a
// module-private WeakSet (JavaScript), so an object literal with the right fields is refused.
//
// Who may mint (SEAL2 H1):
//   - The minter is NOT exported from the package index. `claimApprovalMinter` hands it out once
//     per module instance; `@umsbx/safety` claims it when it loads, so a second claim throws.
//   - The claimer supplies a `trust` predicate. The minter refuses any gate the predicate does not
//     vouch for. Safety vouches only for gates built by its own gate factory (a module-private
//     WeakSet), so `{ check: async () => ({ allowed: true, ... }) }` is refused.
//   - Lint (sbx/sealed-transport) bars every other import of the claim function, the approved
//     factory, a namespace import of the package, a re-export and a dynamic import of it.
declare const brand: unique symbol;

export interface ApprovalCapability {
  readonly [brand]: true;
  /** The approval scope this capability stands on, e.g. `mvp_b_polling`. */
  readonly scope: string;
  /** The decision-log reference of the outbound_approvals row it was minted from. */
  readonly approval_ref: string;
  /** The gate that decides each request, bound to the same approval. */
  readonly gate: OutboundGate;
}

export interface MintInput {
  scope: string;
  approval_ref: string;
  gate: OutboundGate;
}
export type MintApprovalCapability = (i: MintInput) => ApprovalCapability;
/** Says whether a gate was built by the claimer's own gate factory. */
export type GateTrust = (gate: unknown) => boolean;

const minted = new WeakSet<object>();

/**
 * Builds a minter that mints only for gates `trust` vouches for. Not exported from the package
 * index: this package's own tests build throw-away minters with it, and `claimApprovalMinter`
 * builds the one real minter.
 */
export function createApprovalMinter(trust: GateTrust): MintApprovalCapability {
  if (typeof trust !== 'function') throw new TypeError('gate trust predicate missing');
  return (i) => {
    if (typeof i !== 'object' || i === null) throw new TypeError('mint input missing');
    if (typeof i.scope !== 'string' || i.scope === '')
      throw new TypeError('approval scope missing');
    if (typeof i.approval_ref !== 'string' || i.approval_ref === '')
      throw new TypeError('approval_ref missing');
    if (typeof i.gate !== 'object' || i.gate === null || typeof i.gate.check !== 'function')
      throw new TypeError('approval gate missing');
    if (trust(i.gate) !== true)
      throw new TypeError('approval gate was not built by the safety gate factory');
    const cap = Object.freeze({
      scope: i.scope,
      approval_ref: i.approval_ref,
      gate: i.gate,
    }) as unknown as ApprovalCapability;
    minted.add(cap);
    return cap;
  };
}

let claimed = false;

/**
 * Hands out the one real minter, once. `@umsbx/safety` calls this when it loads; a second call
 * from anywhere throws, so no later module can obtain a minter.
 */
export function claimApprovalMinter(trust: GateTrust): MintApprovalCapability {
  if (claimed) throw new Error('the approval minter has already been claimed');
  const mint = createApprovalMinter(trust);
  claimed = true;
  return mint;
}

export function isApprovalCapability(x: unknown): x is ApprovalCapability {
  return typeof x === 'object' && x !== null && minted.has(x);
}
