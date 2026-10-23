// CRC-32 (IEEE 802.3, reflected polynomial 0xEDB88320) as an unsigned integer. PayPal signs
// `<transmission id>|<time>|<webhook id>|<crc32 of the raw body, unsigned decimal>`, so the checksum
// must match the standard one bit for bit: "123456789" gives 3421780262. Pure, no I/O.

const TABLE: Uint32Array = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

/** CRC-32 of the bytes, 0 to 2^32 - 1. */
export function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++)
    c = (TABLE[(c ^ (bytes[i] as number)) & 0xff] as number) ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
