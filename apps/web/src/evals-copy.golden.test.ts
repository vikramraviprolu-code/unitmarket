// AI-B golden: every string the operator evals page shows. Static lines come from lib/evals-copy.ts;
// the variable lines are pinned for each state. The reviewed file is golden/evals-copy.golden.txt.
// Wording rules: D-051, no italics, no dashes; the environment word comes from stored data.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import * as copy from './lib/evals-copy';

const golden = readFileSync(new URL('./golden/evals-copy.golden.txt', import.meta.url), 'utf8');

function lines(): string[] {
  const out: string[] = [];
  out.push(`heading: ${copy.EVALS_HEADING}`);
  out.push(`lede: ${copy.EVALS_LEDE}`);
  out.push(`back: ${copy.EVALS_BACK_LINK}`);
  out.push(`ops link: ${copy.EVALS_OPS_LINK}`);
  out.push(`what heading: ${copy.EVALS_WHAT_HEADING}`);
  for (const p of copy.EVALS_WHAT) out.push(`what: ${p}`);
  out.push(`cases: ${copy.casesLine(52, 32, 20)}`);
  out.push(`cases one each: ${copy.casesLine(2, 1, 1)}`);
  out.push(`baseline: ${copy.baselineLine({ passed: 52, total: 52 })}`);
  out.push(`baseline some: ${copy.baselineLine({ passed: 50, total: 52 })}`);
  out.push(`claude not run: ${copy.claudeLine({ state: 'not_run' }, 52)}`);
  out.push(`claude not run note: ${copy.CLAUDE_NOT_RUN_NOTE}`);
  out.push(
    `claude recorded: ${copy.claudeLine({ state: 'recorded', recorded_on: '2026-11-01', passed: 50, total: 52 }, 52)}`,
  );
  out.push(
    `claude recorded other size: ${copy.claudeLine({ state: 'recorded', recorded_on: '2026-11-01', passed: 40, total: 44 }, 52)}`,
  );
  out.push(`model scripted: ${copy.modelInUseLine('scripted')}`);
  out.push(`model claude: ${copy.modelInUseLine('claude')}`);
  out.push(`model note: ${copy.MODEL_NOTE}`);
  out.push(`table heading: ${copy.EVALS_TABLE_HEADING}`);
  out.push(
    `columns: ${copy.COL_CASE} | ${copy.COL_KIND} | ${copy.COL_BASELINE} | ${copy.COL_CLAUDE}`,
  );
  out.push(`kind listing: ${copy.kindText('listing')}`);
  out.push(`kind brief: ${copy.kindText('brief')}`);
  out.push(`verdict pass: ${copy.verdictText({ pass: true, failed: [] })}`);
  for (const c of copy.CHECK_CODES)
    out.push(`verdict fail ${c}: ${copy.verdictText({ pass: false, failed: [c] })}`);
  out.push(`claude cell: ${copy.CLAUDE_CELL_NOT_RUN} | ${copy.CLAUDE_CELL_COUNTS_ONLY}`);
  return out;
}

describe('evals copy', () => {
  it('matches the reviewed golden file', () => {
    expect(lines().join('\n') + '\n').toBe(golden);
  });
  it('has no dash characters, no italics markup, no percent sign and no hard coded environment word', () => {
    const text = lines()
      .map((l) => l.slice(l.indexOf(': ') + 2))
      .join('\n');
    expect(text).not.toMatch(/[‐-―−-]/);
    expect(text).not.toMatch(/<i>|<em>|\*[^*\s][^*]*\*/);
    expect(text).not.toMatch(/%/);
    expect(text).not.toMatch(/sandbox|dry.?run/i);
  });
  it('says the real model is off unless the adapter setting names it, and never claims a Claude figure it has not got', () => {
    expect(copy.MODEL_NOTE).toContain('UMS_AI_ADAPTER=claude');
    expect(copy.claudeLine({ state: 'not_run' }, 52)).not.toMatch(/\d+ of \d+/);
  });
});
