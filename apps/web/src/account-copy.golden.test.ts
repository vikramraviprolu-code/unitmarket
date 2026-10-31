// ID-ACCOUNTS golden: every string of the landing page, the role pages, the buyer account screens and the
// password help. Static lines come from lib/account-copy.ts; variable lines are pinned for each state. The
// reviewed file is golden/account-copy.golden.txt. D-051: no italics, no dashes, no emoji.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import * as copy from './lib/account-copy';

const golden = readFileSync(new URL('./golden/account-copy.golden.txt', import.meta.url), 'utf8');

function lines(): string[] {
  const out: string[] = [];
  out.push(`contact: ${copy.CONTACT_ADDRESS} | consent version ${copy.ACCOUNT_CONSENT_VERSION}`);
  out.push(`doors title: ${copy.DOORS_TITLE}`);
  out.push(`doors lede: ${copy.DOORS_LEDE}`);
  for (const d of copy.DOORS) {
    out.push(`door ${d.id}: ${d.label} | ${d.tag} | ${d.line} | ${d.need}`);
    out.push(`door ${d.id} button: ${d.button} -> ${d.href}`);
    out.push(`door ${d.id} signed in: ${d.home_button} -> ${d.home_href}`);
  }
  out.push(`judges: ${copy.JUDGES_LEAD} | ${copy.JUDGES_LINK}`);
  out.push(`buyer: ${copy.BUYER_TITLE} | ${copy.BUYER_LEDE}`);
  out.push(`buyer need: ${copy.BUYER_NEED_TITLE}`);
  for (const i of copy.BUYER_NEED_ITEMS) out.push(`buyer need item: ${i}`);
  out.push(`buyer no email: ${copy.BUYER_NO_EMAIL}`);
  out.push(`buyer lost: ${copy.BUYER_LOST_TITLE} | ${copy.BUYER_LOST}`);
  out.push(`buyer buttons: ${copy.BUYER_CREATE} | ${copy.BUYER_SIGN_IN}`);
  out.push(`signup: ${copy.SIGNUP_TITLE} | ${copy.SIGNUP_LEDE}`);
  out.push(`signup fields: ${copy.SIGNUP_FIELD_NAME} | ${copy.SIGNUP_FIELD_USERNAME} | ${copy.SIGNUP_FIELD_COUNTRY} | ${copy.SIGNUP_FIELD_PASSWORD} | ${copy.SIGNUP_FIELD_REPEAT}`);
  out.push(`signup hints: ${copy.SIGNUP_HINT_NAME} | ${copy.SIGNUP_HINT_USERNAME}`);
  out.push(`signup rules: ${copy.SIGNUP_PASSWORD_RULES_TITLE}`);
  for (const r of copy.SIGNUP_PASSWORD_RULES) out.push(`signup rule: ${r}`);
  out.push(`signup show hide: ${copy.SIGNUP_SHOW} | ${copy.SIGNUP_HIDE}`);
  out.push(
    `signup accept: ${copy.SIGNUP_ACCEPT_LEAD}${copy.SIGNUP_ACCEPT_TERMS}${copy.SIGNUP_ACCEPT_AND}${copy.SIGNUP_ACCEPT_PRIVACY}${copy.SIGNUP_ACCEPT_END}${copy.SIGNUP_NEW_TAB}`,
  );
  out.push(`signup honeypot: ${copy.SIGNUP_HONEYPOT}`);
  out.push(`signup buttons: ${copy.SIGNUP_SUBMIT} | ${copy.SIGNUP_BUSY}`);
  out.push(`signup have account: ${copy.SIGNUP_HAVE_ACCOUNT} | ${copy.SIGNUP_SIGN_IN_LINK}`);
  out.push(`signup client errors: ${copy.SIGNUP_ERROR_TITLE} | ${copy.SIGNUP_MISMATCH} | ${copy.SIGNUP_TERMS_MISSING}`);
  for (const r of ['too_short', 'too_long', 'common', 'contains_username', 'same_as_name', 'repetitive', 'same_as_current', 'other'])
    out.push(`password reason ${r}: ${copy.passwordReasonText(r)}`);
  for (const c of ['taken', 'invalid_input', 'busy', 'rate_limited', 'csrf', 'other'])
    out.push(`signup error ${c}: ${copy.signupErrorText(c)}`);
  out.push(`signup error weak_password: ${copy.signupErrorText('weak_password', 'common')}`);
  out.push(`buyer sign in: ${copy.BUYER_SIGNIN_TITLE} | ${copy.BUYER_SIGNIN_LEDE}`);
  out.push(`buyer sign in fields: ${copy.BUYER_SIGNIN_USERNAME} | ${copy.BUYER_SIGNIN_PASSWORD}`);
  out.push(`buyer sign in buttons: ${copy.BUYER_SIGNIN_SUBMIT} | ${copy.BUYER_SIGNIN_BUSY}`);
  out.push(`buyer sign in links: ${copy.BUYER_SIGNIN_FORGOT} | ${copy.BUYER_SIGNIN_CREATE}`);
  out.push(`buyer sign in errors: ${copy.BUYER_SIGNIN_ERROR_TITLE} | ${copy.BUYER_SIGNIN_FAILED} | ${copy.SIGNIN_TOO_MANY}`);
  out.push(`seller: ${copy.SELLER_TITLE} | ${copy.SELLER_LEDE}`);
  out.push(`seller prepare: ${copy.SELLER_PREPARE_TITLE}`);
  for (const i of copy.SELLER_PREPARE_ITEMS) out.push(`seller prepare item: ${i}`);
  out.push(`seller terms: ${copy.SELLER_TERMS_LINK}`);
  out.push(`seller how: ${copy.SELLER_HOW_TITLE} | ${copy.SELLER_HOW}`);
  out.push(`seller buttons: ${copy.SELLER_APPLY} | ${copy.SELLER_STATUS} | ${copy.SELLER_SIGN_IN}`);
  out.push(`seller sign in: ${copy.SELLER_SIGNIN_TITLE} | ${copy.SELLER_SIGNIN_LEDE}`);
  out.push(`seller sign in fields: ${copy.SELLER_SIGNIN_PUBLISHER} | ${copy.SELLER_SIGNIN_APPLY_LEAD} | ${copy.SELLER_SIGNIN_APPLY_LINK}`);
  out.push(`operator sign in: ${copy.OPERATOR_SIGNIN_TITLE} | ${copy.OPERATOR_SIGNIN_LEDE}`);
  out.push(`operator fields: ${copy.OPERATOR_NAME_LABEL} | ${copy.OPERATOR_PASSCODE_LABEL} | ${copy.OPERATOR_CODE_LABEL}`);
  out.push(`operator code hint: ${copy.OPERATOR_CODE_HINT}`);
  out.push(`operator failed: ${copy.OPERATOR_SIGNIN_FAILED}`);
  out.push(`signin roles: ${copy.SIGNIN_ROLES_TITLE}`);
  for (const l of copy.SIGNIN_ROLE_LINKS) out.push(`signin role ${l.id}: ${l.label} -> ${l.href}`);
  out.push(`signin testers: ${copy.SIGNIN_TESTERS_TITLE}`);
  out.push(`account nav: ${copy.ACCOUNT_NAV_LABEL}`);
  out.push(`account: ${copy.ACCOUNT_TITLE} | ${copy.ACCOUNT_SIGNED_IN_AS} | ${copy.ACCOUNT_USERNAME_LABEL} | ${copy.ACCOUNT_COUNTRY_LABEL}`);
  out.push(`account persona: ${copy.ACCOUNT_NO_PASSWORD}`);
  out.push(`account password: ${copy.ACCOUNT_PASSWORD_TITLE}`);
  out.push(`account fields: ${copy.ACCOUNT_FIELD_CURRENT} | ${copy.ACCOUNT_FIELD_NEW} | ${copy.ACCOUNT_FIELD_REPEAT}`);
  out.push(`account buttons: ${copy.ACCOUNT_CHANGE} | ${copy.ACCOUNT_CHANGE_BUSY}`);
  out.push(`account changed: ${copy.ACCOUNT_CHANGED}`);
  out.push(`account error title: ${copy.ACCOUNT_ERROR_TITLE}`);
  for (const c of ['wrong_password', 'csrf', 'unauthenticated', 'rate_limited', 'invalid_input', 'other'])
    out.push(`account error ${c}: ${copy.accountPasswordErrorText(c)}`);
  out.push(`account error weak_password: ${copy.accountPasswordErrorText('weak_password', 'too_short')}`);
  out.push(`account all: ${copy.ACCOUNT_ALL_TITLE} | ${copy.ACCOUNT_ALL_LEDE} | ${copy.ACCOUNT_ALL_BUTTON} | ${copy.ACCOUNT_ALL_BUSY} | ${copy.ACCOUNT_ALL_FAILED}`);
  out.push(`help password: ${copy.HELP_PASSWORD_TITLE} | ${copy.HELP_PASSWORD_LEDE}`);
  for (const s of copy.HELP_PASSWORD_STEPS) out.push(`help password step: ${s}`);
  out.push(`help password back: ${copy.HELP_PASSWORD_BACK}`);
  return out;
}

