// API-C (E2): the webhook signature. Unit level. A known vector worked out outside this code base
// (openssl dgst -sha256 -hmac), a tamper table, the 300 second tolerance, key rotation (two v1 values),
// malformed headers (refused, never thrown) and a spy on timingSafeEqual. Delivery and fan-out are in
// packages/jobs/src/deliver.state.test.ts; the attacks on the whole feature are in events.adversarial.test.ts.
import { timingSafeEqual } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_TOLERANCE_S,
  EVENT_ID_HEADER,
  SIGNATURE_HEADER,
  signPayload,
  signatureHeader,
  verifySignature,
} from './signature';
import { expectOffline } from './offline-guard';

vi.mock('node:net', async (orig) => (await import('./offline-guard')).netMock(await orig()));
vi.mock('node:dns', async (orig) => (await import('./offline-guard')).dnsMock(await orig()));
vi.mock('node:crypto', async (orig) => {
  const actual = await orig<typeof import('node:crypto')>();
  return { ...actual, timingSafeEqual: vi.fn(actual.timingSafeEqual) };
});
expectOffline();

// Worked out with: printf '%s' "1700000000.<body>" | openssl dgst -sha256 -hmac '<secret>' -hex
const SECRET = 'whsec_test_secret_0123456789';
const BODY = '{"id":"evt_0001","type":"order.paid"}';
const T = 1_700_000_000;
const V1 = '42867fc074ee29a8782a1e14f038f9f9fe428b36a1558dbb166eeb60936e1e1d';
const OTHER_SECRET = 'whsec_other';
const V1_OTHER = '6cf174c79e0b3b4a9ea1d5a2fa498b31ba70d6df1fa85ae5a94c23412930e0e8';
const at = (seconds: number): Date => new Date(seconds * 1000);
const header = (t = T, ...v1: string[]) => `t=${String(t)},${v1.map((v) => `v1=${v}`).join(',')}`;

describe('names', () => {
  it('uses the header names of the spec and a 300 second tolerance', () => {
    expect(SIGNATURE_HEADER).toBe('UnitMarket-Signature');
    expect(EVENT_ID_HEADER).toBe('UnitMarket-Event-Id');
    expect(DEFAULT_TOLERANCE_S).toBe(300);
  });
});

describe('signing', () => {
  it('matches the known vector: HMAC-SHA256 over "<t>.<raw body>" keyed by the secret text', () => {
    expect(signPayload(SECRET, T, BODY)).toBe(V1);
    expect(signPayload(OTHER_SECRET, T, BODY)).toBe(V1_OTHER);
  });

  it('the header is t=<unix seconds>,v1=<64 lower case hex characters>', () => {
    const h = signatureHeader(SECRET, T, BODY);
    expect(h).toBe(`t=${String(T)},v1=${V1}`);
    expect(h).toMatch(/^t=\d+,v1=[0-9a-f]{64}$/);
  });

  it('changes with the time, the body and the secret', () => {
    expect(signPayload(SECRET, T + 1, BODY)).not.toBe(V1);
    expect(signPayload(SECRET, T, `${BODY} `)).not.toBe(V1);
    expect(signPayload(`${SECRET}x`, T, BODY)).not.toBe(V1);
  });

  it('binds the time and the body with a dot: "1.23" and "12.3" are different messages', () => {
    expect(signPayload(SECRET, 1, '23')).not.toBe(signPayload(SECRET, 12, '3'));
  });
});

