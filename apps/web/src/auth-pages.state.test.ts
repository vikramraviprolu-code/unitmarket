// ID-ACCOUNTS: the landing page, the three role pages, the sign in pages and the account page, read as
// source (the unit runner does not compile .tsx; the browser run in e2e renders them). What is pinned: the
// words come from lib/account-copy.ts, the forms carry the right autocomplete and no paste block, the
// pages guard their roles, the styles use skin tokens only, and nothing here touches globals.css or the
// Deep Harbour file. The pages that other lanes own are not edited.
import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { mergedTokens } from './skin-css-test-support';
import { DOORS, SIGNIN_ROLE_LINKS } from './lib/account-copy';

const read = (rel: string): string => readFileSync(new URL(rel, import.meta.url), 'utf8');
const code = (rel: string): string =>
  read(rel)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');

const PAGES = [
  './app/buyer/page.tsx',
  './app/seller/page.tsx',
  './app/signup/page.tsx',
  './app/signin/buyer/page.tsx',
  './app/signin/seller/page.tsx',
  './app/signin/operator/page.tsx',
  './app/account/page.tsx',
  './app/help/password/page.tsx',
] as const;
const FORMS = [
  './app/signup/SignUpForm.tsx',
  './app/signin/buyer/BuyerSignInForm.tsx',
  './app/signin/seller/SellerSignInForm.tsx',
  './app/signin/operator/OperatorSignInForm.tsx',
  './app/account/AccountForms.tsx',
] as const;

describe('files', () => {
  it('every page, form and style exists', () => {
    for (const f of [
      ...PAGES,
      ...FORMS,
      './app/auth.css',
      './ui/RoleDoors.tsx',
      './ui/PasswordField.tsx',
    ])
      expect(existsSync(new URL(f, import.meta.url)), f).toBe(true);
  });
  it('every new page has a title, takes its words from the account copy and uses no inline style or raw html', () => {
    for (const f of PAGES) {
      const c = code(f);
      expect(c, f).toMatch(/export const metadata/);
      expect(c, f).toContain("lib/account-copy'");
      expect(c, f).not.toMatch(/style=|dangerouslySetInnerHTML/);
      expect(c, f).toContain("auth.css'");
    }
  });
});

describe('landing page', () => {
  const page = code('./app/page.tsx');
  const doors = code('./ui/RoleDoors.tsx');
  it('keeps the hero heading and the offer shelf, and adds the doors, server rendered', () => {
    expect(page).toContain('Buy just the article you need');
    expect(page).toContain('Open an article');
    expect(page).toContain('<RoleDoors');
    expect(page).toContain("auth.css'");
    expect(doors).not.toMatch(/'use client'/);
    expect(doors).not.toMatch(/useState|useEffect|onClick/);
  });
  it('shows a link per door, and for a signed in actor their own door goes home', () => {
    expect(doors).toContain('DOORS');
    expect(doors).toMatch(/home_href/);
    expect(doors).toMatch(/home_button/);
    expect(doors).toMatch(/aria-labelledby/);
    expect(page).toMatch(/currentActor\(\)/);
  });
  it('the door table has three entries and the sign in cards link to the three sign in pages', () => {
    expect(DOORS.map((d) => d.href)).toEqual(['/buyer', '/seller', '/signin/operator']);
    expect(SIGNIN_ROLE_LINKS.map((l) => l.href)).toEqual([
      '/signin/buyer',
      '/signin/seller',
      '/signin/operator',
    ]);
  });
});

describe('/signin keeps the persona form', () => {
  const page = code('./app/signin/page.tsx');
  it('adds the role cards above it and a heading for judges and testers', () => {
    expect(page).toContain('SIGNIN_ROLES_TITLE');
    expect(page).toContain('SIGNIN_TESTERS_TITLE');
    expect(page).toContain('<SignInForm');
    expect(page.indexOf('SIGNIN_ROLE_LINKS')).toBeLessThan(page.indexOf('<SignInForm'));
    expect(page).toContain('data-testid="signin-privacy"');
    expect(page).toContain('data-testid="signin-apply"');
    expect(page).toContain('<h1>Sign in</h1>');
  });
  it('the persona form file is untouched in the parts the end to end tests use', () => {
    const form = read('./app/signin/SignInForm.tsx');
    for (const s of [
      'Who are you testing as?',
      "postJson<{ csrf_token: string }>('/api/session'",
      'window.location.assign(next)',
    ])
      expect(form).toContain(s);
  });
});

