// INT-OPS-A / OPS-A.3: the alert pages as text (the unit runner does not compile .tsx, as the other page tests).
// A buyer, a seller and a visitor land on sign-in before anything is read; an operator without the second
// factor reads, and every action button is off. The pages read only through composition/ops-home.ts (S3), carry
// no identity, no inline style and no raw HTML, and post only to AL's routes with a single-use key.
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const here = fileURLToPath(new URL('.', import.meta.url));
const source = (rel: string): string =>
  readFileSync(join(here, rel), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');

const PAGES = ['app/ops/alerts/page.tsx', 'app/ops/alerts/[id]/page.tsx'];
const PARTS = ['ui/ops/AlertList.tsx', 'ui/ops/AlertDetail.tsx'];

describe('who may open the alert pages', () => {
  it('the files exist', () => {
    for (const f of [...PAGES, ...PARTS, 'ui/shell/AlertBell.tsx'])
      expect(existsSync(join(here, f)), f).toBe(true);
  });

  it.each(PAGES)('%s sends anyone but an operator to sign in before reading', (f) => {
    const page = source(f);
    expect(page).toMatch(/const actor = await currentActor\(\)/);
    expect(page).toMatch(
      /actor\?\.kind !== 'operator'\) redirect\('\/signin\?next=\/ops\/alerts[^']*'\)/,
    );
    expect(page.indexOf("actor?.kind !== 'operator'")).toBeLessThan(page.search(/await read[A-Z]/));
  });

  it.each(PAGES)(
    '%s does not turn an operator without the code away: it reads, the buttons are off',
    (f) => {
      const page = source(f);
      expect(page).not.toMatch(/MfaNeeded|mfa_required/);
      expect(page).toMatch(/actor\.mfa/);
    },
  );
});

describe('what the alert pages read and show', () => {
  it.each(PAGES)(
    '%s reads only from composition/ops-home and never from the door or the root',
    (f) => {
      const page = source(f);
      expect(page).toMatch(/from '(\.\.\/)+composition\/ops-home'/);
      expect(page).not.toMatch(/server\/access/);
      expect(page).not.toMatch(/composition\.server/);
      expect(page).not.toMatch(/\b(INSERT|UPDATE|DELETE)\b/);
    },
  );

  it.each([...PAGES, ...PARTS])('%s has no inline style and no raw HTML', (f) => {
    const src = source(f);
    expect(src).not.toMatch(/style=/);
    expect(src).not.toMatch(/dangerouslySetInnerHTML/);
  });

  it.each([...PAGES, ...PARTS])('%s names no buyer, no seller and no provider id', (f) => {
    expect(source(f)).not.toMatch(
      /buyer_id|publisher_id|display_name|merchant|provider_order_id|capture_id|ip_hash/,
    );
  });

  it('the list page and its table have names a screen reader can use', () => {
    const list = source('ui/ops/AlertList.tsx');
    expect(list).toMatch(/<caption/);
    expect(list).toMatch(/aria-label=/);
    expect(list).toMatch(/aria-current/);
    expect(list).toMatch(/Show resolved|show_resolved/);
  });

  it('the detail posts to AL routes with the single-use key and CSRF, and never fetches by itself', () => {
    const d = source('ui/ops/AlertDetail.tsx');
    expect(d).toMatch(/postJson\(/);
    expect(d).toMatch(/'idempotency-key'/);
    expect(d).not.toMatch(/\bfetch\(/);
    expect(d).toMatch(/needs your authenticator code|\.hint/);
    expect(d).toMatch(/disabled=\{/);
  });

  it('the fix link comes from the view, not from a string in the page', () => {
    const d = source('ui/ops/AlertDetail.tsx');
    expect(d).toMatch(/view\.fix\.href|\.fix\.href/);
    expect(d).not.toMatch(/href="\/ops\/money/);
  });
});
