// INT-UI0 / UI0.2, UI0.3: the move table (lib/shell-moves.ts) is data, and these tests read it. For each row
// the new page's source holds the block's id. SCR-1: Home no longer keeps a stub for a moved block (the owner
// asked for the "Moved to other tabs" section to be removed), so Home's source must hold none of them.
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import * as shellMoves from './lib/shell-moves';
import { KEPT_URLS, SHELL_MOVES } from './lib/shell-moves';
import { OPS_HOME_SECTIONS } from './lib/ops-copy';

const here = fileURLToPath(new URL('.', import.meta.url));
const read = (rel: string) => readFileSync(join(here, rel), 'utf8');
const pageOf = (path: string) => `app${path}/page.tsx`;
const home = read(pageOf('/ops'));

describe('the move table', () => {
  it('names the ten ids of the spec, once each', () => {
    expect(SHELL_MOVES.map((m) => m.id)).toEqual([
      'ops-kill',
      'ops-alerts',
      'ops-switches',
      'ops-gate-section',
      'ops-refunds',
      'ops-orders',
      'ops-totals',
      'ops-states',
      'ops-invariants',
      'ops-shared-payee',
    ]);
  });
  it('sends each block where the spec says', () => {
    const where = Object.fromEntries(SHELL_MOVES.map((m) => [m.id, m.to]));
    expect(where).toEqual({
      'ops-kill': '/ops',
      'ops-alerts': '/ops',
      'ops-switches': '/ops/controls',
      'ops-gate-section': '/ops/controls',
      'ops-refunds': '/ops/money',
      'ops-orders': '/ops/money',
      'ops-totals': '/ops/money',
      'ops-states': '/ops/money',
      'ops-invariants': '/ops/money',
      'ops-shared-payee': '/ops/sellers',
    });
  });
  it('the kill switch and the alerts stay on Home, and every other row is a move', () => {
    for (const m of SHELL_MOVES) expect(m.moved).toBe(!['ops-kill', 'ops-alerts'].includes(m.id));
  });
  it('every old place is /ops', () => {
    for (const m of SHELL_MOVES) expect(m.from).toBe('/ops');
  });
});

describe('each moved block', () => {
  const moved = SHELL_MOVES.filter((m) => m.moved);
  it.each(moved.map((m) => [m.id, m.to] as const))('%s: the new page has the id', (id, to) => {
    const src = read(pageOf(to));
    expect(src, `${to} must carry id="${id}"`).toMatch(new RegExp(`\\sid="${id}"`));
  });
  it.each(moved.map((m) => [m.id, m.to] as const))(
    '%s: Home keeps no stub or section for it',
    (id) => {
      expect(home).not.toMatch(new RegExp(`\\sid="${id}"`));
      expect(home).not.toContain(`ops-stub-${id}`);
    },
  );
  it('Home has no "Moved to other tabs" section, no MovedStub and no stub list', () => {
    expect(home).not.toContain('Moved to other tabs');
    expect(home).not.toContain('ops-moved');
    expect(home).not.toContain('MovedStub');
    expect(home).not.toContain('oh-stub');
    expect(home).not.toContain('shell-moves');
    expect(shellMoves).not.toHaveProperty('stubFor');
  });
});

describe('the blocks that stay', () => {
  it.each(['ops-kill', 'ops-alerts'])('%s is still a section of Home', (id) => {
    expect(home).toMatch(new RegExp(`<Section[^>]*\\bid="${id}"`));
  });
  it('the kill switch panel and its controls are the same components', () => {
    expect(home).toContain("import { KillControls } from './KillControls'");
    expect(home).toContain('<KillControls');
    expect(home).toContain('data-testid="ops-kill-switch"');
  });
});

describe('the moved panels are the same components', () => {
  it('Money holds the refund panel, the reporting totals and the orders table as they were', () => {
    const src = read(pageOf('/ops/money'));
    expect(src).toContain("import { RefundPanel } from '../RefundPanel'");
    expect(src).toContain("import { ReportingTotals } from '../ReportingTotals'");
    expect(src).toContain('<RefundPanel');
    expect(src).toContain('data-testid="refund-no-mfa"');
    expect(src).toContain('{o.order_ref}');
    expect(src).toContain('<TableScroll label="Latest orders">');
  });
  it('Controls holds the switches and the outbound gate as they were', () => {
    const src = read(pageOf('/ops/controls'));
    // INT-CTL: the switch cards moved into SwitchList, which the page renders.
    expect(src).toContain('<SwitchList');
    expect(read('ui/ops/SwitchList.tsx')).toContain('data-testid={`ops-switch-${l.name}`}');
    expect(src).toContain('data-testid="ops-gate"');
    expect(src).toContain('gateLines(');
  });
  it('Sellers renders the shared payee line whenever the data says so, inside a section that always exists', () => {
    const src = read(pageOf('/ops/sellers'));
    expect(src).toMatch(/<Section[^>]*\bid="ops-shared-payee"/);
    expect(src).toContain('data-testid="ops-shared-payee"');
  });
  it('the three new pages keep section tabs, with only ids that are on the page', () => {
    for (const [path, name] of [
      ['/ops/money', 'OPS_MONEY_SECTIONS'],
      ['/ops/sellers', 'OPS_SELLERS_SECTIONS'],
      ['/ops/controls', 'OPS_CONTROLS_SECTIONS'],
    ] as const)
      expect(read(pageOf(path))).toContain(
        `<SectionNav label="Sections of this page" items={${name}} />`,
      );
  });
  it('Home tabs list what is left on Home', () => {
    expect(OPS_HOME_SECTIONS.map((s) => s.id)).toEqual(['ops-kill', 'ops-alerts']);
    expect(home).not.toMatch(/\sid="ops-moved"/);
  });
});

describe('URLs that keep working', () => {
  it('the table names them and each still has its page', () => {
    expect(KEPT_URLS.map((k) => k.url)).toEqual([
      '/ops/publishers',
      '/ops/payee-requests',
      '/ops/evals',
      '/publisher',
      '/library',
      '/account',
      '/discover',
      '/buyer',
    ]);
    for (const k of KEPT_URLS) expect(existsSync(join(here, pageOf(k.url))), k.url).toBe(true);
  });
  it('publishers and payee requests sit under Sellers, evals under Controls', () => {
    const under = Object.fromEntries(KEPT_URLS.map((k) => [k.url, k.under]));
    expect(under['/ops/publishers']).toBe('sellers');
    expect(under['/ops/payee-requests']).toBe('sellers');
    expect(under['/ops/evals']).toBe('controls');
  });
});