describe('account copy (golden)', () => {
  it('matches the reviewed file line by line', () => {
    expect(lines().join('\n') + '\n').toBe(golden);
  });

  it('has the three doors the owner asked for, in order, each with one sentence and one button', () => {
    expect(copy.DOORS.map((d) => [d.label, d.tag])).toEqual([
      ['Buyer', 'I want to read'],
      ['Seller', 'I want to publish'],
      ['Operator', 'I run the platform'],
    ]);
    expect(copy.DOORS.map((d) => d.home_button)).toEqual([
      'Go to your library',
      'Go to your publisher pages',
      'Go to operations',
    ]);
    for (const d of copy.DOORS) expect(d.line.match(/\./g)?.length ?? 0, d.line).toBeLessThanOrEqual(2);
  });

  it('keeps the signed in button names apart from the header link "My library"', () => {
    // Playwright matches a link name as a case insensitive substring; the existing end to end tests look for
    // the header link "My library" on the page a sign in lands on, so no door may contain those words.
    for (const d of copy.DOORS) expect(d.home_button.toLowerCase()).not.toContain('my library');
  });

  it('has one failure message for every refused sign in, with no word that names the cause', () => {
    expect(copy.BUYER_SIGNIN_FAILED).toBe('That username or password did not work.');
    expect(copy.BUYER_SIGNIN_FAILED).not.toMatch(/locked|unknown|exist|wrong|no such/i);
  });

  it('says the username is taken in the one place a name shows, and nowhere else', () => {
    expect(copy.signupErrorText('taken')).toBe('That username is taken.');
    for (const l of lines().filter((x) => !x.startsWith('signup error taken')))
      expect(l, l).not.toContain('That username is taken');
  });

  it('says plainly that no email is asked for or sent, and that a lost password is reset by the operator', () => {
    expect(copy.BUYER_NO_EMAIL).toContain('We do not ask for an email address');
    expect(copy.SIGNUP_LEDE).toContain('No email is asked for or sent.');
    expect(copy.BUYER_LOST).toContain('The operator resets it by hand.');
    expect(copy.BUYER_LOST).toContain('unitmarket@raviprolu.com');
    expect(copy.SELLER_HOW).toContain('This demo sends no email');
    expect(copy.HELP_PASSWORD_LEDE).toContain('no email');
  });

  it('uses the contact address the legal pages give', () => {
    const legal = readFileSync(new URL('./lib/legal-copy.ts', import.meta.url), 'utf8');
    expect(legal).toContain(copy.CONTACT_ADDRESS);
  });

  it('makes no promise to contact anyone and types no environment word', () => {
    for (const line of lines()) {
      expect(line, line).not.toMatch(/will (contact|call|email|write)/i);
      expect(line, line).not.toMatch(/\bsandbox\b|\bdry run\b/i);
    }
  });

  it('follows D-051: no dashes, no italics marks, no emoji', () => {
    for (const line of lines()) {
      expect(line.replace(/ -> /g, ' to '), line).not.toMatch(/[‒-―−]| - |--/);
      expect(line, line).not.toMatch(/\*\w|(^|\s)_\w|\p{Extended_Pictographic}/u);
    }
  });
});
