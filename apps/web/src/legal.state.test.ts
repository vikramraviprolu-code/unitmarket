// LEGAL-A (docs/specs/legal-a-pages.md): four draft legal pages, the footer links and the sign-in
// privacy notice. The unit runner does not compile .tsx, so page sources are read as text (as
// order-pages.state.test.ts does) and the copy module is imported for what the pages render.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { LEGAL_BANNER, LEGAL_DOCS, LEGAL_NAV, LEGAL_SANDBOX_LINE } from './lib/legal-copy';
import {
  SIGNIN_PRIVACY_END,
  SIGNIN_PRIVACY_LEAD,
  SIGNIN_PRIVACY_LINK,
  SIGNIN_PRIVACY_SENTENCE,
} from './lib/legal-copy';

const read = (rel: string): string => readFileSync(new URL(rel, import.meta.url), 'utf8');
const strip = (s: string): string => s.replace(/\/\/.*$/gm, '');

const ROUTES = [
  { slug: 'terms', href: '/legal/terms', constant: 'TERMS_DOC', live: 'termsDoc(days)' },
  { slug: 'privacy', href: '/legal/privacy', constant: 'PRIVACY_DOC' },
  { slug: 'refunds', href: '/legal/refunds', constant: 'REFUNDS_DOC' },
  {
    slug: 'publisher-terms',
    href: '/legal/publisher-terms',
    constant: 'PUBLISHER_TERMS_DOC',
    live: 'publisherTermsDoc(days)',
  },
] as const;

