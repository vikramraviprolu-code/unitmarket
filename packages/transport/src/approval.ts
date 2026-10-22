import type { OutboundGate } from '@umsbx/contracts';

// The approval capability (FIX-BPREP M3). The approved sandbox transport is built only from a
// capability minted here. A structurally typed object cannot be one: the interface carries a
// private unique-symbol member (TypeScript) and the runtime checks a module-private WeakSet
// (JavaScript), so an object literal with the right fields is refused.
//
// Only `@umsbx/safety` (createScopedGate) and this package's test support may call
// `mintApprovalCapability`; tests/mvp-b/sealed-callers.test.ts fails if any other source file does.
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

const minted = new WeakSet<object>();

export function mintApprovalCapability(i: {
  scope: string;
  approval_ref: string;
  gate: OutboundGate;
}): ApprovalCapability {
  if (typeof i.scope !== 'string' || i.scope === '') throw new TypeError('approval scope missing');
  if (typeof i.approval_ref !== 'string' || i.approval_ref === '')
    throw new TypeError('approval_ref missing');
  if (typeof i.gate !== 'object' || i.gate === null || typeof i.gate.check !== 'function')
    throw new TypeError('approval gate missing');
  const cap = Object.freeze({
    scope: i.scope,
    approval_ref: i.approval_ref,
    gate: i.gate,
  }) as unknown as ApprovalCapability;
  minted.add(cap);
  return cap;
}

export function isApprovalCapability(x: unknown): x is ApprovalCapability {
  return typeof x === 'object' && x !== null && minted.has(x);
}
