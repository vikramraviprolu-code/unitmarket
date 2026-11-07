// POB-P1 golden: every string of the publisher account screens, pinned in golden/publisher-accounts-copy.golden.txt.
// D-051: no italics, no dashes. Also pins the sentence the link route answers with when no account is claimed.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import * as copy from './lib/publisher-accounts-copy';
import * as agreement from './lib/agreement-copy';
import * as applicants from './lib/ops-applicants-copy';
import * as apply from './lib/apply-copy';

const golden = readFileSync(
  new URL('./golden/publisher-accounts-copy.golden.txt', import.meta.url),
  'utf8',
);

function lines(): string[] {
  const out: string[] = [];
  const push = (k: string, v: string) => out.push(`${k}: ${v}`);
  for (const k of [
    'CLAIM_TITLE',
    'CLAIM_LEDE',
    'CLAIM_FIELD_CODE',
    'CLAIM_HINT_CODE',
    'CLAIM_FIELD_USERNAME',
    'CLAIM_HINT_USERNAME',
    'CLAIM_FIELD_PASSWORD',
    'CLAIM_HINT_PASSWORD',
    'CLAIM_SUBMIT',
    'CLAIM_BUSY',
    'CLAIM_ERROR_TITLE',
    'CLAIM_HAVE_ACCOUNT',
    'CLAIM_SIGN_IN_LINK',
    'ACCOUNT_SIGNIN_HEADING',
    'ACCOUNT_SIGNIN_LEDE',
    'ACCOUNT_SIGNIN_USERNAME',
    'ACCOUNT_SIGNIN_PASSWORD',
    'ACCOUNT_SIGNIN_SUBMIT',
    'ACCOUNT_SIGNIN_BUSY',
    'ACCOUNT_SIGNIN_FAILED',
    'ACCOUNT_SIGNIN_CLAIM_LEAD',
    'ACCOUNT_SIGNIN_CLAIM_LINK',
    'DEMO_SIGNIN_HEADING',
    'TERMS_ACCEPT_HEADING',
    'TERMS_ACCEPT_LEAD',
    'TERMS_ACCEPT_BUTTON',
    'TERMS_ACCEPT_BUSY',
    'TERMS_ACCEPT_DONE',
    'TERMS_CHANGED_LEAD',
    'LINK_HEADING',
    'LINK_LEDE',
    'LINK_NO_ACCOUNT',
    'LINK_NONE',
    'LINK_FIELD_EMAIL',
    'LINK_HINT_EMAIL',
    'LINK_SUBMIT',
    'LINK_SENT',
    'LINK_STATE_REQUESTED',
    'LINK_STATE_VERIFIED',
    'LINK_STATE_SYNTHETIC',
    'ACCESS_HEADING',
    'ACCESS_LEDE',
    'ACCESS_EMPTY',
    'ACCESS_DEMO_NOTE',
    'ACCESS_ISSUE_BUTTON',
    'ACCESS_REPLACE_BUTTON',
    'ACCESS_RESET_BUTTON',
    'ACCESS_ISSUE_HINT',
    'ACCESS_RESET_HINT',
    'INVITE_SHOWN_HEADING',
    'INVITE_SHOWN_WARNING',
    'INVITE_COPIED_BUTTON',
    'LINKS_HEADING',
    'LINKS_LEDE',
    'LINKS_EMPTY',
    'LINKS_FIELD_RETYPE',
    'LINKS_FIELD_REASON',
    'LINKS_VERIFY',
    'LINKS_DONE',
  ] as const)
    push(k, (copy as unknown as Record<string, string>)[k]!);
  push(
    'terms accepted',
    copy.termsAcceptedText({
      accepted_at: '2026-11-05T10:00:00.000Z',
      terms_version: 'v1',
      accepted_by_label: 'new.owner',
    }),
  );
  push('link line requested', copy.linkLine('seller@example.com', 'requested'));
  push('link line verified', copy.linkLine('seller@example.com', 'verified'));
  push('link line synthetic', copy.linkLine('demo-harbour-ledger@payee.invalid', 'verified', true));
  push('access account none', copy.accessAccountText(null));
  push('access account claimed', copy.accessAccountText('new.owner'));
  for (const s of ['none', 'live', 'expired', 'used'] as const)
    push(`access invite ${s}`, copy.accessInviteText(s, '2026-11-12T10:00:00.000Z'));
  push('access terms none', copy.accessTermsText(null));
  push(
    'access terms accepted',
    copy.accessTermsText({ version: 'v1', method: 'publisher_accepted' }),
  );
  push('access terms demo', copy.accessTermsText({ version: 'v1', method: 'seeded_demo' }));
  push('access link none', copy.accessLinkText(null));
  push(
    'access link requested',
    copy.accessLinkText({ state: 'requested', masked_email: 's***@example.com' }),
  );
  push(
    'access link verified',
    copy.accessLinkText({ state: 'verified', masked_email: 's***@example.com' }),
  );
  push(
    'access link synthetic',
    copy.accessLinkText({ state: 'verified', masked_email: 'd***@payee.invalid', synthetic: true }),
  );
  push('access reason label', copy.accessReasonLabel('Web Pub 1'));
  push('invite expires', copy.inviteExpiresText('2026-11-12T10:00:00.000Z'));
  push('invite groups', copy.inviteGroups('ABCDEFGHJKMN'));
  for (const c of [
    'invalid_code',
    'taken',
    'invalid_input',
    'rate_limited',
    'busy',
    'csrf',
    'unknown',
  ])
    push(`claim error ${c}`, copy.claimErrorText(c));
  push('claim error weak', copy.claimErrorText('weak_password', 'too_short'));
  for (const c of ['no_account', 'already_accepted', 'csrf', 'unknown'])
    push(`terms error ${c}`, copy.termsErrorText(c));
  for (const c of [
    'no_account',
    'invalid_email',
    'same_as_current',
    'rate_limited',
    'forbidden',
    'unknown',
  ])
    push(`link error ${c}`, copy.linkErrorText(c));
  for (const c of [
    'has_account',
    'no_account',
    'not_allowed',
    'not_found',
    'mfa_required',
    'invalid_input',
    'rate_limited',
    'unknown',
  ])
    push(`access error ${c}`, copy.accessErrorText(c));
  for (const c of [
    'email_mismatch',
    'already_verified',
    'email_in_use',
    'not_found',
    'mfa_required',
    'invalid_input',
    'rate_limited',
    'unknown',
  ])
    push(`link decision error ${c}`, copy.linkDecisionErrorText(c));
  // The lines that used to say an approved applicant cannot sign in, as they read now.
  push('applicants no login', applicants.APPLICANTS_NO_LOGIN);
  push('applicants lede', applicants.APPLICANTS_LEDE);
  push('approve hint', applicants.APPROVE_HINT);
  push('reject hint', applicants.REJECT_HINT);
  push('done approved', applicants.DONE_APPROVED);
  push('apply confirm next', apply.CONFIRM_NEXT);
  push('apply status approved', apply.statusText('approved'));
  // The agreement sentence of a click through record.
  push(
    'agreement accepted by publisher',
    agreement.agreementText({
      accepted_at: '2026-11-05T10:00:00.000Z',
      terms_version: 'v1',
      method: 'publisher_accepted',
    }),
  );
  return out;
}

