// READER-A golden (docs/specs/reader-a-view.md): the words of the reader page and the library link.
// The reviewed file is golden/reader-copy.golden.txt; a change to it is a change to what a buyer is told.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  READER_DOWNLOAD_ANSWER,
  READER_ENDED,
  READER_HEADING_BACK,
  READER_LINK_TEXT,
  READER_NOT_READY,
  READER_RATE_LIMITED,
  READER_REFUNDED,
  READER_STORE_DOWN,
} from './lib/reader-copy';

describe('reader copy (golden)', () => {
  it('matches golden/reader-copy.golden.txt', () => {
    const lines = [
      `library, link to the reader: ${READER_LINK_TEXT}`,
      `reader, back link: ${READER_HEADING_BACK}`,
      `reader, opens as a download: ${READER_DOWNLOAD_ANSWER}`,
      `reader, window ended: ${READER_ENDED}`,
      `reader, not ready: ${READER_NOT_READY}`,
      `reader, content unavailable: ${READER_STORE_DOWN}`,
      `reader, refunded: ${READER_REFUNDED}`,
      `reader, too many requests: ${READER_RATE_LIMITED}`,
    ];
    const expected = readFileSync(
      new URL('./golden/reader-copy.golden.txt', import.meta.url),
      'utf8',
    )
      .split('\n')
      .filter((l) => l !== '' && !l.startsWith('#'));
    expect(lines).toEqual(expected);
  });

  it('has no dashes and no italics markers in the words', () => {
    const all = [
      READER_LINK_TEXT,
      READER_HEADING_BACK,
      READER_DOWNLOAD_ANSWER,
      READER_ENDED,
      READER_NOT_READY,
      READER_STORE_DOWN,
      READER_REFUNDED,
      READER_RATE_LIMITED,
    ].join(' ');
    expect(all).not.toMatch(/[‐-―-]|\*|_/);
  });
});
