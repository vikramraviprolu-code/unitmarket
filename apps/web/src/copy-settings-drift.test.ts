// A copy string and its source of truth must say the same number. Each test reads the words and the setting and
// compares them; none of the strings is changed here. Route messages and a client component cannot be imported
// by the unit runner, so their source text is read. The live access window (a stored platform row) is covered
// in access-days-live.state.test.ts.
//
// Lint rule Z1 bars apps/web from importing @umsbx/catalogue, @umsbx/mandates and @umsbx/safety, so the values
// below are written out as literals that MIRROR the exported constants: INVITE_TTL_MS (7 days, domain/catalogue
// publisher-invites.ts), MAX_MANDATE_DAYS (90, domain/mandates store.ts), MAX_SWITCH_CACHE_MS (5000) and
// SITTING_CEILING (packages/safety sitting.ts, switches.ts). If one of those changes, change it here and in the
// words together. The contracts constants are imported for real.
const INVITE_TTL_MS = 7 * 86_400_000;
const MAX_MANDATE_DAYS = 90;
const MAX_SWITCH_CACHE_MS = 5000;
const SITTING_CEILING = { valid_ms: 4 * 3_600_000, max_amount_minor: 500, max_calls: 40 };
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { APPROVAL_TTL_MS, FEE_BPS_MAX } from '@umsbx/contracts';
import { SKIN_COOKIE_MAX_AGE_S } from './lib/skin';
import { DEFAULT_ACCESS_DAYS, optionHelp } from './lib/format';
import { accessDaysLine, termsPointList, termsPoints } from './lib/buyer-copy';
import { LEGAL_DOCS, legalDocs, publisherTermsDoc, termsDoc } from './lib/legal-copy';
import { doors } from './lib/account-copy';
import { CLAIM_LEDE } from './lib/publisher-accounts-copy';
import { OPS_SITTING_LEDE, OPS_START_DONE } from './lib/ops-copy';
import * as opsCopy from './lib/ops-copy';
import { FEE_LEDE } from './lib/payout-copy';
import { CAP_REFUSAL_WORDS } from './lib/buyer-agents-view';

const SRC = fileURLToPath(new URL('.', import.meta.url));
const source = (rel: string): string => readFileSync(join(SRC, rel), 'utf8');
const flat = (
  docs: readonly { sections: readonly { paragraphs: readonly string[] }[] }[],
): string => docs.flatMap((d) => d.sections.flatMap((s) => s.paragraphs)).join(' ');
const legalText = (): string =>
  LEGAL_DOCS.flatMap((d) => [
    d.title,
    ...d.sections.flatMap((s) => [s.heading, ...s.paragraphs]),
  ]).join(' ');

describe('access window: the builders print the days they are given', () => {
  it('the default and the fallback are the registry days', () => {
    expect(DEFAULT_ACCESS_DAYS).toBe(7);
    expect(termsPointList()[1]).toContain(`${DEFAULT_ACCESS_DAYS} days of access`);
    expect(doors().find((d) => d.id === 'buyer')!.line).toContain(`${DEFAULT_ACCESS_DAYS} days`);
  });
  it.each([3, 7, 9, 14])('%i days appear everywhere the window is named', (n) => {
    const terms = flat([termsDoc(n)]);
    expect(terms).toContain(`Access lasts ${n} days from verified payment`);
    expect(terms).toContain(`The ${n} days start`);
    expect(flat([publisherTermsDoc(n)])).toContain(`which is ${n} days from verified payment`);
    expect(flat(legalDocs(n))).toContain(`${n} days`);
    expect(termsPoints(undefined, n).join(' ')).toContain(`${n} days of access`);
    expect(doors(n).find((d) => d.id === 'buyer')!.line).toContain(`read it for ${n} days.`);
    expect(optionHelp('online_read', n)).toContain(`${n} days`);
    expect(optionHelp('keep_retrieve', n)).toContain(`${n} days`);
    expect(accessDaysLine('online_read', n)).toBe(`${n} days to read`);
  });
});

describe('price hold: the approval lifetime', () => {
  const minutes = APPROVAL_TTL_MS / 60_000;
  it('the term point, the terms and the renew button say the same minutes', () => {
    expect(termsPointList()[2]).toContain(`held for ${minutes} minutes.`);
    expect(legalText()).toContain(`Price and terms are held for ${minutes} minutes`);
    expect(legalText()).toContain(`are held for ${minutes} minutes. Nothing is charged`);
    expect(legalText()).toContain(`complete within its ${minutes} minutes`);
    expect(source('ui/Countdown.tsx')).toContain(`Renew for another ${minutes} minutes`);
  });
});

describe('invite code', () => {
  it('the claim page says the days the invite lives', () => {
    expect(CLAIM_LEDE).toContain(`expires after ${INVITE_TTL_MS / 86_400_000} days.`);
  });
});

describe('skin cookie', () => {
  it('the privacy notice says the days the cookie lasts', () => {
    expect(legalText()).toContain(`${SKIN_COOKIE_MAX_AGE_S / 86_400} days`);
  });
});

describe('PayPal sitting', () => {
  it('the lede says the hours, the amount and the calls of the fixed ceiling', () => {
    expect(SITTING_CEILING.valid_ms).toBe(4 * 3_600_000);
    expect(OPS_SITTING_LEDE).toContain('up to four hours');
    expect(OPS_SITTING_LEDE).toContain(
      `$${(SITTING_CEILING.max_amount_minor / 100).toFixed(2)} per order`,
    );
    expect(OPS_SITTING_LEDE).toContain(`${SITTING_CEILING.max_calls} calls`);
  });
});

describe('switch delay', () => {
  it('every ops line that promises a delay says the cache lifetime in seconds', () => {
    const seconds = MAX_SWITCH_CACHE_MS / 1000;
    const lines = Object.values(opsCopy).filter(
      (v: unknown): v is string => typeof v === 'string' && /in force within/.test(v),
    );
    expect(lines.length).toBeGreaterThan(0);
    expect(OPS_START_DONE).toContain(`within ${seconds} seconds`);
    for (const l of lines) expect(l).toContain(`within ${seconds} seconds`);
  });
});

describe('fee range', () => {
  it('the form and the route message say the same percent as the maximum', () => {
    const percent = FEE_BPS_MAX / 100;
    expect(FEE_LEDE).toContain(`0 to ${percent} percent`);
    expect(source('app/api/ops/fee/route.ts')).toContain(`from 0 to ${percent} percent`);
  });
});

describe('agent cap', () => {
  it('the page words and the route message say the same days as the maximum', () => {
    expect(CAP_REFUSAL_WORDS['invalid_expiry']).toContain(`within ${MAX_MANDATE_DAYS} days`);
    expect(source('app/api/buyer/mandates/route.ts')).toContain(`within ${MAX_MANDATE_DAYS} days`);
  });
});
