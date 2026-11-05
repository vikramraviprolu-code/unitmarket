// WEB-OPS-START (integration): the markup of the operator pages, read from the page sources. The test
// runner has no JSX transform for the app (tsconfig keeps jsx as preserve), so no page is rendered here;
// like the other page tests it reads the .tsx files. It checks what the spec promises: the Start and Stop
// forms are both there and the one that does not apply is replaced by a sentence, the Start fields are
// labelled and reachable by keyboard and the scope is a hint, and every operator page has a tab bar whose
// tabs point at ids that exist on that page, in page order.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  OPS_CONTROLS_SECTIONS,
  OPS_EVALS_SECTIONS,
  OPS_HOME_SECTIONS,
  OPS_MONEY_SECTIONS,
  OPS_PAYEE_SECTIONS,
  OPS_PUBLISHERS_SECTIONS,
  OPS_SELLERS_SECTIONS,
} from './lib/ops-copy';
import type { OpsSection } from './lib/ops-copy';

const OPS_DIR = join(import.meta.dirname, 'app', 'ops');
const read = (rel: string): string => readFileSync(join(OPS_DIR, rel), 'utf8');

describe('/ops Kill switch block (source)', () => {
  const page = read('page.tsx');
  const kill = read('KillControls.tsx');
  const start = read('StartButton.tsx');

  it('the page hands the controls the stored switch, whether the session has the code, and the active scope', () => {
    expect(page).toContain('<KillControls');
    expect(page).toContain('outboundOn={snap.kill_switch.outbound_on}');
    expect(page).toContain('hasCode={actor.mfa === true}');
    expect(page).toContain('activeScope={snap.kill_switch.active_scope}');
    expect(page).toContain('<Section title="Kill switch" id="ops-kill">');
  });

  it('Stop always renders; Start is the form or a one-sentence replacement', () => {
    for (const id of ['ops-start-form', 'ops-start-replaced', 'ops-stop-form']) {
      expect(kill, id).toContain(`data-testid="${id}"`);
    }
    expect(kill).not.toContain('ops-stop-replaced');
    expect(kill).not.toContain('OPS_STOP_ALREADY_OFF');
    // the words of the replacements come from the ops words file, not from the component
    for (const name of [
      'OPS_START_ALREADY_ON',
      'OPS_START_NEEDS_CODE',
      'OPS_START_NO_APPROVAL',
      'OPS_CONNECT_FLAG_OFF',
    ])
      expect(kill, name).toContain(name);
    expect(kill).toContain('<StopButton');
    expect(kill).toContain('<StartButton');
  });

  it('WEB-POLISH-2: the flag state reaches the badges and the start sentence, and Stop uses the shared words', () => {
    expect(page).toContain("switchChip('paypal_outbound', snap.kill_switch.outbound_on, flagOff)");
    // INT-UI0: the switch badges moved to /ops/controls, and the flagOff read moved to the tab modules.
    expect(read('controls/page.tsx')).toContain('switchView(name, on, flagOff)');
    for (const m of ['ops-home', 'ops-controls'])
      expect(
        readFileSync(join(import.meta.dirname, 'composition', `${m}.ts`), 'utf8'),
        m,
      ).toContain("snap.gate.mode === 'sandbox' && !snap.gate.connect");
    expect(page).toContain('flagOff={flagOff}');
    expect(kill).toContain('startDoneText(started.calls_left, showFlagLine)');
    expect(read('StopButton.tsx')).toContain('OPS_STOP_DONE');
    expect(read('StopButton.tsx')).not.toContain('with your authenticator code');
  });

  it('one aria-live region for the start result stays mounted outside the conditional', () => {
    const live = kill.indexOf('data-testid="ops-start-result"');
    expect(live).toBeGreaterThan(-1);
    expect(kill.match(/data-testid="ops-start-result"/g)).toHaveLength(1);
    expect(kill.slice(live - 80, live)).toContain('aria-live="polite"');
    // it comes before the Start conditional, so it exists whichever control is shown
    expect(live).toBeLessThan(kill.indexOf("view.start === 'form'"));
  });

  it('the local On state follows the server again after a refresh, and Stop refreshes too', () => {
    expect(kill).toContain('useEffect');
    expect(kill).toMatch(/useEffect\([\s\S]*\[outboundOn\]/);
    expect(kill).toContain('onStopped');
    expect(kill.match(/router\.refresh\(\)/g)?.length).toBeGreaterThanOrEqual(2);
    expect(read('StopButton.tsx')).toContain('onStopped');
  });

  it('Start and Stop are real forms with required fields, and their headings are h3 inside the Section', () => {
    const stop = read('StopButton.tsx');
    for (const [name, src] of [
      ['StartButton', start],
      ['StopButton', stop],
    ] as const) {
      expect(src, name).toContain('<form');
      expect(src, name).toContain('onSubmit');
      expect(src, name).toContain('preventDefault');
      expect(src, name).toContain('type="submit"');
      expect(src, name).toContain('required');
      expect(src, name).toContain('aria-required="true"');
      expect(src, name).not.toContain('<h2');
    }
    expect(start).toContain('<h3 id="start-heading">');
    expect(stop).toContain('<h3 id="stop-heading">');
    const css = readFileSync(join(OPS_DIR, 'pk-opshome.css'), 'utf8');
    expect(css).toContain('.oh-start h3');
    expect(css).toContain('.oh-stop h3');
    expect(css).not.toContain('.oh-stop h2');
  });

  it('Start posts only a reason and the typed scope to /api/ops/start: no approval, no flag', () => {
    expect(start).toContain("'/api/ops/start', { reason, confirm_scope: scope }");
    expect(start).not.toMatch(/approval_ref|UMS_PAYPAL_CONNECT|connect:/);
  });
});

describe('section tabs (source)', () => {
  const pages: [string, string, string, OpsSection[]][] = [
    ['/ops', 'page.tsx', 'OPS_HOME_SECTIONS', OPS_HOME_SECTIONS],
    // INT-UI0: the blocks that moved off /ops, each page with its own tab bar.
    ['/ops/money', 'money/page.tsx', 'OPS_MONEY_SECTIONS', OPS_MONEY_SECTIONS],
    ['/ops/sellers', 'sellers/page.tsx', 'OPS_SELLERS_SECTIONS', OPS_SELLERS_SECTIONS],
    ['/ops/controls', 'controls/page.tsx', 'OPS_CONTROLS_SECTIONS', OPS_CONTROLS_SECTIONS],
    ['/ops/publishers', 'publishers/page.tsx', 'OPS_PUBLISHERS_SECTIONS', OPS_PUBLISHERS_SECTIONS],
    ['/ops/payee-requests', 'payee-requests/page.tsx', 'OPS_PAYEE_SECTIONS', OPS_PAYEE_SECTIONS],
    ['/ops/evals', 'evals/page.tsx', 'OPS_EVALS_SECTIONS', OPS_EVALS_SECTIONS],
  ];

  it.each(pages)(
    '%s renders SectionNav with its list, and every tab id is an id in the page, in page order',
    (_p, file, listName, items) => {
      const src = read(file);
      expect(src).toContain(`<SectionNav label="Sections of this page" items={${listName}} />`);
      const navAt = src.indexOf('<SectionNav');
      let last = navAt;
      for (const i of items) {
        const hits = src.match(new RegExp(`\\sid="${i.id}"`, 'g')) ?? [];
        // two writings are allowed only where a section has an empty and a filled branch
        expect(hits.length, `${i.id} must be an id in ${file}`).toBeGreaterThanOrEqual(1);
        expect(hits.length, `${i.id} in ${file}`).toBeLessThanOrEqual(2);
        const at = src.indexOf(`id="${i.id}"`, navAt);
        expect(at, `${i.id} comes after the tab bar`).toBeGreaterThan(last);
        last = at;
      }
    },
  );

  // INT-UI0: the other ids of the old /ops moved to /ops/money, /ops/controls and /ops/sellers (lib/shell-moves.ts).
  it('/ops has the sections it names, in this order', () => {
    expect(OPS_HOME_SECTIONS.map((s) => s.id)).toEqual(['ops-kill', 'ops-alerts', 'ops-moved']);
  });
  it('the moved sections keep their ids on the new pages, in their old order', () => {
    expect(OPS_MONEY_SECTIONS.map((s) => s.id)).toEqual([
      'ops-refunds',
      'ops-orders',
      'ops-totals',
      'ops-states',
      'ops-invariants',
    ]);
    expect(OPS_CONTROLS_SECTIONS.map((s) => s.id)).toEqual(['ops-switches', 'ops-gate-section']);
    expect(OPS_SELLERS_SECTIONS.map((s) => s.id)).toContain('ops-shared-payee');
  });

  it('no operator page is left out: every page.tsx under /ops has the tab bar', () => {
    const found: string[] = [];
    const walk = (d: string): void => {
      for (const n of readdirSync(d)) {
        const p = join(d, n);
        if (statSync(p).isDirectory()) walk(p);
        else if (n === 'page.tsx') found.push(p);
      }
    };
    walk(OPS_DIR);
    expect(found.length).toBe(7);
    for (const p of found) expect(readFileSync(p, 'utf8'), p).toContain('<SectionNav');
  });
});
