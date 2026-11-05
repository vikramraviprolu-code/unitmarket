// BR-6 golden: every string the operator "Business rules" pages show. Static lines come from
// lib/ops-rules-copy.ts; the variable lines are pinned for each case. The reviewed file is
// golden/ops-rules-copy.golden.txt. D-051: no italics, no dashes. The environment word is never typed in the
// copy file: the pages take it from the stored environment.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import * as copy from './lib/ops-rules-copy';

const golden = readFileSync(new URL('./golden/ops-rules-copy.golden.txt', import.meta.url), 'utf8');

function lines(): string[] {
  const out: string[] = [];
  out.push(`title: ${copy.RULES_TITLE}`);
  out.push(`lede: ${copy.RULES_LEDE}`);
  out.push(
    `links: ${copy.RULES_NEW_LINK} | ${copy.RULES_HISTORY_LINK} | ${copy.RULES_EXPLAIN_LINK} | ${copy.RULES_EXPORT_BUTTON} | ${copy.RULES_BACK_LINK}`,
  );
  for (const k of ['refund.request_window', 'access.window', 'mandate.max_days'] as const)
    out.push(`rule ${k}: ${copy.RULE_LABEL[k]} | ${copy.RULE_HINT[k]}`);
  for (const s of ['platform', 'category', 'seller', 'buyer'] as const)
    out.push(`scope ${s}: ${copy.SCOPE_LABEL[s]}`);
  out.push(`days: ${copy.daysText(0)} | ${copy.daysText(1)} | ${copy.daysText(30)}`);
  out.push(`range: ${copy.rangeText(0, 30)} | ${copy.rangeText(1, 90)}`);
  out.push(
    `columns: ${copy.COL_RULE} | ${copy.COL_NOW} | ${copy.COL_RANGE} | ${copy.COL_APPLIES} | ${copy.COL_SELLERS} | ${copy.COL_BUYERS} | ${copy.COL_LAST}`,
  );
  out.push(`default: ${copy.SOURCE_DEFAULT_NOTE}`);
  out.push(`no change: ${copy.NO_CHANGE_YET}`);
  out.push(
    `last change: ${copy.lastChangeText('2026-11-05T12:00:00.000Z', 'opr_vikram', 'Pilot window')}`,
  );
  out.push(
    `last change hidden: ${copy.lastChangeText('2026-11-05T12:00:00.000Z', null, 'Pilot window')}`,
  );
  out.push(`impact: ${copy.impactLine('2026-11-05T12:00:00.000Z')}`);
  out.push(`impact blank: ${copy.impactLine(null)}`);
  out.push(`mfa: ${copy.MFA_NOTICE}`);
  out.push(
    `form: ${copy.FORM_HEADING} | ${copy.FIELD_RULE} | ${copy.FIELD_SCOPE} | ${copy.FIELD_SCOPE_ID} | ${copy.FIELD_VALUE} | ${copy.FIELD_FROM} | ${copy.FIELD_UNTIL} | ${copy.FIELD_REASON} | ${copy.SUBMIT_LABEL}`,
  );
  out.push(`form hints: ${copy.HINT_SCOPE_ID} | ${copy.HINT_UNTIL} | ${copy.HINT_REASON}`);
  out.push(`saved: ${copy.SAVED_LINE}`);
  out.push(
    `history: ${copy.HISTORY_HEADING} | ${copy.HISTORY_EMPTY} | ${copy.HISTORY_CAPPED} | ${copy.INVALID_FILTER}`,
  );
  out.push(
    `history columns: ${copy.COL_SET} | ${copy.COL_KEY} | ${copy.COL_SCOPE} | ${copy.COL_VALUE} | ${copy.COL_FROM} | ${copy.COL_UNTIL} | ${copy.COL_BY} | ${copy.COL_WHY}`,
  );
  out.push(
    `filters: ${copy.FILTER_KEY} | ${copy.FILTER_SCOPE} | ${copy.FILTER_OPERATOR} | ${copy.FILTER_APPLY} | ${copy.FILTER_CLEAR}`,
  );
  out.push(`until open: ${copy.UNTIL_OPEN}`);
  out.push(`hidden operator: ${copy.OPERATOR_HIDDEN}`);
  out.push(
    `explain: ${copy.EXPLAIN_HEADING} | ${copy.EXPLAIN_BLANK} | ${copy.EXPLAIN_FIELD} | ${copy.EXPLAIN_BUTTON}`,
  );
  out.push(`explain old: ${copy.OLD_ORDER_LINE}`);
  out.push(`explain columns: ${copy.COL_TERM} | ${copy.COL_VALUE} | ${copy.COL_SOURCE}`);
  out.push(`explain facts: ${copy.RULES_VERSION_LABEL} | ${copy.DIGEST_LABEL}`);
  for (const s of [
    'default',
    'linked:refund.request_window',
    'platform:rls_1',
    'seller:pub_1@rls_2',
    'buyer:buy_1@rls_3',
    'category:cat_1@rls_4',
    'agreement:agr_1@rls_5',
    'surprise',
  ])
    out.push(`source ${s}: ${copy.sourceText(s)}`);
  return out;
}

describe('ops rules copy', () => {
  it('matches the reviewed golden file', () => {
    expect(lines().join('\n') + '\n').toBe(golden);
  });

  it('has no dash characters, no italics markup and no typed environment word', () => {
    const text = lines().join('\n');
    expect(text).not.toMatch(/[‐-―−]/);
    expect(text).not.toMatch(/<i>|<em>|\*[a-z]/i);
    const src = readFileSync(new URL('./lib/ops-rules-copy.ts', import.meta.url), 'utf8');
    expect(src).not.toMatch(/Sandbox|Dry run|dryrun/);
  });

  it('the impact line always says that sales already approved keep their terms', () => {
    for (const from of ['2026-11-05T12:00:00.000Z', '2027-01-01T00:00:00.000Z', null])
      expect(copy.impactLine(from)).toMatch(/Sales already approved keep their terms\.$/);
  });
});
