// JR-1 (docs/specs/web-judge-ready-copy.md): the access-window words agree with what the engine sells, the home
// countdown speaks like the library, the meter scales to the window, and two operator layouts hold. The unit
// runner does not compile .tsx, so page wiring is read as text, as in ux-phase1a.test.ts.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { LEGAL_DOCS } from './lib/legal-copy';
import { DEFAULT_ACCESS_DAYS } from './lib/format';
import { homeModel, timeLeftNote } from './lib/buyer-home-view';
import { meterFill, meterTotalDays } from './lib/buyer-copy';
import { TERMS_POINTS } from './lib/buyer-copy';
import { DOORS } from './lib/account-copy';

const SRC = fileURLToPath(new URL('.', import.meta.url));
const read = (rel: string): string => readFileSync(join(SRC, rel), 'utf8');
const code = (rel: string): string => read(rel).replace(/\/\/.*$/gm, '');

const NOW = new Date('2026-11-05T12:00:00.000Z');
const plus = (ms: number): string => new Date(NOW.getTime() + ms).toISOString();
const H = 3_600_000;
const D = 24 * H;

const walk = (dir: string): string[] =>
  readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });

describe('JR-1 the days come from the registry, never from copy', () => {
  it('the default is the 7 days the engine resolves (D-096)', () => {
    expect(DEFAULT_ACCESS_DAYS).toBe(7);
  });

  it('no hard-coded "five days" or "5 days of access" in non-test source', () => {
    const hits = walk(SRC)
      .filter((f) => /\.(ts|tsx)$/.test(f) && !/\.test\.tsx?$/.test(f))
      .filter((f) => /five days|5 days of access/i.test(readFileSync(f, 'utf8')));
    expect(hits).toEqual([]);
  });

  it('the home hero says the registry days', () => {
    const src = code('app/page.tsx');
    expect(src).toContain('platformAccessDays()');
    expect(src).toMatch(/\$\{days\} days of access/);
  });

  it('the terms, the term points and the buyer door say the registry days', () => {
    const terms = LEGAL_DOCS.find((d) => d.slug === 'terms')!;
    const text = terms.sections.flatMap((s) => s.paragraphs).join(' ');
    expect(text).toContain(`${DEFAULT_ACCESS_DAYS} days`);
    expect(TERMS_POINTS.join(' ')).toContain(`${DEFAULT_ACCESS_DAYS} days of access`);
    expect(DOORS.find((d) => d.id === 'buyer')!.line).toContain(`${DEFAULT_ACCESS_DAYS} days`);
    const pub = LEGAL_DOCS.find((d) => d.slug === 'publisher-terms')!;
    expect(pub.sections.flatMap((s) => s.paragraphs).join(' ')).toContain(
      `${DEFAULT_ACCESS_DAYS} days`,
    );
  });
});

describe('JR-1 the legal pages are final for the sandbox demo', () => {
  it('no page says it is a draft that may change, and each says final, not legal advice, no real money', () => {
    for (const d of LEGAL_DOCS) {
      const intro = d.sections[0]!.paragraphs[0]!;
      expect(intro, d.slug).not.toMatch(/may change before the demo is submitted/i);
      expect(intro, d.slug).not.toMatch(/draft/i);
      expect(intro, d.slug).toMatch(/final/i);
      expect(intro, d.slug).toMatch(/not legal advice/i);
      expect(intro, d.slug).toMatch(/No real money moves/);
    }
    const pub = LEGAL_DOCS.find((d) => d.slug === 'publisher-terms')!;
    expect(pub.sections[0]!.paragraphs[0]).toContain(
      'They describe only what the demo does today.',
    );
  });

  it('no "may change before the demo" text in non-test source', () => {
    const hits = walk(SRC)
      .filter((f) => /\.(ts|tsx)$/.test(f) && !/\.test\.tsx?$/.test(f))
      .filter((f) => /may change before the demo/i.test(readFileSync(f, 'utf8')));
    expect(hits).toEqual([]);
  });
});

