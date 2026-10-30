// PUB-C golden: every string the sales page (S4) and the statement page (S5) show. Page copy comes from
// lib/statement-copy.ts; the money words (status words, settlement sentences, commission line) come
// from the publisher console package (re-exported by composition.server.ts, the one place apps/web
// may reach it) and are pinned here with them. The reviewed file is
// golden/statement-copy.golden.txt. D-051: no italics, no dashes; "Not charged" only for declined.
import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { COMMISSION_LINE, UNIT_STATUS_TEXT, settlementMode } from '../composition.server';
import * as copy from './lib/statement-copy';

vi.mock('server-only', () => ({}));

const golden = readFileSync(new URL('./golden/statement-copy.golden.txt', import.meta.url), 'utf8');

const FACTS = { merchant_id: 'MERCHANT0001A', payee_shared: false, own_merchant_id: null } as const;

function lines(): string[] {
  const out: string[] = [];
  out.push(`nav: ${copy.NAV_SALES} | ${copy.NAV_STATEMENT} | ${copy.NAV_HOME}`);
  out.push(`sales heading: ${copy.SALES_HEADING}`);
  out.push(`sales lede: ${copy.SALES_LEDE}`);
  out.push(`sales empty title: ${copy.SALES_EMPTY_TITLE}`);
  out.push(`sales empty body: ${copy.SALES_EMPTY_BODY}`);
  const c = copy.SALES_COLUMNS;
  out.push(
    `sales columns: ${[c.date, c.order, c.article, c.access, c.amount, c.fee, c.status].join(' | ')}`,
  );
  out.push(`sales fee none: ${copy.FEE_NOT_REPORTED}`);
  out.push(`sales source: ${copy.SALES_SOURCE_NOTE}`);
  out.push(`sales order note: ${copy.SALES_ORDER_NOTE}`);
  for (const n of [0, 1, 2, 7]) out.push(`sales count ${String(n)}: ${copy.salesCountText(n)}`);
  out.push(`statement heading: ${copy.STATEMENT_HEADING}`);
  out.push(`statement lede: ${copy.STATEMENT_LEDE}`);
  out.push(`statement empty title: ${copy.STATEMENT_EMPTY_TITLE}`);
  out.push(`statement empty body: ${copy.STATEMENT_EMPTY_BODY}`);
  out.push(`block heading sandbox: ${copy.blockHeading('USD', 'sandbox')}`);
  out.push(`block heading dryrun: ${copy.blockHeading('EUR', 'dryrun')}`);
  out.push(`settlement heading: ${copy.SETTLEMENT_HEADING}`);
  out.push(`commission heading: ${copy.COMMISSION_HEADING}`);
  for (const k of ['sales', 'refunds', 'reversals', 'fee', 'net'] as const)
    out.push(`line label ${k}: ${copy.LINE_LABEL[k]}`);
  for (const k of ['sales', 'refunds', 'reversals', 'fee', 'net'] as const)
    out.push(`line source ${k}: ${copy.LINE_SOURCE[k]}`);
  out.push(`lines heading: ${copy.LINES_HEADING}`);
  const l = copy.LINES_COLUMNS;
  out.push(`lines columns: ${[l.date, l.order, l.entry, l.amount].join(' | ')}`);
  for (const k of ['sale', 'refund', 'reversal', 'paypal_fee'] as const)
    out.push(`entry ${k}: ${copy.ENTRY_TEXT[k]}`);
  out.push(`anchor: ${copy.salesAnchor('abc001')}`);
  for (const [k, v] of Object.entries(UNIT_STATUS_TEXT)) out.push(`status ${k}: ${v}`);
  const modes = [
    ['dryrun', { ...FACTS, environment: 'dryrun' }],
    ['owner_account', { ...FACTS, payee_shared: true, environment: 'sandbox' }],
    ['direct', { ...FACTS, environment: 'sandbox' }],
    ['not_set', { ...FACTS, merchant_id: null, environment: 'sandbox' }],
  ] as const;
  for (const [mode, facts] of modes) {
    const s = settlementMode(facts);
    expect(s.mode).toBe(mode);
    out.push(`settlement ${mode}: ${s.sentence}`);
  }
  out.push(`commission: ${COMMISSION_LINE}`);
  return out;
}

describe('statement copy', () => {
  it('matches the reviewed golden file', () => {
    expect(lines().join('\n') + '\n').toBe(golden);
  });

  it('has no dash characters and no italics markup', () => {
    const text = lines()
      .map((x) => x.slice(x.indexOf(': ') + 2))
      .join('\n');
    expect(text).not.toMatch(/[‐-―−]|--/);
    expect(text).not.toMatch(/<i>|<em>|\*[^*\s][^*]*\*/);
  });

  it('the environment word comes from the stored environment, not from a typed string', () => {
    expect(copy.environmentWord('sandbox')).toBe('Sandbox');
    expect(copy.environmentWord('dryrun')).toBe('Dry run');
    const src = readFileSync(new URL('./lib/statement-copy.ts', import.meta.url), 'utf8')
      .replace(/\/\/.*$/gm, '')
      .split('\n')
      .filter((x) => !/environmentWord|sandbox'|dryrun'/.test(x))
      .join('\n');
    expect(src).not.toMatch(/Sandbox|Dry run/);
  });

  it('D-051: "Not charged" is the word for declined and for nothing else', () => {
    for (const [k, v] of Object.entries(UNIT_STATUS_TEXT)) {
      if (k === 'declined') expect(v).toBe('Not charged');
      else expect(v).not.toMatch(/not charged/i);
    }
    // the count sentence agrees with its number
    expect(copy.salesCountText(1)).toMatch(/^1 sale is /);
    expect(copy.salesCountText(2)).toMatch(/^2 sales are /);
  });

  it('only the direct mode says the publisher was paid', () => {
    for (const [k, v] of Object.entries({
      dryrun: settlementMode({ ...FACTS, environment: 'dryrun' }).sentence,
      not_set: settlementMode({ ...FACTS, merchant_id: null, environment: 'sandbox' }).sentence,
    })) {
      expect(v, k).not.toMatch(/paid/i);
    }
  });
});