describe('the four legal routes (LEGAL-A)', () => {
  for (const r of ROUTES) {
    it(`${r.href} is a server page that renders LegalPage with its own copy`, () => {
      const src = read(`./app/legal/${r.slug}/page.tsx`);
      const code = strip(src);
      expect(code).toMatch(/export default (async )?function/);
      expect(code).toContain('<LegalPage');
      // JR-1: the two pages that name the access window read it live (engine.platformAccessDays); the
      // others render their constant.
      const live = 'live' in r ? r.live : null;
      if (live === null) expect(code).toMatch(new RegExp(`doc=\\{${r.constant}\\}`));
      else {
        expect(code).toContain(`doc={${live}}`);
        expect(code).toContain('platformAccessDays()');
      }
      expect(code).toMatch(/from\s+'[./]+\/ui\/LegalPage'/);
      expect(code).toMatch(/from\s+'[./]+\/lib\/legal-copy'/);
      expect(code).toContain('export const metadata');
      // no client code, no cookies, no redirects; only the live pages may touch the server, and only
      // through server/access
      expect(code).not.toMatch(/'use client'/);
      expect(code).not.toMatch(/useState|useEffect|fetch\(|cookies|headers|redirect|notFound/);
      for (const m of code.matchAll(/from\s+['"]([^'"]+)['"]/g)) {
        const allowed = live !== null && /\/server\/access$/.test(m[1]!);
        if (!allowed)
          expect(m[1], m[0]).not.toMatch(
            /server|composition|@umsbx\/(db|payments|paypal)|access|session/,
          );
      }
    });

    it(`${r.href} has a copy entry with the same slug and href`, () => {
      const doc = LEGAL_DOCS.find((d) => d.slug === r.slug);
      expect(doc).toBeDefined();
      expect(doc?.href).toBe(r.href);
    });
  }

  it('there are exactly four documents, no more', () => {
    expect(LEGAL_DOCS.map((d) => d.slug)).toEqual(ROUTES.map((r) => r.slug));
  });
});

describe('LegalPage renders the banner, the sandbox line and every section', () => {
  const code = strip(read('./ui/LegalPage.tsx'));

  it('is a server component with no client code, no inline style and no italics', () => {
    expect(code).not.toMatch(/'use client'/);
    expect(code).not.toMatch(/useState|useEffect|dangerouslySetInnerHTML/);
    expect(code).not.toMatch(/style=/);
    expect(code).not.toMatch(/<(i|em)\b|italic/i);
  });

  it('shows the draft banner and the sandbox line from the copy module, above the sections', () => {
    expect(code).toContain('LEGAL_BANNER');
    expect(code).toContain('LEGAL_SANDBOX_LINE');
    expect(code.indexOf('LEGAL_BANNER')).toBeLessThan(code.indexOf('sections'));
  });

  it('renders the title as h1, each section heading as h2 and each paragraph as p', () => {
    expect(code).toMatch(/<h1[^>]*>\{doc\.title\}/);
    expect(code).toMatch(/<h2[^>]*>\{[a-z.]*heading\}/);
    expect(code).toMatch(/paragraphs\.map/);
    expect(code).toMatch(/<p[ >]/);
  });

  it('puts the banner and the sandbox line in the copy module', () => {
    expect(LEGAL_BANNER).toBe('Draft for owner approval. This is not legal advice.');
    expect(LEGAL_SANDBOX_LINE).toMatch(/test build/);
    expect(LEGAL_SANDBOX_LINE).toMatch(/no real money moves/i);
  });
});

describe('the footer (LEGAL-A)', () => {
  const code = strip(read('./app/layout.tsx'));

  it('has a Legal nav with the four links, under the existing footer sentence', () => {
    expect(code).toContain('aria-label="Legal"');
    for (const r of ROUTES) expect(code, r.href).toContain(`href="${r.href}"`);
    const footer = code.slice(code.indexOf('<footer'));
    expect(footer.indexOf('siteFooter(')).toBeGreaterThan(-1);
    expect(footer.indexOf('siteFooter(')).toBeLessThan(footer.indexOf('aria-label="Legal"'));
    expect(footer.indexOf('aria-label="Legal"')).toBeLessThan(footer.indexOf('</footer>'));
  });

  it('takes its link labels from the copy module', () => {
    expect(code).toContain('LEGAL_NAV');
    expect(Object.keys(LEGAL_NAV)).toEqual(ROUTES.map((r) => r.slug));
    for (const v of Object.values(LEGAL_NAV)) expect(v.length).toBeGreaterThan(3);
  });

  it('keeps the existing footer sentence and the other nav untouched', () => {
    expect(code).toContain('<p>{siteFooter(a.environment)}</p>');
    expect(code).toContain('aria-label="Main"');
  });
});

describe('the sign-in privacy notice (LEGAL-A, PRIV-6)', () => {
  const code = strip(read('./app/signin/page.tsx'));

  it('has the sentence above the form, the last three words linking to /legal/privacy', () => {
    expect(SIGNIN_PRIVACY_SENTENCE).toBe(
      'We use a session cookie, an appearance cookie that holds only your skin name, and a hashed network address. Read the privacy notice.',
    );
    expect(`${SIGNIN_PRIVACY_LEAD}${SIGNIN_PRIVACY_LINK}${SIGNIN_PRIVACY_END}`).toBe(
      SIGNIN_PRIVACY_SENTENCE,
    );
    expect(SIGNIN_PRIVACY_LINK.split(' ')).toHaveLength(3);
    expect(code).toMatch(/href="\/legal\/privacy"/);
    expect(code).toContain('{SIGNIN_PRIVACY_LEAD}');
    expect(code).toContain('{SIGNIN_PRIVACY_LINK}');
    expect(code.indexOf('/legal/privacy')).toBeLessThan(code.indexOf('<SignInForm'));
  });

  it('keeps the form and its next-path check as they were', () => {
    expect(code).toContain("<SignInForm next={safeNext(q['next'])} />");
  });
});

describe('the files LEGAL-A must not touch say so (spec: Do not)', () => {
  it('DiscoverForm.tsx has no link to the terms yet (a follow-up after UX-1A merges)', () => {
    expect(read('./app/discover/DiscoverForm.tsx')).not.toContain('/legal/');
  });
  it('globals.css has no legal block (existing classes only)', () => {
    expect(read('./app/globals.css')).not.toMatch(/legal/i);
  });
});
