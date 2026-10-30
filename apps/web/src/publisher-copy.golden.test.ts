// PUB-A1 golden: every string the publisher shell and the publisher sign-in choices show. Static
// lines come from lib/publisher-copy.ts; the variable lines are pinned for each state. The reviewed
// file is golden/publisher-copy.golden.txt. D-051: no italics, no dashes.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import * as copy from './lib/publisher-copy';

const golden = readFileSync(new URL('./golden/publisher-copy.golden.txt', import.meta.url), 'utf8');

function lines(): string[] {
  const out: string[] = [];
  out.push(`nav: ${copy.PUBLISHER_NAV_LABEL}`);
  out.push(`heading: ${copy.PUBLISHER_HEADING}`);
  out.push(`lede: ${copy.PUBLISHER_LEDE}`);
  out.push(
    `labels: ${copy.LABEL_NAME} | ${copy.LABEL_STATUS} | ${copy.LABEL_OFFERS} | ${copy.LABEL_PAYEE}`,
  );
  for (const s of ['applied', 'active', 'suspended'] as const)
    out.push(`status ${s}: ${copy.publisherStatusText(s)}`);
  out.push(`notice applied: ${copy.APPLIED_NOTICE}`);
  out.push(`notice suspended: ${copy.SUSPENDED_NOTICE}`);
  for (const n of [0, 1, 2, 7]) out.push(`offers ${String(n)}: ${copy.offersLiveText(n)}`);
  out.push(`empty title: ${copy.NO_OFFERS_TITLE}`);
  out.push(`empty body: ${copy.NO_OFFERS_BODY}`);
  out.push(`payee none: ${copy.payeeText({ last4: null, verified_at: null })}`);
  out.push(`payee waiting: ${copy.payeeText({ last4: 'AB12', verified_at: null })}`);
  out.push(
    `payee verified: ${copy.payeeText({ last4: 'AB12', verified_at: '2026-10-30T10:00:00.000Z' })}`,
  );
  for (const p of copy.SIGNIN_PERSONAS) out.push(`persona ${p.id}: ${p.label}`);
  out.push(`passcode demo: ${copy.DEMO_PASSCODE_LABEL} | ${copy.DEMO_PASSCODE_HINT}`);
  out.push(
    `passcode publisher: ${copy.PUBLISHER_PASSCODE_LABEL} | ${copy.PUBLISHER_PASSCODE_HINT}`,
  );
  return out;
}

describe('publisher copy', () => {
  it('matches the reviewed golden file', () => {
    expect(lines().join('\n') + '\n').toBe(golden);
  });
  it('has no dash characters, no italics markup and no hard coded environment word', () => {
    const text = lines()
      .map((l) => l.slice(l.indexOf(': ') + 2))
      .join('\n');
    expect(text).not.toMatch(/[‐-―−-]/);
    expect(text).not.toMatch(/<i>|<em>|\*[^*\s][^*]*\*/);
    expect(text).not.toMatch(/sandbox|dry.?run/i);
  });
  it('the persona list is the three publishers, then the other three, each once', () => {
    expect(copy.SIGNIN_PERSONAS.map((p) => p.id)).toEqual([
      'buyer-a',
      'buyer-b',
      'publisher-harbour-ledger',
      'publisher-quayside-gazette',
      'publisher-northfield-quarterly',
      'operator',
    ]);
    expect(copy.isPublisherPersona('publisher-harbour-ledger')).toBe(true);
    expect(copy.isPublisherPersona('buyer-a')).toBe(false);
    expect(copy.isPublisherPersona('publisher')).toBe(false);
  });
});
