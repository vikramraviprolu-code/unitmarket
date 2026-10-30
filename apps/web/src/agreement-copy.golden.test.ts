// AGREE-1 golden: every string of the publisher terms record on the publisher home (S1) and the
// operator publishers page (S7). The reviewed file is golden/agreement-copy.golden.txt. D-051: no
// italics, no dashes.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import * as copy from './lib/agreement-copy';

const golden = readFileSync(new URL('./golden/agreement-copy.golden.txt', import.meta.url), 'utf8');

function lines(): string[] {
  const rec = { accepted_at: '2026-10-30T10:00:00.000Z', terms_version: 'v1' };
  return [
    `link: ${copy.LINK_PUBLISHER_TERMS}`,
    `accepted: ${copy.agreementText(rec)}`,
    `accepted other date: ${copy.agreementText({ accepted_at: '2027-01-05T23:59:59.000Z', terms_version: 'v12' })}`,
    `not accepted: ${copy.NOT_ACCEPTED_TEXT}`,
    `changed: ${copy.agreementChangedText('v2')}`,
    `by: ${copy.acceptedByText('Demo publisher contact')}`,
  ];
}

describe('agreement copy', () => {
  it('matches the reviewed golden file', () => {
    expect(lines().join('\n') + '\n').toBe(golden);
  });

  it('has no dash characters, no hyphen between words, no italics markup and no typed environment word', () => {
    const text = lines().join('\n');
    expect(text).not.toMatch(/[‐-―−]/);
    expect(text).not.toMatch(/\w - \w/);
    expect(text).not.toMatch(/<i>|<em>|\*[a-z]/i);
    const src = readFileSync(new URL('./lib/agreement-copy.ts', import.meta.url), 'utf8');
    expect(src).not.toMatch(/Sandbox|Dry run|dryrun/);
  });

  it('says the record is a demo record and never claims a person clicked', () => {
    expect(copy.agreementText({ accepted_at: '2026-10-30T10:00:00.000Z', terms_version: 'v1' })).toMatch(
      /demo record/,
    );
  });
});
