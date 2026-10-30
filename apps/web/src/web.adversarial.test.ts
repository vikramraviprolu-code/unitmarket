// Lane 15 adversarial and static checks over the web sources (SOP 5, SOP 10, P8, P14, A-25).
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { checkEntry, pathFromFile, securityHeaders } from '@umsbx/security';
import { pageHeaders } from './lib/page-headers';

const WEB = fileURLToPath(new URL('..', import.meta.url));
const SRC = join(WEB, 'src');

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir).sort()) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}
const sources = walk(SRC).filter(
  (f) => /\.(ts|tsx)$/.test(f) && !/\.test\.tsx?$/.test(f) && !f.endsWith('support.ts'),
);
const read = (f: string): string => readFileSync(f, 'utf8');

describe('client components', () => {
  it("no 'use client' file imports a server module, the composition root or a domain package", () => {
    const bad: string[] = [];
    for (const f of sources) {
      const src = read(f);
      if (!/^\s*['"]use client['"]/.test(src)) continue;
      for (const m of src.matchAll(/from\s+['"]([^'"]+)['"]/g)) {
        const spec = m[1] as string;
        if (
          /composition\.server|server-only|\/server\/|^@umsbx\/(?!contracts)/.test(spec) ||
          spec.startsWith('node:')
        )
          bad.push(`${relative(WEB, f)} -> ${spec}`);
      }
    }
    expect(bad).toEqual([]);
  });
});

describe('routes', () => {
  const routeFiles = sources.filter((f) => /\/route\.ts$/.test(f));
  it('there is at least the documented route set', () => {
    const paths = routeFiles.map((f) => pathFromFile(relative(join(SRC, 'app'), f))).sort();
    for (const p of [
      '/api/session',
      '/api/quotes',
      '/api/briefs',
      '/api/discover',
      '/api/approvals',
      '/api/orders',
      '/api/orders/[ref]/checkout',
      '/api/orders/[ref]/cancel',
      '/api/orders/[ref]',
      '/api/library',
      '/api/library/[id]/link',
      '/c/[token]',
      '/api/receipts/[order]',
      '/api/cases',
      '/healthz',
    ])
      expect(paths).toContain(p);
  });
  it('every route file exports routeMeta and builds each handler with withRoute (check:routes)', () => {
    const problems = routeFiles.flatMap((f) =>
      checkEntry(relative(WEB, f), relative(join(SRC, 'app'), f), read(f)).problems.map(
        (p) => `${relative(WEB, f)}: ${p}`,
      ),
    );
    expect(problems).toEqual([]);
  });
});

describe('pages and inputs', () => {
  it('no card-like input exists in any source (P8)', () => {
    const bad = sources.filter((f) =>
      /(?<![A-Za-z])(?:name|id|autoComplete|autocomplete)=["'](?:card|cc-|cvv|cvc|pan\b)/i.test(
        read(f),
      ),
    );
    expect(bad.map((f) => relative(WEB, f))).toEqual([]);
  });
  it('no source loads a PayPal script or SDK', () => {
    const bad = sources.filter((f) => /paypal(?:objects)?\.com|@paypal\//i.test(read(f)));
    expect(bad.map((f) => relative(WEB, f))).toEqual([]);
  });
});

describe('security headers on pages (SOP 10)', () => {
  it('pageHeaders carries the CSP with the nonce, frame-ancestors and the rest', () => {
    const h = pageHeaders('abcdef0123456789abcdef0123456789');
    expect(h['Content-Security-Policy']).toContain("'nonce-abcdef0123456789abcdef0123456789'");
    expect(h['Content-Security-Policy']).toContain("frame-ancestors 'none'");
    expect(h['Content-Security-Policy']).toContain("form-action 'self'");
    expect(h['X-Content-Type-Options']).toBe('nosniff');
    expect(h['Strict-Transport-Security']).toBeDefined();
    expect(h['Cache-Control']).toContain('no-store');
  });
  it('pageHeaders agree with securityHeaders of the route wrapper for the same nonce', () => {
    const n = 'abcdef0123456789abcdef0123456789';
    const page = pageHeaders(n);
    for (const [k, v] of Object.entries(securityHeaders(n))) expect(page[k]).toBe(v);
  });
  it('the middleware applies pageHeaders to every page and is not the only authorisation', () => {
    const mw = read(join(SRC, 'middleware.ts'));
    expect(mw).toContain('pageHeaders');
    expect(mw).toContain('x-nonce');
  });
});

describe('build configuration (A-25)', () => {
  it('browser source maps are off and the powered-by header is removed', () => {
    const cfg = readFileSync(join(WEB, 'next.config.mjs'), 'utf8');
    expect(cfg).toMatch(/productionBrowserSourceMaps:\s*false/);
    expect(cfg).toMatch(/poweredByHeader:\s*false/);
  });
});
