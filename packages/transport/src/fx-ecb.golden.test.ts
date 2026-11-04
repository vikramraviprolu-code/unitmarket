import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseEcbDaily } from './fx-ecb';

// MC2-L4 (D-085). The golden sample is a synthetic file in the ECB daily reference-rate format
// (packages/transport/test-data/ecb-eurofxref-daily.xml). It is not an ECB publication and its numbers
// are made up; it is here to pin the envelope the strict parser accepts. Nothing is fetched.
const SAMPLE = readFileSync(
  new URL('../test-data/ecb-eurofxref-daily.xml', import.meta.url),
  'utf8',
);

describe('ECB daily sample (golden)', () => {
  it('parses to the ECB date, USD and GBP and nothing else', () => {
    expect(parseEcbDaily(SAMPLE)).toEqual({ date: '2026-11-03', usd: '1.1612', gbp: '0.8731' });
  });
  it('is well under the 64 KB cap', () => {
    expect(Buffer.byteLength(SAMPLE, 'utf8')).toBeLessThan(2048);
  });
});
