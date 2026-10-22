// Process-wide holder for the composed app. Kept on globalThis under one Symbol key so route bundles,
// pages and instrumentation share one app even when the bundler duplicates a module. It is the only
// file in apps/web allowed to touch globalThis (eslint.config.mjs NAMED_EXEMPTIONS); it must never
// read anything other than its own key.
const KEY = Symbol.for('umsbx.app');
type Slot<T> = { [KEY]?: T };

export function getSingleton<T>(): T | undefined {
  return (globalThis as unknown as Slot<T>)[KEY];
}

export function setSingleton<T>(value: T | undefined): void {
  const slot = globalThis as unknown as Slot<T>;
  if (value === undefined) delete slot[KEY];
  else slot[KEY] = value;
}
