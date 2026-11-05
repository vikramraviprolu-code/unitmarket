// PUB-APPLY golden: every string the public Apply to publish screens show, plus the two operator lines and the
// two links. Static lines come from lib/apply-copy.ts; variable lines are pinned for each state. The reviewed
// file is golden/apply-copy.golden.txt. D-051: no italics, no dashes, no emoji. The page must say plainly that
// applying creates no account and that nothing is paid or published until the operator has reviewed it.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import * as copy from './lib/apply-copy';

const golden = readFileSync(new URL('./golden/apply-copy.golden.txt', import.meta.url), 'utf8');

function lines(): string[] {
  const out: string[] = [];
  out.push(`title: ${copy.APPLY_TITLE}`);
  out.push(`lede: ${copy.APPLY_LEDE}`);
  out.push(`no account: ${copy.APPLY_NO_ACCOUNT}`);
  out.push(`fields: ${copy.FIELD_NAME} | ${copy.FIELD_COUNTRY} | ${copy.FIELD_NOTE}`);
  out.push(`hints: ${copy.HINT_NAME} | ${copy.HINT_NOTE}`);
  out.push(`honeypot: ${copy.HONEYPOT_LABEL}`);
  out.push(`buttons: ${copy.SUBMIT_BUTTON} | ${copy.SUBMIT_BUSY}`);
  out.push(`confirm title: ${copy.CONFIRM_TITLE}`);
  out.push(`confirm body: ${copy.CONFIRM_BODY}`);
  out.push(`confirm reference label: ${copy.CONFIRM_REFERENCE_LABEL}`);
  out.push(`confirm next: ${copy.CONFIRM_NEXT}`);
  out.push(`confirm link: ${copy.CONFIRM_LINK}`);
  out.push(`status title: ${copy.STATUS_TITLE}`);
  out.push(`status lede: ${copy.STATUS_LEDE}`);
  out.push(`status form: ${copy.STATUS_FIELD} | ${copy.STATUS_BUTTON}`);
  out.push(`status no reference: ${copy.STATUS_NO_REF}`);
  out.push(`status back: ${copy.STATUS_BACK}`);
  for (const s of ['pending', 'approved', 'rejected', 'unavailable', 'unknown'] as const)
    out.push(`state ${s}: ${copy.statusText(s)} | tone ${copy.statusTone(s)}`);
  for (const c of ['invalid_input', 'busy', 'rate_limited', 'csrf', 'too_large', 'other'])
    out.push(`error ${c}: ${copy.applyErrorText(c)}`);
  out.push(`links: ${copy.LINK_APPLY} | ${copy.SIGNIN_APPLY_LEAD} | ${copy.TERMS_APPLY_LEAD}`);
  out.push(
    `operator: ${copy.OPS_NOTE_LABEL} | ${copy.OPS_SOURCE_PUBLIC} | ${copy.OPS_SOURCE_OPERATOR}`,
  );
  return out;
}

describe('apply copy (golden)', () => {
  it('matches the reviewed file line by line', () => {
    expect(lines().join('\n') + '\n').toBe(golden);
  });

  it('says plainly that applying creates no account and that nothing is paid or published until review', () => {
    expect(copy.APPLY_NO_ACCOUNT).toBe(
      'Applying creates no account. The operator reviews it. Nothing is paid or published until then.',
    );
  });

  it('makes no promise to contact the applicant and says the operator reviews applications', () => {
    for (const line of lines())
      expect(line, line).not.toMatch(/will contact|we will (call|email|write)/i);
    expect(copy.APPLY_LEDE).toContain('The operator reviews applications.');
  });

  it('says the note is a permanent record and asks for no phone number or personal address', () => {
    expect(copy.HINT_NOTE).toContain(
      'What you write here is kept as a permanent record and cannot be deleted. Do not include a phone number or a personal address. Email addresses are not kept in readable form.',
    );
    expect(copy.HINT_NOTE).toMatch(/one line/i);
  });

  it('warns never to include a password or payment details', () => {
    expect(copy.HINT_NOTE).toMatch(/never include a password or payment details/i);
  });

  it('follows the wording rules: no dashes, no emoji, no italics markers, no placeholder text, no environment word', () => {
    for (const line of lines()) {
      expect(line, line).not.toMatch(/[‒-―−]/);
      expect(line, line).not.toMatch(/ - /);
      expect(line, line).not.toMatch(/\p{Extended_Pictographic}/u);
      expect(line, line).not.toMatch(/TODO|lorem|\*[a-z]/i);
      expect(line, line).not.toMatch(/\b(sandbox|dry-run)\b/i);
    }
  });

  it('shows a plain word for every state, and a neutral line for an unknown reference', () => {
    expect(copy.statusText('pending')).toBe('Waiting for review');
    expect(copy.statusText('approved')).toBe(
      'Approved. An operator will give you an invite code to claim your account.',
    );
    expect(copy.statusText('unavailable')).toBe('Not available');
    expect(copy.statusTone('unavailable')).toBe('neutral');
    expect(copy.statusText('rejected')).toBe('Not approved');
    expect(copy.statusText('unknown')).toBe('We do not have that reference');
    expect(copy.statusTone('unknown')).toBe('neutral');
  });
});
