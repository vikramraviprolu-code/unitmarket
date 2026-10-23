// Module hooks that let plain Node (22.18+, which strips TypeScript types itself) run the
// workspace sources: extensionless relative imports are resolved to .ts files. Nothing is compiled
// or bundled; syntax that needs a transform (enums, parameter properties) is not supported.
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// `server-only` marks a module that must not reach a browser bundle. A plain Node script is not a
// bundle, and the package throws unless the react-server condition is set (a flag the guard refuses),
// so here it resolves to an empty module. Only the scripts that call registerTs() see this.
const EMPTY_MODULE = 'data:text/javascript,export {};';

export async function resolve(specifier, context, next) {
  if (specifier === 'server-only') {
    return { url: EMPTY_MODULE, format: 'module', shortCircuit: true };
  }
  if ((specifier.startsWith('./') || specifier.startsWith('../')) && context.parentURL) {
    const base = new URL(specifier, context.parentURL);
    if (!/\.[cm]?[jt]sx?$/.test(base.pathname)) {
      for (const suffix of ['.ts', '/index.ts']) {
        const candidate = new URL(base.href + suffix);
        if (existsSync(fileURLToPath(candidate))) return next(candidate.href, context);
      }
    }
  }
  return next(specifier, context);
}