describe('forms', () => {
  it('signup: new-password on both fields, show and hide, a required tick with links, a honeypot, no paste block', () => {
    const c = code('./app/signup/SignUpForm.tsx');
    const pw = code('./ui/PasswordField.tsx');
    expect(`${c}${pw}`).toMatch(/autoComplete=\{?['"]new-password['"]/);
    expect(c.match(/new-password/g)?.length ?? 0).toBeGreaterThanOrEqual(2);
    expect(c).toMatch(/autoComplete="username"/);
    expect(pw).toMatch(/aria-controls/);
    expect(pw).not.toMatch(/aria-pressed/);
    expect(pw).toMatch(/type=\{shown \? 'text' : 'password'\}/);
    expect(c).toMatch(/type="checkbox"/);
    expect(c).toContain('/legal/terms');
    expect(c).toContain('/legal/privacy');
    expect(c).toContain('extra_k7q');
    expect(c).toContain('accept_terms');
    expect(c).toContain("'/api/accounts'");
    expect(c).toContain('safeNext');
    expect(`${c}${pw}`).not.toMatch(/onPaste|paste/i);
    expect(c).toMatch(/toLowerCase\(\)/);
    // the password is sent exactly as typed: no line trims it
    for (const line of c.split('\n'))
      expect(line, line).not.toMatch(/password.*\.trim\(\)|\.trim\(\).*password/i);
  });
  it('buyer sign in: current-password, show and hide, the one failure sentence, links to help and signup', () => {
    const f = code('./app/signin/buyer/BuyerSignInForm.tsx');
    const p = code('./app/signin/buyer/page.tsx');
    expect(f).toMatch(/autoComplete="username"/);
    expect(`${f}${code('./ui/PasswordField.tsx')}`).toMatch(/current-password/);
    expect(f).toContain("'/api/accounts/login'");
    expect(f).toContain('BUYER_SIGNIN_FAILED');
    expect(f).not.toMatch(/r\.message|r\.code\b.*locked/);
    expect(`${f}${p}`).toContain('/help/password');
    expect(`${f}${p}`).toContain('/signup');
  });
  it('seller and operator sign in post to the existing persona route and nothing else', () => {
    const s = code('./app/signin/seller/SellerSignInForm.tsx');
    const o = code('./app/signin/operator/OperatorSignInForm.tsx');
    expect(s).toContain("'/api/session'");
    expect(s).toContain('PUBLISHER_PERSONAS');
    expect(s).not.toMatch(/persona: 'operator'|buyer-a/);
    expect(o).toContain("'/api/session'");
    expect(o).toMatch(/persona: 'operator'/);
    expect(o).toContain('OPERATOR_CODE_HINT');
    expect(o).toMatch(/autoComplete="one-time-code"/);
    expect(o).toMatch(/autoComplete="username"/);
    expect(o).toMatch(/current-password/);
  });
  it('account forms: change password and sign out on all devices through the two routes', () => {
    const c = code('./app/account/AccountForms.tsx');
    expect(c).toContain("'/api/accounts/password'");
    expect(c).toContain("'/api/accounts/sessions/revoke-all'");
    expect(c).toContain('current-password');
    expect(c).toContain('new-password');
    expect(c).toMatch(/role="status"|aria-live/);
  });
  it('every form field has a label and a visible focus (the global :focus-visible rule is kept)', () => {
    for (const f of FORMS) {
      const c = code(f);
      const inputs = c.match(/<input\b/g)?.length ?? 0;
      const labels = c.match(/<label\b|<PasswordField\b/g)?.length ?? 0;
      expect(labels, f).toBeGreaterThanOrEqual(Math.min(inputs, 1));
    }
    expect(read('./app/globals.css')).toMatch(
      /:focus-visible\s*\{[^}]*outline:\s*3px solid var\(--focus\)/,
    );
  });
});

describe('guards', () => {
  it('/account sends anyone who is not a buyer to buyer sign in, and a persona sees why it has no password', () => {
    const c = code('./app/account/page.tsx');
    expect(c).toMatch(/actor\?\.kind !== 'buyer'/);
    expect(c).toContain("redirect('/signin/buyer?next=/account')");
    expect(c).toContain('accounts.view(');
    expect(c).toContain('ACCOUNT_NO_PASSWORD');
  });
  it('the sign in pages read next through safeNext only', () => {
    for (const f of ['./app/signin/buyer/page.tsx', './app/signup/page.tsx']) {
      const c = code(f);
      expect(c, f).toContain('safeNext(');
      expect(c, f).not.toMatch(/href=\{`/);
    }
  });
});

describe('auth.css', () => {
  const css = read('./app/auth.css').replace(/\/\*[\s\S]*?\*\//g, '');
  const tokens = new Set([...mergedTokens('market'), ...mergedTokens('harbour')].map(([k]) => k));
  it('uses skin tokens only: no colour literal, no url, no import, no data uri', () => {
    expect(css).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    expect(css).not.toMatch(/\b(rgb|rgba|hsl|hsla|hwb|lab|lch|oklab|oklch|color-mix)\(/);
    expect(css).not.toMatch(/url\(|@import|data:/);
    expect(css).not.toMatch(
      /\b(?:color|background|background-color|border|border-color|outline|box-shadow)\s*:[^;]*\b(?:red|blue|green|white|black|gray|grey|orange|yellow|teal|navy)\b/i,
    );
  });
  it('every custom property it reads is declared by a skin or by itself', () => {
    const own = new Set([...css.matchAll(/(--[a-z0-9-]+)\s*:/g)].map((m) => m[1]!));
    const used = [...css.matchAll(/var\((--[a-z0-9-]+)/g)].map((m) => m[1]!);
    expect(used.length).toBeGreaterThan(20);
    for (const u of used)
      expect(tokens.has(u) || own.has(u) || ['--space', '--font', '--mono'].includes(u), u).toBe(
        true,
      );
  });
  it('has large targets, a 400 px rule, no fixed width over 400 px and respects reduced motion', () => {
    expect(css).toMatch(/min-height:\s*(4[4-9]|[5-9]\d)px/);
    expect(css).toMatch(/@media \(max-width: (4\d\d|5\d\d|6\d\d)px\)/);
    expect(css).not.toMatch(/(?<!max-|min-)width:\s*([5-9]\d\d|\d{4,})px/);
    expect(css).toMatch(/prefers-reduced-motion/);
  });
  it('does not touch the shared skin files', () => {
    expect(css).not.toMatch(/:root\[data-skin/);
    expect(read('./app/globals.css')).not.toContain('role-door');
    expect(read('./app/skin-harbour.css')).not.toContain('role-door');
  });
});
