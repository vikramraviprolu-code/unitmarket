import { crc32 as zlibCrc32 } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { crc32 } from './crc32';

describe('crc32 (unsigned decimal, IEEE 802.3 polynomial)', () => {
  it('check value: CRC32 of "123456789" is 3421780262', () => {
    expect(crc32(Buffer.from('123456789'))).toBe(3421780262);
  });

  it('empty input is 0', () => {
    expect(crc32(new Uint8Array(0))).toBe(0);
  });

  it('known vectors', () => {
    expect(crc32(Buffer.from('a'))).toBe(0xe8b7be43);
    expect(crc32(Buffer.from('The quick brown fox jumps over the lazy dog'))).toBe(0x414fa339);
    expect(crc32(Buffer.from([0x00]))).toBe(0xd202ef8d);
  });

  it('is unsigned: a value with the high bit set is not negative', () => {
    const v = crc32(Buffer.from('123456789'));
    expect(v).toBeGreaterThan(2 ** 31);
    expect(v).toBeLessThan(2 ** 32);
  });

  it('agrees with node:zlib on deterministic inputs of many lengths and byte values', () => {
    for (let n = 0; n < 300; n += 7) {
      const bytes = Uint8Array.from({ length: n }, (_, i) => (i * 131 + n * 17 + 5) & 0xff);
      expect(crc32(bytes)).toBe(zlibCrc32(bytes));
    }
    const all = Uint8Array.from({ length: 256 }, (_, i) => i);
    expect(crc32(all)).toBe(zlibCrc32(all));
  });

  it('works on the UTF-8 bytes of a multi-byte string, not on UTF-16 code units', () => {
    const text = 'Zürich €5 \u{1F600}';
    expect(crc32(Buffer.from(text, 'utf8'))).toBe(zlibCrc32(Buffer.from(text, 'utf8')));
    expect(crc32(Buffer.from(text, 'utf8'))).not.toBe(crc32(Buffer.from(text, 'latin1')));
  });

  it('does not read past a Buffer view into a larger pool', () => {
    const pool = Buffer.from('xx123456789yy');
    expect(crc32(pool.subarray(2, 11))).toBe(3421780262);
  });
});
