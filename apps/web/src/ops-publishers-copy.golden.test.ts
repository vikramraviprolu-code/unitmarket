// PUB-D golden: every string the operator's publishers page (S7) and the two operator links show. Static
// lines come from lib/ops-publishers-copy.ts; the variable lines are pinned for each state. The reviewed
// file is golden/ops-publishers-copy.golden.txt. D-051: no italics, no dashes. The environment word is
// never typed in the copy file: the page takes it from the stored environment.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import * as copy from './lib/ops-publishers-copy';

const golden = readFileSync(
  new URL('./golden/ops-publishers-copy.golden.txt', import.meta.url),
  'utf8',
);

function lines(): string[] {
  const out: string[] = [];
  out.push(`links: ${copy.OPS_LINK_PUBLISHERS} | ${copy.OPS_LINK_PAYEE_REQUESTS}`);
  out.push(`heading: ${copy.PUBLISHERS_HEADING}`);
  out.push(`lede: ${copy.PUBLISHERS_LEDE}`);
  out.push(`empty: ${copy.PUBLISHERS_EMPTY}`);
  out.push(`back: ${copy.PUBLISHERS_BACK_LINK}`);
  out.push(
    `labels: ${copy.LABEL_STATUS} | ${copy.LABEL_PAYEE} | ${copy.LABEL_SETTLEMENT} | ${copy.LABEL_OFFERS} | ${copy.LABEL_MONEY}`,
  );
  for (const s of ['applied', 'active', 'suspended'] as const)
    out.push(`status ${s}: ${copy.statusText(s)}`);
  out.push(`payee none: ${copy.payeeText({ last4: null, verified: false, shared: false })}`);
  out.push(`payee waiting: ${copy.payeeText({ last4: 'AB12', verified: false, shared: false })}`);
  out.push(`payee checked: ${copy.payeeText({ last4: 'AB12', verified: true, shared: false })}`);
  out.push(`payee shared: ${copy.payeeText({ last4: 'AB12', verified: true, shared: true })}`);
  for (const n of [0, 1, 2, 7]) out.push(`offers ${String(n)}: ${copy.offersText(n)}`);
  out.push(`no payments: ${copy.NO_PAYMENTS}`);
  out.push(
    `columns: ${copy.COL_CURRENCY} | ${copy.COL_CAPTURED} | ${copy.COL_NOT_REFUNDED} | ${copy.COL_REFUNDS_OPEN} | ${copy.COL_HELD}`,
  );
  out.push(`none cell: ${copy.NONE_CELL}`);
  out.push(`count amount: ${copy.countAmountText(3, '$4.50')}`);
  out.push(`count amount one: ${copy.countAmountText(1, '$0.40')}`);
  out.push(`units: ${copy.unitsText(1)} | ${copy.unitsText(4)}`);
  out.push(`suspend: ${copy.SUSPEND_BUTTON} | ${copy.REACTIVATE_BUTTON}`);
  out.push(`suspend hint: ${copy.SUSPEND_HINT}`);
  out.push(`reactivate hint: ${copy.REACTIVATE_HINT}`);
  out.push(`applicant hint: ${copy.APPLIED_HINT}`);
  out.push(`field reason: ${copy.FIELD_REASON}`);
  out.push(`done: ${copy.DONE_SUSPENDED} | ${copy.DONE_REACTIVATED}`);
  for (const c of [
    'unchanged',
    'not_allowed',
    'not_found',
    'mfa_required',
    'invalid_input',
    'rate_limited',
    'unknown',
  ])
    out.push(`error ${c}: ${copy.statusErrorText(c)}`);
  return out;
}

describe('ops publishers copy', () => {
  it('matches the reviewed golden file', () => {
    expect(lines().join('\n') + '\n').toBe(golden);
  });

  it('has no dash characters, no italics markup and no typed environment word', () => {
    const text = lines().join('\n');
    expect(text).not.toMatch(/[‐-―−]/);
    expect(text).not.toMatch(/<i>|<em>|\*[a-z]/i);
    const src = readFileSync(new URL('./lib/ops-publishers-copy.ts', import.meta.url), 'utf8');
    expect(src).not.toMatch(/Sandbox|Dry run|dryrun/);
  });

  it('never contains a merchant id shape in a static line', () => {
    for (const [k, v] of Object.entries(copy)) {
      if (typeof v === 'string') expect(v, k).not.toMatch(/\b[A-Z0-9]{13}\b/);
    }
  });
});
