// INT-TC1: the one AsyncLocalStorage of the trace context, kept on globalThis under one Symbol key so every
// copy of @umsbx/obs in the process (Next bundles it once per server compilation) reads and writes the same
// store. It is the only file in packages/obs allowed to touch globalThis (eslint.config.mjs NAMED_EXEMPTIONS);
// it must never read anything other than its own key.
import { AsyncLocalStorage } from 'node:async_hooks';
import type { TraceContext } from '@umsbx/contracts';

const KEY = Symbol.for('umsbx.obs.traceStore');
type Slot = { [KEY]?: AsyncLocalStorage<TraceContext> };

export function traceStore(): AsyncLocalStorage<TraceContext> {
  const slot = globalThis as unknown as Slot;
  return (slot[KEY] ??= new AsyncLocalStorage<TraceContext>());
}
