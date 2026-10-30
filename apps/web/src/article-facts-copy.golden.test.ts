// PUB-E5 golden (docs/specs/pub-e5-article-facts.md): every string the article facts show on the publisher
// offer list (S2), the publisher offer page (S3) and the buyer offer page, including the fallback for a
// missing or malformed fact. The reviewed file is golden/article-facts-copy.golden.txt. D-051: no italics,
// no dashes. The pages must take these words from lib/offer-copy.ts and carry no inline style.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import * as copy from './lib/offer-copy';

const golden = readFileSync(
  new URL('./golden/article-facts-copy.golden.txt', import.meta.url),
  'utf8',
);
const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), 'utf8');

const SHA = 'a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90';

function lines(): string[] {
  const out: string[] = [];
  out.push(`heading: ${copy.ARTICLE_FACTS_HEADING}`);
  out.push(`note: ${copy.ARTICLE_FACTS_NOTE}`);
  out.push(
    `labels: ${copy.LABEL_ABSTRACT} | ${copy.LABEL_LANGUAGE} | ${copy.LABEL_SIZE} | ${copy.LABEL_FINGERPRINT}`,
  );
  out.push(`missing: ${copy.FACT_MISSING}`);
  for (const c of ['en', 'fr', 'de', 'es', 'EN', 'pt', 'nl', '', '  ', 'english words', '<b>'])
    out.push(`language "${c}": ${copy.languageText(c)}`);
  out.push(`language null: ${copy.languageText(null)}`);
  out.push(`language undefined: ${copy.languageText(undefined)}`);
  for (const b of [0, 1, 512, 1024, 1536, 12698, 204800, 1048576, -1, 1.5, Number.NaN])
    out.push(`size ${String(b)}: ${copy.sizeText(b)}`);
  out.push(`size null: ${copy.sizeText(null)}`);
  out.push(`size undefined: ${copy.sizeText(undefined)}`);
  out.push(`fingerprint full: ${copy.fingerprintText(SHA)}`);
  out.push(`fingerprint upper: ${copy.fingerprintText(SHA.toUpperCase())}`);
  out.push(`fingerprint short: ${copy.fingerprintText('abc123')}`);
  out.push(`fingerprint non hex: ${copy.fingerprintText('z'.repeat(64))}`);
  out.push(`fingerprint empty: ${copy.fingerprintText('')}`);
  out.push(`fingerprint null: ${copy.fingerprintText(null)}`);
  out.push(`abstract: ${copy.abstractText('A short guide.')}`);
  out.push(`abstract blank: ${copy.abstractText('   ')}`);
  out.push(`abstract null: ${copy.abstractText(null)}`);
  out.push(`s2 line: ${copy.listFactsLine({ language: 'en', bytes: 12698, sha256: SHA })}`);
  out.push(`s2 line missing row: ${copy.listFactsLine(null)}`);
  out.push(
    `s2 line partial: ${copy.listFactsLine({ language: '', bytes: 2048, sha256: 'not a hash' })}`,
  );
  out.push(`buyer line: ${copy.buyerFactsLine({ language: 'en', bytes: 12698 })}`);
  out.push(`buyer line missing row: ${copy.buyerFactsLine(null)}`);
  out.push(`buyer line partial: ${copy.buyerFactsLine({ language: 'fr', bytes: -4 })}`);
  return out;
}

describe('article facts copy', () => {
  it('matches the reviewed golden file', () => {
    expect(lines().join('\n') + '\n').toBe(golden);
  });

  it('has no dash characters, no italics markup and no hard coded environment word', () => {
    const text = lines()
      .filter((l) => !l.startsWith('language "') || !l.includes('<b>'))
      .map((l) => l.slice(l.indexOf(': ') + 2))
      .join('\n');
    expect(text).not.toMatch(/[‐-―−-]/);
    expect(text).not.toMatch(/<i>|<em>|\*[^*\s][^*]*\*/);
    expect(text).not.toMatch(/sandbox|dry.?run/i);
  });

  it('shows exactly 12 characters of the hash and the label Content fingerprint', () => {
    expect(copy.LABEL_FINGERPRINT).toBe('Content fingerprint');
    expect(copy.fingerprintText(SHA)).toBe(SHA.slice(0, 12));
    expect(copy.fingerprintText(SHA)).toHaveLength(12);
    expect(copy.listFactsLine({ language: 'en', bytes: 100, sha256: SHA })).not.toContain(
      SHA.slice(0, 13),
    );
  });

  it('the buyer line never mentions the fingerprint or the hash', () => {
    const l = copy.buyerFactsLine({ language: 'en', bytes: 12698 });
    expect(l).not.toMatch(/fingerprint|sha/i);
  });
});

describe('the pages take the facts from the copy file and stay plain', () => {
  const s2 = read('./app/publisher/offers/page.tsx');
  const s3 = read('./app/publisher/offers/[id]/page.tsx');
  const buyer = read('./app/o/[publisher]/[offer]/page.tsx');

  it('S2 shows the abstract and the facts line from the read model', () => {
    expect(s2).toContain('listFactsLine');
    expect(s2).toContain('article_abstract');
    expect(s2).not.toMatch(/\bstyle=/);
  });

  it('S3 shows the four facts, read only, with the copy labels', () => {
    for (const k of [
      'ARTICLE_FACTS_HEADING',
      'ARTICLE_FACTS_NOTE',
      'LABEL_ABSTRACT',
      'LABEL_LANGUAGE',
      'LABEL_SIZE',
      'LABEL_FINGERPRINT',
      'fingerprintText',
    ])
      expect(s3, k).toContain(k);
    expect(s3).not.toMatch(/\bstyle=/);
  });

  it('the buyer page shows language and size and no hash', () => {
    expect(buyer).toContain('buyerFactsLine');
    expect(buyer).not.toMatch(/sha256|fingerprint/i);
    expect(buyer).not.toMatch(/\bstyle=/);
  });

  it('none of the pages reads a publisher or article id from the request for the facts', () => {
    // PUB-UI-OFFERS: the offers list reads one parameter, the status tab, which only narrows the rows shown.
    // It is the one use of searchParams allowed on S2; the page still takes the facts from the engine rows.
    const s2Plain = s2.replace(
      /searchParams: Promise<[^>]*>>;|\(await searchParams\)\.status|\{\s*searchParams,?\s*\}/g,
      '',
    );
    for (const src of [s2Plain, s3]) {
      expect(src).not.toMatch(/searchParams|headers\(\)|cookies\(\)\.get\(['"]pub/);
    }
  });
});
