// PUB-E2 golden: every string the Applicants section of /ops/publishers shows. Static lines come from
// lib/ops-applicants-copy.ts; variable lines are pinned for each state. The reviewed file is
// golden/ops-applicants-copy.golden.txt. D-051: no italics, no dashes. The page must say plainly that an
// approved applicant cannot sign in until the owners add a persona and passcode.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import * as copy from './lib/ops-applicants-copy';

const golden = readFileSync(
  new URL('./golden/ops-applicants-copy.golden.txt', import.meta.url),
  'utf8',
);

function lines(): string[] {
  const out: string[] = [];
  out.push(`heading: ${copy.APPLICANTS_HEADING}`);
  out.push(`lede: ${copy.APPLICANTS_LEDE}`);
  out.push(`no login: ${copy.APPLICANTS_NO_LOGIN}`);
  out.push(`empty: ${copy.APPLICANTS_EMPTY}`);
  out.push(`add heading: ${copy.ADD_HEADING}`);
  out.push(
    `fields: ${copy.FIELD_NAME} | ${copy.FIELD_SLUG} | ${copy.FIELD_COUNTRY} | ${copy.FIELD_NOTE}`,
  );
  out.push(`field reason: ${copy.FIELD_DECISION_REASON}`);
  out.push(`buttons: ${copy.ADD_BUTTON} | ${copy.APPROVE_BUTTON} | ${copy.REJECT_BUTTON}`);
  out.push(`approve hint: ${copy.APPROVE_HINT}`);
  out.push(`reject hint: ${copy.REJECT_HINT}`);
  for (const s of ['pending', 'rejected'] as const)
    out.push(`state ${s}: ${copy.applicantStateText(s)}`);
  out.push(`rejected with reason: ${copy.rejectedReasonText('Not a fit right now')}`);
  out.push(`applicant line: ${copy.applicantLine({ country: 'GB', slug: 'tidewater-review' })}`);
  out.push(`done: ${copy.DONE_ADDED} | ${copy.DONE_APPROVED} | ${copy.DONE_REJECTED}`);
  for (const c of [
    'invalid_slug',
    'slug_taken',
    'already_decided',
    'not_allowed',
    'not_found',
    'mfa_required',
    'invalid_input',
    'rate_limited',
    'unknown',
  ])
    out.push(`error ${c}: ${copy.applicantErrorText(c)}`);
  return out;
}

describe('ops applicants copy', () => {
  it('matches the reviewed golden file', () => {
    expect(lines().join('\n') + '\n').toBe(golden);
  });

  it('says plainly that an approved applicant has no login until the owners add a persona and passcode', () => {
    expect(copy.APPLICANTS_NO_LOGIN).toMatch(/cannot sign in/);
    expect(copy.APPLICANTS_NO_LOGIN).toMatch(/persona/);
    expect(copy.APPLICANTS_NO_LOGIN).toMatch(/passcode/);
    expect(copy.APPLICANTS_NO_LOGIN).toMatch(/owners/);
    expect(copy.APPROVE_HINT).toMatch(/cannot sign in/);
  });

  it('has no dash characters, no hyphen between words, no italics markup and no typed environment word', () => {
    const text = lines().join('\n');
    expect(text).not.toMatch(/[‐-―−]/);
    expect(text).not.toMatch(/\w - \w/);
    expect(text).not.toMatch(/<i>|<em>|\*[a-z]/i);
    const src = readFileSync(new URL('./lib/ops-applicants-copy.ts', import.meta.url), 'utf8');
    expect(src).not.toMatch(/Sandbox|Dry run|dryrun/);
  });

  it('never contains a merchant id shape in a static line', () => {
    for (const [k, v] of Object.entries(copy)) {
      if (typeof v === 'string') expect(v, k).not.toMatch(/\b[A-Z0-9]{13}\b/);
    }
  });
});