describe('publisher accounts copy', () => {
  it('matches the reviewed golden file', () => {
    expect(lines().join('\n') + '\n').toBe(golden);
  });

  it('has no dash characters, no hyphen between words, no italics markup and no typed environment word', () => {
    const text = lines().join('\n');
    expect(text).not.toMatch(/[‐-―−]/);
    expect(text).not.toMatch(/\w - \w/);
    expect(text).not.toMatch(/<i>|<em>|\*[a-z]/i);
    const src = readFileSync(new URL('./lib/publisher-accounts-copy.ts', import.meta.url), 'utf8');
    expect(src).not.toMatch(/Sandbox|Dry run|dryrun/);
  });

  it('POB-DEMOLINK: a real operator check reads "Checked by an operator.", a synthetic demo address never does', () => {
    expect(copy.linkLine('seller@example.com', 'verified')).toContain('Checked by an operator.');
    expect(copy.linkLine('seller@example.com', 'verified', false)).toContain(
      'Checked by an operator.',
    );
    const synthetic = copy.linkLine('demo-x@payee.invalid', 'verified', true);
    expect(synthetic).not.toContain('Checked by an operator');
    expect(synthetic).toContain('Demo address. Not a real PayPal account.');
    const real = { state: 'verified', masked_email: 's***@example.com' } as const;
    expect(copy.accessLinkText(real)).toContain('Checked by an operator.');
    const demo = copy.accessLinkText({ ...real, synthetic: true });
    expect(demo).not.toContain('Checked by an operator');
    expect(demo).toContain('Demo address. Not a real PayPal account.');
    // a link still waiting for a check says so, whatever the address
    expect(copy.linkLine('x@payee.invalid', 'requested', true)).toContain(
      'Waiting for an operator',
    );
  });

  it('pins the sentence for a publisher with no claimed account', () => {
    expect(copy.LINK_NO_ACCOUNT).toBe(
      'Only a publisher who claimed an account can link an address.',
    );
    expect(copy.linkErrorText('no_account')).toBe(copy.LINK_NO_ACCOUNT);
  });

  it('says plainly that UnitMarket pays out to the publisher and never creates a PayPal account', () => {
    expect(copy.LINK_LEDE).toMatch(/pays out to the PayPal Business account you already have/);
    expect(copy.LINK_LEDE).toMatch(/never creates a PayPal account/);
  });

  it('no longer says an approved applicant cannot sign in', () => {
    for (const s of [
      applicants.APPLICANTS_NO_LOGIN,
      applicants.APPLICANTS_LEDE,
      applicants.APPROVE_HINT,
      applicants.DONE_APPROVED,
      apply.CONFIRM_NEXT,
      apply.statusText('approved'),
    ]) {
      expect(s).not.toMatch(/cannot sign in/);
      expect(s).not.toMatch(/add a persona/);
    }
    expect(applicants.APPLICANTS_NO_LOGIN).toMatch(/invite code/);
    expect(applicants.APPROVE_HINT).toMatch(/invite code/);
  });

  it('a click through record does not call itself a demo record', () => {
    const t = agreement.agreementText({
      accepted_at: '2026-11-05T10:00:00.000Z',
      terms_version: 'v1',
      method: 'publisher_accepted',
    });
    expect(t).not.toMatch(/demo/);
    expect(t).toMatch(/version v1/);
  });
});
