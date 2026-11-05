// GATE35-FIX (docs/specs/fix-gate35.md): the pure helpers and the page source of the gate 3-5 fixes.
// The pages are .tsx files the unit runner does not compile, so their source is read as text. Nothing
// here touches the money path.
import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { NOT_PAID_SHORT, NOT_PAID_YET, hasReceipt, moneyStateText } from './lib/buyer-copy';
import { LINE_TEXT } from './lib/composite-copy';
import { PRIVACY_DOC, REFUNDS_DOC, SIGNIN_PRIVACY_SENTENCE } from './lib/legal-copy';
import {
  LABEL_VERIFIED_BY,
  MARKED_CHECKED,
  OPS_MFA_BODY,
  OPS_MFA_HEADING,
  VERIFIED_BY,
  verifiedByText,
} from './lib/payee-copy';
import {
  FEE_NOT_REPORTED,
  feeText,
  isCountedSale,
  notCountedText,
  splitSales,
  visibleLines,
} from './lib/statement-copy';
import { discoverForNonBuyer } from './lib/nav';
import { discoverSignInHref, safeNext, shouldAutoSearch } from './lib/next-path';

const read = (rel: string): string => readFileSync(new URL(rel, import.meta.url), 'utf8');
const strip = (s: string): string => s.replace(/\/\/.*$/gm, '');
const NO_DASH = /[‐-―−]| - |--/;

