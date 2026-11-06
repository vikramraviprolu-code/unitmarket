// POB-M1: the screens, read as source (the way ops-start.integration.test.ts reads the operator pages). The operator Money page
// gets two sections after Invariants, Payouts to publishers and Fee on top, without changing the tab list of that page. The
// publisher statement and sales pages show the money block of a block that has one. Labels come from lib/payout-copy.ts.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const APP = new URL('./app/', import.meta.url).pathname;
const read = (rel: string): string => readFileSync(join(APP, rel), 'utf8');

describe('operator Money page', () => {
  const page = read('ops/money/page.tsx');
  it('has the payouts and the fee sections after Invariants', () => {
    const inv = page.indexOf('id="ops-invariants"');
    const pay = page.indexOf('id="ops-payouts"');
    const fee = page.indexOf('id="ops-fee"');
    expect(inv).toBeGreaterThan(0);
    expect(pay).toBeGreaterThan(inv);
    expect(fee).toBeGreaterThan(pay);
    expect(page).toContain('PAYOUTS_HEADING');
    expect(page).toContain('FEE_HEADING');
  });
  it('shows the fee form to a session with the second factor and says why otherwise', () => {
    expect(page).toContain('<FeeForm');
    expect(page).toContain('FEE_NO_MFA');
  });
  it('reads payouts and fee through the Money read, not the database', () => {
    expect(page).not.toMatch(/db\.query|@umsbx\/(db|payments|catalogue)/);
    expect(read('../composition/ops-money.ts')).toContain('opsPayouts');
    expect(read('../composition/ops-money.ts')).toContain('opsFee');
  });
});

describe('FeeForm', () => {
  const form = read('ops/FeeForm.tsx');
  it('is a client form that posts percent as whole basis points with an Idempotency-Key', () => {
    expect(form.startsWith("'use client';")).toBe(true);
    expect(form).toContain("'/api/ops/fee'");
    expect(form).toContain('percentToBps');
    expect(form).toContain('idempotency-key');
  });
  it('never shows the words basis points to the operator (the field name of the request is not shown)', () => {
    const shown = form.replace(/\/\/.*$/gm, '').replace(/fee_bps/g, '');
    expect(shown).not.toMatch(/basis point|\bbps\b/i);
  });
});

describe('publisher pages', () => {
  it('the statement shows the money block of a block that has one', () => {
    const page = read('publisher/statement/page.tsx');
    expect(page).toContain('<MoneyBlock');
    expect(page).toMatch(/b\.money !== null/);
  });
  it('the sales page shows the same block beside the totals', () => {
    const page = read('publisher/sales/page.tsx');
    expect(page).toContain('<MoneyBlock');
    expect(page).toMatch(/t\.money !== null/);
  });
  it('MoneyBlock draws its words from lib/payout-copy.ts and its figures from the block', () => {
    const block = read('publisher/MoneyBlock.tsx');
    expect(block).toContain('moneyTiles');
    expect(block).toContain('data-testid');
  });
});
