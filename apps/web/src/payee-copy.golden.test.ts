// PUB-A2 golden: every string the payee page (S6) and the operator payee page show. Static lines come
// from lib/payee-copy.ts; the variable lines are pinned for each state. The reviewed file is
// golden/payee-copy.golden.txt. D-051: no italics, no dashes. The environment word is passed in (it
// comes from the stored environment); it is never typed in the copy file.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import * as copy from './lib/payee-copy';

const golden = readFileSync(new URL('./golden/payee-copy.golden.txt', import.meta.url), 'utf8');

function lines(): string[] {
  const out: string[] = [];
  out.push(`heading: ${copy.PAYEE_HEADING}`);
  out.push(`lede: ${copy.PAYEE_LEDE}`);
  out.push(
    `labels: ${copy.LABEL_ACCOUNT} | ${copy.LABEL_VERIFIED} | ${copy.LABEL_VERIFIED_BY} | ${copy.LABEL_SETTLEMENT}`,
  );
  out.push(`verified by: ${copy.VERIFIED_BY}`);
  out.push(`marked checked: ${copy.MARKED_CHECKED}`);
  out.push(`account none: ${copy.accountText(null)}`);
  out.push(`account set: ${copy.accountText('AB12')}`);
  out.push(`verified none: ${copy.verifiedAtText(null)}`);
  out.push(`verified at: ${copy.verifiedAtText('WHEN')}`);
  out.push(`settlement none: ${copy.settlementText({ last4: null, verified_at: null }, 'WORD')}`);
  out.push(
    `settlement waiting: ${copy.settlementText({ last4: 'AB12', verified_at: null }, 'WORD')}`,
  );
  out.push(
    `settlement verified: ${copy.settlementText({ last4: 'AB12', verified_at: 'x' }, 'Dry run')}`,
  );
  out.push(
    `settlement verified sandbox: ${copy.settlementText({ last4: 'AB12', verified_at: 'x' }, 'Sandbox')}`,
  );
  out.push(`owner only: ${copy.OWNER_ONLY_NOTE}`);
  out.push(`request heading: ${copy.REQUEST_HEADING}`);
  out.push(`request lede: ${copy.REQUEST_LEDE}`);
  out.push(`field merchant: ${copy.FIELD_MERCHANT} | ${copy.FIELD_MERCHANT_HINT}`);
  out.push(`field note: ${copy.FIELD_NOTE}`);
  out.push(`submit: ${copy.REQUEST_SUBMIT}`);
  out.push(`sent: ${copy.REQUEST_SENT}`);
  out.push(`history heading: ${copy.HISTORY_HEADING}`);
  out.push(`history empty: ${copy.HISTORY_EMPTY}`);
  for (const s of ['open', 'verified', 'rejected'] as const)
    out.push(`state ${s}: ${copy.requestStateText(s)}`);
  out.push(`history line: ${copy.historyLine({ requested_last4: 'AB12', state: 'open' })}`);
  for (const c of [
    'invalid_merchant_id',
    'same_as_current',
    'invalid_input',
    'rate_limited',
    'forbidden',
    'unknown',
  ])
    out.push(`request error ${c}: ${copy.requestErrorText(c)}`);
  out.push(`ops heading: ${copy.OPS_HEADING}`);
  out.push(`ops lede: ${copy.OPS_LEDE}`);
  out.push(`ops mfa: ${copy.OPS_MFA_HEADING} | ${copy.OPS_MFA_BODY} | ${copy.OPS_MFA_LINK}`);
  out.push(`ops empty: ${copy.OPS_EMPTY}`);
  out.push(
    `ops columns: ${copy.OPS_COL_PUBLISHER} | ${copy.OPS_COL_REQUESTED} | ${copy.OPS_COL_AGE}`,
  );
  out.push(`ops fields: ${copy.OPS_FIELD_RETYPE} | ${copy.OPS_FIELD_REASON}`);
  out.push(`ops buttons: ${copy.OPS_VERIFY} | ${copy.OPS_REJECT}`);
  out.push(`ops done verified: ${copy.OPS_DONE_VERIFIED}`);
  out.push(`ops done rejected: ${copy.OPS_DONE_REJECTED}`);
  for (const ms of [0, 59_000, 60_000, 3_599_000, 3_600_000, 86_399_000, 86_400_000, 172_800_000])
    out.push(`age ${String(ms)}: ${copy.ageText(ms)}`);
  for (const c of [
    'owner_command_required',
    'id_mismatch',
    'already_decided',
    'merchant_in_use',
    'not_found',
    'mfa_required',
    'invalid_input',
    'rate_limited',
    'unknown',
  ])
    out.push(`ops error ${c}: ${copy.opsErrorText(c)}`);
  return out;
}

describe('payee copy', () => {
  it('matches the reviewed golden file', () => {
    expect(lines().join('\n') + '\n').toBe(golden);
  });

  it('has no dash characters, no italics markup and no typed environment word', () => {
    const text = lines().join('\n');
    expect(text).not.toMatch(/[‐-―−]/);
    expect(text).not.toMatch(/<i>|<em>|\*[a-z]/i);
    const src = readFileSync(new URL('./lib/payee-copy.ts', import.meta.url), 'utf8');
    expect(src).not.toMatch(/Sandbox|Dry run|dryrun/);
  });

  it('never contains a merchant id shape in a static line', () => {
    for (const [k, v] of Object.entries(copy)) {
      if (typeof v === 'string') expect(v, k).not.toMatch(/\b[A-Z0-9]{13}\b/);
    }
  });
});
