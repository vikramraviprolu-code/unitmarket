// MC2-L7 golden: every word of the reporting block on the operations screen, with the example figures of
// ops-reporting-support.ts rendered for a real rate and for a sample (seed) rate, and for no usable rate.
// The reviewed file is golden/ops-reporting-copy.golden.txt. Wording rules (D-051): no italics, no dashes.
// Ledger A1: a sample rate is never called "rate of" and the bank is never named.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { BOOKED, fakeFx } from './ops-reporting-support';
import * as copy from './lib/ops-reporting-view';
import type { OpsReportingView } from './lib/ops-reporting-view';

const golden = readFileSync(
  new URL('./golden/ops-reporting-copy.golden.txt', import.meta.url),
  'utf8',
);

function viewLines(title: string, v: OpsReportingView): string[] {
  const out = [`-- ${title} --`];
  for (const g of v.groups) {
    out.push(`environment: ${g.environment}`);
    for (const r of g.booked)
      out.push(`booked ${r.label}: ${r.sales} | ${r.refunds} | ${r.exposure}`);
    if (g.reporting === null) out.push(`missing: ${g.missing_note}`);
    else {
      out.push(`rate: ${g.reporting.rate_note}`);
      for (const r of g.reporting.rows)
        out.push(`reporting ${r.label}: ${r.sales} | ${r.refunds} | ${r.exposure}`);
      out.push(`how: ${g.reporting.how_note}`);
    }
  }
  out.push(`empty: ${v.empty}`);
  out.push(`statements: ${v.statements_note}`);
  return out;
}

function lines(): string[] {
  return [
    `heading: ${copy.OPS_REPORTING_HEADING}`,
    `lede: ${copy.OPS_REPORTING_LEDE}`,
    `columns: ${copy.OPS_REPORTING_COLUMNS.sales} | ${copy.OPS_REPORTING_COLUMNS.refunds} | ${copy.OPS_REPORTING_COLUMNS.exposure}`,
    `booked caption: ${copy.OPS_REPORTING_BOOKED_CAPTION}`,
    `view caption: ${copy.OPS_REPORTING_VIEW_CAPTION}`,
    `empty: ${copy.OPS_REPORTING_EMPTY}`,
    `how: ${copy.OPS_REPORTING_HOW_NOTE}`,
    `missing: ${copy.OPS_REPORTING_MISSING_NOTE}`,
    `statements: ${copy.OPS_REPORTING_STATEMENTS_NOTE}`,
    ...viewLines('real rate', copy.opsReportingView(BOOKED, fakeFx('ecb', '2026-11-03'))),
    ...viewLines('sample rate', copy.opsReportingView(BOOKED, fakeFx('seed', '2026-11-03'))),
    ...viewLines('no usable rate', copy.opsReportingView(BOOKED, fakeFx(null))),
    ...viewLines('empty database', copy.opsReportingView([], fakeFx(null))),
  ];
}

describe('ops reporting copy (golden)', () => {
  it('matches the reviewed file', () => {
    expect(lines().join('\n') + '\n').toBe(golden);
  });

  it('has no dash, no italic marker and no tag; the sample rate never names the bank', () => {
    for (const l of lines()) {
      expect(l).not.toMatch(/[—–]/);
      expect(l).not.toMatch(/[*_]{1,2}\S[^*_]*[*_]{1,2}/);
      expect(l).not.toMatch(/<\/?(em|i)\b/i);
      expect(l).not.toMatch(/ecb|central bank|european/i);
    }
    const seedLines = viewLines('s', copy.opsReportingView(BOOKED, fakeFx('seed'))).join('\n');
    expect(seedLines).toContain('sample rate of');
    expect(seedLines).not.toMatch(/(?<!sample )rate of/);
  });
});
