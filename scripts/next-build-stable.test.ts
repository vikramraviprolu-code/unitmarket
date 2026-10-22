// Gate review L4: `next build` rewrites apps/web/next-env.d.ts and apps/web/tsconfig.json. They are
// committed in the form the build writes, the formatters leave them alone, and the root scripts call
// pnpm through corepack, so a build never leaves the tree dirty or the checks red.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const read = (p: string): string => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');

describe('next build leaves the tree stable (L4)', () => {
  it('apps/web/tsconfig.json is in the two-space form Next writes', () => {
    const raw = read('apps/web/tsconfig.json');
    expect(raw).toBe(`${JSON.stringify(JSON.parse(raw), null, 2)}\n`);
    expect(JSON.parse(raw).include).toContain('.next/types/**/*.ts');
  });
  it('next-env.d.ts carries the routes reference the build adds', () => {
    expect(read('apps/web/next-env.d.ts')).toContain('.next/types/routes.d.ts');
  });
  it('prettier and eslint skip the two build-managed files', () => {
    const ignored = read('.prettierignore').split('\n');
    expect(ignored).toContain('apps/web/tsconfig.json');
    expect(ignored).toContain('apps/web/next-env.d.ts');
    expect(read('eslint.config.mjs')).toContain("'apps/web/next-env.d.ts'");
  });
  it('root scripts that call pnpm go through corepack', () => {
    const scripts = (JSON.parse(read('package.json')) as { scripts: Record<string, string> })
      .scripts;
    for (const [name, cmd] of Object.entries(scripts)) {
      expect(cmd, name).not.toMatch(/(^|&&\s*|\|\|\s*|;\s*)pnpm\b/);
    }
    expect(scripts['typecheck']).toContain('corepack pnpm');
    expect(scripts['test:e2e']).toContain('corepack pnpm');
  });
});