describe('D2: the unpaid item page', () => {
  it('says Not paid yet for an order the buyer never approved, and keeps the other words', () => {
    expect(NOT_PAID_YET.startsWith(NOT_PAID_SHORT)).toBe(true);
    expect(moneyStateText('pending', true)).toBe(NOT_PAID_SHORT);
    expect(moneyStateText('unknown', true)).toBe(NOT_PAID_SHORT);
    expect(moneyStateText('pending')).toBe(LINE_TEXT.pending);
    expect(moneyStateText('captured', false)).toBe('Paid');
  });
  it('shows View receipt only when a receipt exists', () => {
    expect(hasReceipt({ order_id: 'ord_1', receipt_versions: [] })).toBe(false);
    expect(hasReceipt({ order_id: null, receipt_versions: [1] })).toBe(false);
    expect(hasReceipt({ order_id: 'ord_1', receipt_versions: [1] })).toBe(true);
  });
  it('the item page uses both', () => {
    const page = strip(read('./app/library/[entitlement]/page.tsx'));
    expect(page).toContain('NOT_PAID_YET');
    expect(page).toMatch(/moneyStateText\(item\.money, /);
    expect(page).toContain('hasReceipt(item)');
  });
});

describe('D3: the refund policy says what is true', () => {
  const text = REFUNDS_DOC.sections.flatMap((s) => s.paragraphs).join(' ');
  it('names no help case that does not exist', () => {
    expect(text).not.toMatch(/open a help case from your order/i);
    expect(text).toMatch(/no refund request form yet/i);
    expect(text).toMatch(/Problem with this item\?/);
    expect(text).toMatch(/operator/i);
    expect(text).not.toMatch(NO_DASH);
  });
});

describe('D4b: an operator without the authenticator code', () => {
  it('is told why, on the page, not sent away silently', () => {
    expect(OPS_MFA_HEADING).toMatch(/authenticator code/i);
    expect(OPS_MFA_BODY).toMatch(/not available/i);
    expect(`${OPS_MFA_HEADING} ${OPS_MFA_BODY}`).not.toMatch(NO_DASH);
    const page = strip(read('./app/ops/payee-requests/page.tsx'));
    // INT-OPS-A.7 moved the wall from the page into the writes: the page shows the queue and the
    // buttons say OPS_NEEDS_CODE instead of a heading.
    expect(page).not.toContain('OPS_MFA_HEADING');
    expect(page).not.toMatch(/actor\?\.kind === 'operator' && !actor\.mfa/);
    expect(strip(read('./app/ops/payee-requests/DecisionForm.tsx'))).toContain('OPS_NEEDS_CODE');
  });
});

describe('D5: payee wording, fee lines and the skin cookie', () => {
  it('a payee marked at demo load is called marked as checked, an operator decision is an operator check', () => {
    expect(verifiedByText(false)).toBe(MARKED_CHECKED);
    expect(verifiedByText(true)).toBe(VERIFIED_BY);
    expect(MARKED_CHECKED).toMatch(/marked as checked/i);
    expect(VERIFIED_BY).toMatch(/operator/i);
    expect(LABEL_VERIFIED_BY).not.toBe('Verified by');
    const page = strip(read('./app/publisher/payout-account/page.tsx'));
    expect(page).toContain('verifiedByText(');
  });
  it('a dry run fee is Not reported even when a value is stored; a sandbox fee is shown', () => {
    expect(feeText(45, 'USD', 'dryrun')).toBe(FEE_NOT_REPORTED);
    expect(feeText(null, 'USD', 'sandbox')).toBe(FEE_NOT_REPORTED);
    expect(feeText(45, 'USD', 'sandbox')).toMatch(/0\.45/);
    for (const p of ['./app/publisher/sales/page.tsx', './app/publisher/statement/page.tsx'])
      expect(strip(read(p))).toContain('feeText(');
  });
  it('a dry run statement leaves fee ledger lines out of the lines table', () => {
    const lines = [{ kind: 'sale' }, { kind: 'paypal_fee' }];
    expect(visibleLines(lines, 'dryrun')).toEqual([{ kind: 'sale' }]);
    expect(visibleLines(lines, 'sandbox')).toHaveLength(2);
    expect(strip(read('./app/publisher/statement/page.tsx'))).toContain('visibleLines(');
  });
  it('the privacy notice and the sign-in note name the um_skin cookie and what it holds', () => {
    const priv = PRIVACY_DOC.sections.flatMap((s) => s.paragraphs).join(' ');
    expect(priv).toMatch(/um_skin/);
    expect(priv).toMatch(/only the name of the skin/i);
    expect(SIGNIN_PRIVACY_SENTENCE).toMatch(/appearance cookie/i);
    expect(SIGNIN_PRIVACY_SENTENCE).toMatch(/session cookie/i);
    expect(`${priv} ${SIGNIN_PRIVACY_SENTENCE}`).not.toMatch(NO_DASH);
  });
});

describe('D6: the sales page counts paid units only', () => {
  const row = (status: string) => ({ status, amount_minor: 100 });
  it('unpaid statuses are not counted', () => {
    for (const s of ['expected', 'pending', 'declined']) expect(isCountedSale(s)).toBe(false);
    for (const s of ['captured_verified', 'partially_refunded', 'refunded', 'reversed'])
      expect(isCountedSale(s)).toBe(true);
  });
  it('splitSales separates the two and keeps order', () => {
    const rows = [row('captured_verified'), row('expected'), row('refunded'), row('declined')];
    const { counted, notCounted } = splitSales(rows);
    expect(counted.map((r) => r.status)).toEqual(['captured_verified', 'refunded']);
    expect(notCounted).toHaveLength(2);
  });
  it('the note agrees with its number and has no dash', () => {
    expect(notCountedText(1)).toBe('Awaiting payment, not counted: 1 unit.');
    expect(notCountedText(3)).toBe('Awaiting payment, not counted: 3 units.');
    expect(notCountedText(3)).not.toMatch(NO_DASH);
    const page = strip(read('./app/publisher/sales/page.tsx'));
    expect(page).toContain('splitSales(');
    expect(page).toContain('notCountedText(');
  });
});

describe('D7: a publisher or operator on /discover', () => {
  it('is told in a plain line, with a link to their own home', () => {
    const p = discoverForNonBuyer('publisher');
    expect(p.href).toBe('/publisher');
    expect(p.line).toMatch(/buyer/i);
    expect(p.line).not.toMatch(/sign in first/i);
    expect(discoverForNonBuyer('operator').href).toBe('/ops');
    expect(p.line + p.label).not.toMatch(NO_DASH);
    const page = strip(read('./app/discover/page.tsx'));
    expect(page).toContain('discoverForNonBuyer(');
  });
});

describe('D8: the typed need survives sign in and runs', () => {
  it('the sign in link keeps the need, encoded and inside the allow list', () => {
    expect(discoverSignInHref('')).toBe('/signin?next=/discover');
    expect(discoverSignInHref('   ')).toBe('/signin?next=/discover');
    const href = discoverSignInHref("tide tables, under $1 (it's 5!)");
    const next = new URL(href, 'http://x').searchParams.get('next')!;
    expect(safeNext(next)).toBe(next);
    expect(new URL(next, 'http://x').searchParams.get('need')).toBe(
      "tide tables, under $1 (it's 5!)",
    );
  });
  it('a hostile next is still refused', () => {
    expect(safeNext('//evil.example')).toBe('/');
    expect(safeNext('https://evil.example')).toBe('/');
    expect(safeNext(undefined)).toBe('/');
  });
  it('the search runs only for a signed in buyer with a need', () => {
    expect(shouldAutoSearch('tide tables', true)).toBe(true);
    expect(shouldAutoSearch('tide tables', false)).toBe(false);
    expect(shouldAutoSearch('  ', true)).toBe(false);
    const form = strip(read('./app/discover/DiscoverForm.tsx'));
    expect(form).toContain('shouldAutoSearch(');
    expect(form).toContain('discoverSignInHref(');
    const signin = strip(read('./app/signin/page.tsx'));
    expect(signin).toContain("from '../../lib/next-path'");
  });
});

describe('D9: hot tags on the home shelf', () => {
  it('each tile gets the cheapest option label from the stored offer', () => {
    const home = strip(read('./app/page.tsx'));
    expect(home).toMatch(/tag=\{cheapest \? optionLabel\(cheapest\.option\) : ''\}/);
    expect(strip(read('./ui/OfferTile.tsx'))).toContain('<CoverTile');
  });
});

describe('D10: the narrow table hint', () => {
  it('has a visible hint class in its own css file, not in globals.css', () => {
    expect(existsSync(new URL('./app/tables.css', import.meta.url))).toBe(true);
    const css = read('./app/tables.css');
    expect(css).toMatch(/\.table-hint/);
    expect(css).toMatch(/@media/);
    expect(css).not.toMatch(/style=|url\(|@import/);
    const page = read('./app/publisher/sales/page.tsx');
    expect(page).toContain("import '../../tables.css';");
    expect(page).toContain('Scroll sideways to see more');
    expect(read('./app/globals.css')).not.toContain('table-hint');
  });
});

describe('D11: e2e screenshots go to an ignored directory', () => {
  it('no screenshot is written under e2e/shots any more', () => {
    const spec = read('../e2e/zcomposite.spec.ts');
    expect(spec).toContain('test-results/shots/');
    expect(spec).not.toContain("'./shots/'");
    expect(read('../playwright.config.ts')).toContain("outputDir: './test-results'");
    expect(read('../.gitignore')).toContain('test-results/');
  });
});
