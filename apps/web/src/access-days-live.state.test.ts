// JR-1 amendment: pages read the live access window through the engine, so the copy and the setting cannot
// drift. platformAccessDays resolves the platform terms (rows, then the link to the refund window); the copy
// builders print the days they are given, never a constant.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { bootRefundWorld } from './refund-support';
import type { RefundWorld } from './refund-support';
import { DEFAULT_ACCESS_DAYS, optionHelp } from './lib/format';
import { legalDocs, publisherTermsDoc, termsDoc } from './lib/legal-copy';
import { doors } from './lib/account-copy';
import { accessDaysLine, termsPoints } from './lib/buyer-copy';

vi.mock('server-only', () => ({}));
vi.setConfig({ testTimeout: 180_000, hookTimeout: 180_000 });

const OP = { kind: 'operator', operator_id: 'opr_vikram', mfa: true } as const;
const SRC = fileURLToPath(new URL('.', import.meta.url));
const code = (rel: string): string => readFileSync(join(SRC, rel), 'utf8').replace(/\/\/.*$/gm, '');

let w: RefundWorld;
beforeAll(async () => {
  w = await bootRefundWorld();
});
afterAll(async () => w.app.close());

describe('engine.platformAccessDays', () => {
  it('with no rows it is the resolved 7: max(access 5, refund 7)', async () => {
    expect(await w.app.engine.platformAccessDays()).toBe(7);
    expect(await w.app.engine.platformAccessDays()).toBe(DEFAULT_ACCESS_DAYS);
  });

  it('a stored platform refund window of 10 lifts the access window to 10', async () => {
    const r = await w.app.engine.opsRules.add({
      actor: OP,
      rule_key: 'refund.request_window',
      scope_kind: 'platform',
      scope_id: null,
      value: 10,
      effective_from: w.app.security.clock.now().toISOString(),
      effective_until: null,
      reason: 'JR-1 test: ten days to ask for a refund',
    });
    expect(r.ok).toBe(true);
    expect(await w.app.engine.platformAccessDays()).toBe(10);
  });

  it('on any error it falls back to the default and never throws', async () => {
    const spy = vi.spyOn(w.app.db, 'query').mockRejectedValue(new Error('db down'));
    try {
      await expect(w.app.engine.platformAccessDays()).resolves.toBe(DEFAULT_ACCESS_DAYS);
    } finally {
      spy.mockRestore();
    }
  });
});

describe('the copy prints the days it is given', () => {
  it('the legal builders print 9, not 7', () => {
    const all = (docs: ReturnType<typeof legalDocs>) =>
      docs.flatMap((d) => d.sections.flatMap((s) => s.paragraphs)).join(' ');
    const nine = all(legalDocs(9));
    expect(nine).toContain('Access lasts 9 days from verified payment');
    expect(nine).toContain('which is 9 days from verified payment');
    expect(nine).not.toMatch(/\b7 days from verified payment/);
    expect(
      termsDoc(9)
        .sections.flatMap((s) => s.paragraphs)
        .join(' '),
    ).toContain('The 9 days start');
    expect(publisherTermsDoc(9).slug).toBe('publisher-terms');
    expect(termsDoc(DEFAULT_ACCESS_DAYS).sections.length).toBe(termsDoc(9).sections.length);
  });
  it('doors, term points, offer help and the fit line print 9', () => {
    expect(doors(9).find((d) => d.id === 'buyer')!.line).toContain('read it for 9 days.');
    expect(termsPoints(undefined, 9).join(' ')).toContain('9 days of access');
    expect(optionHelp('online_read', 9)).toContain('9 days');
    expect(accessDaysLine('online_read', 9)).toContain('9 days');
  });
});

describe('the pages read the live window once per request', () => {
  it('home, the terms pages, the offer page and discover ask the engine', () => {
    for (const f of [
      'app/page.tsx',
      'app/legal/terms/page.tsx',
      'app/legal/publisher-terms/page.tsx',
      'app/o/[publisher]/[offer]/page.tsx',
      'app/discover/page.tsx',
    ])
      expect(code(f), f).toContain('platformAccessDays()');
  });
  it('the composition resolves the platform terms with the composition clock and falls back', () => {
    const src = code('../composition.server.ts');
    expect(src).toMatch(/platformAccessDays/);
    expect(src).toMatch(/resolveTerms\(/);
    expect(src).toMatch(/access\.window/);
  });
});

describe('Operations rules page: the in-force line', () => {
  it('says so only when the window in force differs from the row shown', async () => {
    const { inForceLine } = await import('./lib/ops-rules-copy');
    expect(inForceLine(7, 7)).toBeNull();
    expect(inForceLine(7, 5)).toBe('In force now: 7 days (raised to match the refund window)');
    expect(code('app/ops/rules/page.tsx')).toContain('platformAccessDays()');
  });
});