describe('verifySignature', () => {
  it('accepts the right header at the signing time', () => {
    expect(verifySignature(SECRET, header(T, V1), BODY, at(T))).toBe(true);
  });

  it('accepts a header made by signatureHeader', () => {
    expect(verifySignature(SECRET, signatureHeader(SECRET, T, BODY), BODY, at(T + 5))).toBe(true);
  });

  it('refuses a wrong secret', () => {
    expect(verifySignature(OTHER_SECRET, header(T, V1), BODY, at(T))).toBe(false);
  });

  it('refuses a body that differs by one byte, at every position', () => {
    for (let i = 0; i < BODY.length; i += 1) {
      const changed =
        BODY.slice(0, i) + String.fromCharCode(BODY.charCodeAt(i) ^ 1) + BODY.slice(i + 1);
      expect(verifySignature(SECRET, header(T, V1), changed, at(T)), `byte ${String(i)}`).toBe(
        false,
      );
    }
    expect(verifySignature(SECRET, header(T, V1), `${BODY}\n`, at(T))).toBe(false);
    expect(verifySignature(SECRET, header(T, V1), BODY.slice(1), at(T))).toBe(false);
  });

  it('refuses a time that was changed in the header (the time is signed)', () => {
    expect(verifySignature(SECRET, header(T + 1, V1), BODY, at(T + 1))).toBe(false);
  });

  it('keeps a 300 second tolerance on both sides: 300 passes, 301 fails', () => {
    expect(verifySignature(SECRET, header(T, V1), BODY, at(T + 300))).toBe(true);
    expect(verifySignature(SECRET, header(T, V1), BODY, at(T + 301))).toBe(false);
    expect(verifySignature(SECRET, header(T, V1), BODY, at(T - 300))).toBe(true);
    expect(verifySignature(SECRET, header(T, V1), BODY, at(T - 301))).toBe(false);
  });

  it('fails closed on a clock that is not a real time (Invalid Date), never throws', () => {
    const good = signatureHeader(SECRET, 1, BODY);
    expect(() => verifySignature(SECRET, good, BODY, new Date('x'))).not.toThrow();
    expect(verifySignature(SECRET, good, BODY, new Date('x'))).toBe(false);
    expect(verifySignature(SECRET, header(T, V1), BODY, new Date(Number.NaN))).toBe(false);
  });

  it('fails closed on a tolerance that is NaN or infinite, never throws', () => {
    const good = signatureHeader(SECRET, 1, BODY);
    expect(() => verifySignature(SECRET, good, BODY, at(T), Number.NaN)).not.toThrow();
    expect(verifySignature(SECRET, good, BODY, at(T), Number.NaN)).toBe(false);
    expect(verifySignature(SECRET, header(T, V1), BODY, at(T), Number.NaN)).toBe(false);
    expect(verifySignature(SECRET, good, BODY, at(T), Number.POSITIVE_INFINITY)).toBe(false);
  });

  it('fails closed on a negative tolerance, even for a header signed at the same second', () => {
    expect(verifySignature(SECRET, header(T, V1), BODY, at(T), -1)).toBe(false);
    expect(verifySignature(SECRET, header(T, V1), BODY, at(T), Number.NEGATIVE_INFINITY)).toBe(
      false,
    );
  });

  it('takes another tolerance when asked', () => {
    expect(verifySignature(SECRET, header(T, V1), BODY, at(T + 10), 10)).toBe(true);
    expect(verifySignature(SECRET, header(T, V1), BODY, at(T + 11), 10)).toBe(false);
    expect(verifySignature(SECRET, header(T, V1), BODY, at(T + 3600), 7200)).toBe(true);
  });

  it('a header with two v1 values accepts either (key rotation)', () => {
    const wrong = 'f'.repeat(64);
    expect(verifySignature(SECRET, header(T, wrong, V1), BODY, at(T))).toBe(true);
    expect(verifySignature(SECRET, header(T, V1, wrong), BODY, at(T))).toBe(true);
    expect(verifySignature(SECRET, header(T, wrong, wrong), BODY, at(T))).toBe(false);
    // two values signed with two secrets: each secret finds its own
    expect(verifySignature(OTHER_SECRET, header(T, V1, V1_OTHER), BODY, at(T))).toBe(true);
  });

  it('ignores a field it does not know (v0 from an older scheme) and spaces after the commas', () => {
    expect(verifySignature(SECRET, `t=${String(T)}, v0=abc, v1=${V1}`, BODY, at(T))).toBe(true);
    expect(verifySignature(SECRET, `v1=${V1},t=${String(T)}`, BODY, at(T))).toBe(true);
  });

  it('refuses, and does not throw on, a header that is not the format', () => {
    const bad = [
      '',
      ' ',
      'garbage',
      `v1=${V1}`,
      `t=${String(T)}`,
      `t=${String(T)},v1=`,
      `t=,v1=${V1}`,
      `t=abc,v1=${V1}`,
      `t=${String(T)}.5,v1=${V1}`,
      `t=-${String(T)},v1=${V1}`,
      `t=${String(T)},t=${String(T)},v1=${V1}`,
      `t=1e9,v1=${V1}`,
      `t=${'9'.repeat(40)},v1=${V1}`,
      `t=${String(T)};v1=${V1}`,
      `t=${String(T)},v1=${V1.toUpperCase()}x`,
    ];
    for (const h of bad) {
      expect(() => verifySignature(SECRET, h, BODY, at(T)), JSON.stringify(h)).not.toThrow();
      expect(verifySignature(SECRET, h, BODY, at(T)), JSON.stringify(h)).toBe(false);
    }
  });

  it('refuses a v1 of the wrong length or with characters that are not hex, without throwing', () => {
    const wrong = [
      V1.slice(0, 63),
      `${V1}0`,
      V1.slice(0, 32),
      `${V1}${V1}`,
      'z'.repeat(64),
      `${V1.slice(0, 63)}g`,
      `${V1.slice(0, 62)}  `,
    ];
    for (const v of wrong) {
      expect(() => verifySignature(SECRET, header(T, v), BODY, at(T)), v).not.toThrow();
      expect(verifySignature(SECRET, header(T, v), BODY, at(T)), v).toBe(false);
    }
  });

  it('returns exactly true or false', () => {
    expect(verifySignature(SECRET, header(T, V1), BODY, at(T))).toStrictEqual(true);
    expect(verifySignature(SECRET, header(T, 'a'), BODY, at(T))).toStrictEqual(false);
  });
});

