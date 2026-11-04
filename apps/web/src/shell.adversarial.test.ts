// INT-UI0 / Security: every new operator page starts with the same operator check as /ops; every href the shell
// holds is a same-site relative path that lib/next-path.ts accepts; the seller shell holds no buyer identity.
// The cross-role sessions are driven in e2e/shell.spec.ts.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { safeNext } from './lib/next-path';
import { SHELL_MOVES, KEPT_URLS, stubFor } from './lib/shell-moves';
import { TABS, subTabsFor } from './lib/shell-tabs';
import { breadcrumbFor } from './lib/breadcrumb';

const here = fileURLToPath(new URL('.', import.meta.url));
const read = (rel: string) => readFileSync(join(here, rel), 'utf8');
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

function pagesUnder(dir: string): string[] {
  const out: string[] = [];
  for (const n of readdirSync(join(here, dir))) {
    const rel = `${dir}/${n}`;
    if (statSync(join(here, rel)).isDirectory()) out.push(...pagesUnder(rel));
    else if (n === 'page.tsx') out.push(rel);
  }
  return out;
}

describe('every operator page starts with the operator check', () => {
  const pages = pagesUnder('app/ops');
  it('finds the home page and the three new ones', () => {
    for (const p of [
      'app/ops/page.tsx',
      'app/ops/money/page.tsx',
      'app/ops/sellers/page.tsx',
      'app/ops/controls/page.tsx',
    ])
      expect(pages).toContain(p);
  });
  it.each(pages)('%s', (rel) => {
    const src = strip(read(rel));
    const path = '/' + rel.replace(/^app\//, '').replace(/\/page\.tsx$/, '');
    const body = src.slice(src.indexOf('export default'));
    // The first statement that reads the session is currentActor, and the next one refuses a non operator.
    const call = body.indexOf('await currentActor()');
    expect(call, `${rel} must read the actor first`).toBeGreaterThan(-1);
    const guard = `if (actor?.kind !== 'operator') redirect('/signin?next=${path}');`;
    const at = body.indexOf(guard);
    expect(at, `${rel} must refuse a non operator with ${guard}`).toBeGreaterThan(call);
    // Nothing else runs between the actor read and the refusal.
    expect(body.slice(call, at).split(';').length).toBeLessThanOrEqual(2);
  });
  it('the pages do not read the engine before the check', () => {
    for (const rel of pagesUnder('app/ops')) {
      const src = strip(read(rel));
      const body = src.slice(src.indexOf('export default'));
      const guard = body.indexOf("redirect('/signin?next=");
      expect(body.slice(0, guard)).not.toMatch(/opsSnapshot|readOps|engine\./);
    }
  });
});

describe('every href is a same-site relative path', () => {
  const all: string[] = [];
  for (const persona of Object.values(TABS)) for (const t of persona) all.push(t.href);
  for (const m of SHELL_MOVES) all.push(m.from, m.to);
  for (const k of KEPT_URLS) all.push(k.url);
  for (const p of ['/ops/publishers', '/ops/sellers', '/ops/evals'])
    for (const s of subTabsFor('operator', p) ?? []) all.push(s.href);
  for (const p of [
    '/ops/money',
    '/ops/evals',
    '/publisher/offers/new',
    '/library/ent_1',
    '/discover',
  ])
    for (const c of breadcrumbFor(p)) if (c.href !== null) all.push(c.href);
  const unique = [...new Set(all)];
  it('collects a useful number of them', () => {
    expect(unique.length).toBeGreaterThan(20);
  });
  it.each(unique)('%s is accepted by next-path and has no // or scheme', (href) => {
    expect(safeNext(href)).toBe(href);
    expect(href).not.toMatch(/\/\/|^[a-z][a-z0-9+.-]*:/i);
    expect(href.startsWith('/')).toBe(true);
  });
  it('a stub link is a path plus a plain fragment id', () => {
    for (const m of SHELL_MOVES.filter((x) => x.moved)) {
      const [path, frag, ...rest] = stubFor(m).href.split('#');
      expect(rest).toEqual([]);
      expect(safeNext(path)).toBe(path);
      expect(frag).toMatch(/^[a-z][a-z0-9-]*$/);
    }
  });
  it('next-path refuses the tricks a redirect could be given', () => {
    for (const bad of [
      '//evil.example',
      '/\\evil.example',
      'https://evil.example',
      '/ops?next=//x#y',
      'javascript:alert(1)',
    ])
      expect(safeNext(bad), bad).toBe('/');
  });
});

describe('the seller shell shows no buyer identity', () => {
  it('seller tabs all live under /publisher', () => {
    for (const t of TABS.seller) expect(t.href).toMatch(/^\/publisher(\/|$)/);
  });
  it('buyer and operator tabs are not reachable from the seller list', () => {
    const hrefs = TABS.seller.map((t) => t.href).join(' ');
    expect(hrefs).not.toMatch(/\/(buyer|library|discover|ops)\b/);
  });
  it('the shell files take no actor, email or buyer id', () => {
    for (const f of ['Shell', 'Tabs', 'Breadcrumb', 'SearchSlot', 'PhoneBar']) {
      const src = strip(read(`ui/shell/${f}.tsx`));
      expect(src, f).not.toMatch(
        /\bemail\b|buyer_id|buyer_name|display_name|currentActor|session/i,
      );
    }
  });
  it('no shell file reads a cookie, storage or the network', () => {
    for (const f of ['Shell', 'Tabs', 'Breadcrumb', 'SearchSlot', 'PhoneBar']) {
      const src = strip(read(`ui/shell/${f}.tsx`));
      expect(src, f).not.toMatch(
        /document\.cookie|localStorage|sessionStorage|fetch\(|dangerouslySetInnerHTML/,
      );
    }
  });
});

describe('the shell does not touch the PayPal controls', () => {
  it('no shell or composition file names the connect flag or the approvals table', () => {
    const files = [
      ...['Shell', 'Tabs', 'Breadcrumb', 'SearchSlot', 'PhoneBar'].map((f) => `ui/shell/${f}.tsx`),
      ...readdirSync(join(here, 'composition')).map((f) => `composition/${f}`),
    ];
    for (const f of files)
      expect(strip(read(f)), f).not.toMatch(
        /UMS_PAYPAL_CONNECT|outbound_approvals|safety:approve|paypal_outbound/,
      );
  });
});
