import { readFileSync } from 'node:fs';
import { crc32 as zlibCrc32 } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { signedMessage } from './webhook-verify';
import { GOLDEN_FILE, WEBHOOK_ID, loadWebhookFixtures, rawBodyOf } from './webhook-test-support';

const golden = JSON.parse(readFileSync(GOLDEN_FILE, 'utf8')) as {
  meta: { source: string };
  webhook_id: string;
  messages: Record<string, string>;
};
const fixtures = loadWebhookFixtures();

describe('signed message per synthetic fixture matches the golden file', () => {
  it('the golden file is for the same webhook id and covers exactly the fixtures', () => {
    expect(golden.meta.source).toBe('synthetic');
    expect(golden.webhook_id).toBe(WEBHOOK_ID);
    expect(Object.keys(golden.messages).sort()).toEqual(fixtures.map((f) => f.name).sort());
  });

  for (const f of fixtures) {
    it(`${f.name}: <id>|<time>|<webhook id>|<crc32 of the raw bytes>`, () => {
      const raw = rawBodyOf(f);
      const message = signedMessage({
        transmission_id: f.headers['paypal-transmission-id'] as string,
        transmission_time: f.headers['paypal-transmission-time'] as string,
        webhook_id: WEBHOOK_ID,
        raw_body: raw,
      });
      expect(message).toBe(golden.messages[f.name]);
      // the CRC part is the unsigned decimal of the UTF-8 bytes, checked a second way
      expect(message.split('|')[3]).toBe(String(zlibCrc32(Buffer.from(raw, 'utf8'))));
    });
  }

  it('the message has exactly four fields, separated by the pipe', () => {
    const m = signedMessage({
      transmission_id: 'a',
      transmission_time: 'b',
      webhook_id: 'c',
      raw_body: '123456789',
    });
    expect(m).toBe('a|b|c|3421780262');
  });
});