describe('constant time comparison', () => {
  it('compares two 32 byte buffers with timingSafeEqual', () => {
    const spy = vi.mocked(timingSafeEqual);
    spy.mockClear();
    expect(verifySignature(SECRET, header(T, V1), BODY, at(T))).toBe(true);
    expect(spy).toHaveBeenCalledTimes(1);
    for (const [a, b] of spy.mock.calls) {
      expect(Buffer.from(a as Uint8Array).length).toBe(32);
      expect(Buffer.from(b as Uint8Array).length).toBe(32);
    }
  });

  it('compares a wrong value of the right length too (no early exit on content)', () => {
    const spy = vi.mocked(timingSafeEqual);
    spy.mockClear();
    expect(verifySignature(SECRET, header(T, 'a'.repeat(64)), BODY, at(T))).toBe(false);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('never hands timingSafeEqual buffers of different lengths (it would throw)', () => {
    const spy = vi.mocked(timingSafeEqual);
    spy.mockClear();
    for (const v of ['', 'ab', V1.slice(0, 62), `${V1}ab`, 'z'.repeat(64)]) {
      expect(verifySignature(SECRET, header(T, v), BODY, at(T))).toBe(false);
    }
    for (const [a, b] of spy.mock.calls) {
      expect(Buffer.from(a as Uint8Array).length).toBe(Buffer.from(b as Uint8Array).length);
    }
  });

  it('does not compare at all when the time is outside the tolerance', () => {
    const spy = vi.mocked(timingSafeEqual);
    spy.mockClear();
    expect(verifySignature(SECRET, header(T, V1), BODY, at(T + 1000))).toBe(false);
    expect(spy).not.toHaveBeenCalled();
  });
});
