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
  OPS_EVALS_SECTIONS,
  OPS_HOME_SECTIONS,
  OPS_PAYEE_SECTIONS,
  OPS_PUBLISHERS_SECTIONS,
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

  it('both controls always render: each is a form or a one-sentence replacement', () => {
    for (const id of [
      'ops-start-form',
      'ops-start-replaced',
      'ops-stop-form',
      'ops-stop-replaced',
    ]) {
      expect(kill, id).toContain(`data-testid="${id}"`);
    }
    // the words of the replacements come from the ops words file, not from the component
    for (const name of [
      'OPS_START_ALREADY_ON',
      'OPS_START_NEEDS_CODE',
      'OPS_START_NO_APPROVAL',
      'OPS_STOP_ALREADY_OFF',
      'OPS_CONNECT_FLAG_OFF',
    ])
      expect(kill, name).toContain(name);
    expect(kill).toContain('<StopButton />');
    expect(kill).toContain('<StartButton');
  });

  it('the Start fields are labelled, typed text, keyboard reachable, and the scope is only a hint', () => {
    for (const id of ['start-reason', 'start-scope']) {
      expect(start).toContain(`htmlFor="${id}"`);
      expect(start).toContain(`id="${id}"`);
    }
    expect(start).toContain('aria-describedby="start-scope-hint"');
    expect(start).toContain('type="button"');
    expect(start).toContain('{OPS_START_BUTTON}');
    expect(start).not.toContain('tabIndex');
    // the scope field starts empty: the active scope is a hint, never a prefilled value
    expect(start).toContain("useState('')");
    expect(start).not.toMatch(/useState\(activeScope\)/);
    // the error text sits in an ErrorState
    expect(start).toContain('<ErrorState title={OPS_START_ERROR_TITLE}>');
  });

  it('Start posts only a reason and the typed scope to /api/ops/start: no approval, no flag', () => {
    expect(start).toContain("'/api/ops/start', { reason, confirm_scope: scope }");
    expect(start).not.toMatch(/approval_ref|UMS_PAYPAL_CONNECT|connect:/);
  });
});

describe('section tabs (source)', () => {
  const pages: [string, string, string, OpsSection[]][] = [
    ['/ops', 'page.tsx', 'OPS_HOME_SECTIONS', OPS_HOME_SECTIONS],
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

  it('/ops has the sections it names, in this order', () => {
    expect(OPS_HOME_SECTIONS.map((s) => s.id)).toEqual([
      'ops-switches',
      'ops-kill',
      'ops-gate-section',
      'ops-refunds',
      'ops-orders',
      'ops-states',
      'ops-alerts',
      'ops-invariants',
    ]);
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
    expect(found.length).toBe(4);
    for (const p of found) expect(readFileSync(p, 'utf8'), p).toContain('<SectionNav');
  });
});