describe('JR-1 the home countdown uses the library words', () => {
  const reading = (ends_at: string | null, days_left: number | null = 5) =>
    homeModel({
      pending: [],
      reading: [
        {
          entitlement_id: 'ent_1',
          title: 'Tide tables',
          publisher: 'Harbour',
          days_left,
          ends_at,
        },
      ],
      caps: [],
      recent: [],
      now: NOW,
    }).sections.find((s) => s.id === 'continue_reading')!.items[0]!.note;

  it('4 days 3 hours left reads "4 days 3 hours left."', () => {
    expect(reading(plus(4 * D + 3 * H))).toBe('4 days 3 hours left.');
  });
  it('floors to whole hours and never rounds a day up', () => {
    expect(reading(plus(4 * D + 23 * H + 59 * 60_000))).toBe('4 days 23 hours left.');
  });
  it('drops a zero part and uses the singular', () => {
    expect(reading(plus(2 * D))).toBe('2 days left.');
    expect(reading(plus(1 * D + 1 * H))).toBe('1 day 1 hour left.');
    expect(reading(plus(1 * D))).toBe('1 day left.');
    expect(reading(plus(5 * H))).toBe('5 hours left.');
    expect(reading(plus(1 * H))).toBe('1 hour left.');
  });
  it('under one hour says less than 1 hour, also when the end has passed', () => {
    expect(timeLeftNote(plus(59 * 60_000), NOW)).toBe('Less than 1 hour left.');
    expect(timeLeftNote(plus(-H), NOW)).toBe('Less than 1 hour left.');
  });
  it('no end date means no note', () => {
    expect(reading(null, null)).toBeNull();
  });
  it('the composition passes ends_at through', () => {
    expect(code('composition/buyer.ts')).toMatch(/ends_at:\s*e\.window\.ends_at/);
  });
});

describe('JR-1 the library meter scales to the window', () => {
  it('total is ends_at minus started_at in days, else the registry default', () => {
    expect(meterTotalDays('2026-11-01T00:00:00.000Z', '2026-11-08T00:00:00.000Z')).toBe(7);
    expect(meterTotalDays('2026-11-01T00:00:00.000Z', '2026-11-06T00:00:00.000Z')).toBe(5);
    expect(meterTotalDays('2026-11-01T00:00:00.000Z', '2026-11-04T12:00:00.000Z')).toBe(4);
    expect(meterTotalDays(null, '2026-11-08T00:00:00.000Z')).toBe(DEFAULT_ACCESS_DAYS);
    expect(meterTotalDays(undefined, null)).toBe(DEFAULT_ACCESS_DAYS);
  });
  it('used over total maps onto the five fill classes', () => {
    expect(meterFill(0, 7)).toBe(0);
    expect(meterFill(1, 7)).toBe(1);
    expect(meterFill(4, 7)).toBe(3);
    expect(meterFill(7, 7)).toBe(5);
    expect(meterFill(9, 7)).toBe(5);
    expect(meterFill(3, 5)).toBe(3);
  });
  it('WindowMeter has no fixed total of 5, takes startedAt, and keeps its words and test id', () => {
    const src = code('ui/WindowMeter.tsx');
    expect(src).not.toMatch(/TOTAL_DAYS\s*=\s*5/);
    expect(src).toContain('startedAt');
    expect(src).toContain('meterTotalDays(');
    expect(src).toContain('meterFill(');
    expect(src).toContain('days used');
    expect(src).toContain('data-testid="window-meter"');
  });
  it('the two library callers that have started_at pass startedAt (the reader view has none)', () => {
    for (const f of ['app/library/page.tsx', 'app/library/[entitlement]/page.tsx'])
      expect(code(f), f).toMatch(/startedAt=\{[a-z]+\.window\.started_at\}/);
  });
});

describe('JR-1 the operator order summary keeps a two-column grid', () => {
  it('no <div> sits inside dl.pk-facts; the pairs are Fragments', () => {
    const src = code('app/ops/money/orders/[ref]/page.tsx');
    const start = src.indexOf('<dl className="pk-facts">');
    expect(start).toBeGreaterThan(-1);
    const block = src.slice(start, src.indexOf('</dl>', start));
    expect(block).not.toMatch(/<div[\s>]/);
    expect(block).toContain('<Fragment');
    expect(src).toMatch(/import\s*\{[^}]*\bFragment\b[^}]*\}\s*from 'react'/);
  });
});

describe('JR-1 the phone tab bar wraps its labels', () => {
  const css = read('ui/shell/shell.css');
  const rule = (() => {
    const at = css.lastIndexOf('.shell-phonebar a {');
    return css.slice(at, css.indexOf('}', at));
  })();
  it('no ellipsis, no clipping, labels wrap, 44px target stays', () => {
    expect(rule).not.toMatch(/text-overflow/);
    expect(rule).not.toMatch(/overflow:\s*hidden/);
    expect(rule).toMatch(/white-space:\s*normal/);
    expect(rule).toMatch(/overflow-wrap:\s*anywhere/);
    expect(rule).toMatch(/min-height:\s*44px/);
    expect(rule).toMatch(/display:\s*flex/);
    expect(rule).toMatch(/line-height:\s*1\.15/);
  });
});
