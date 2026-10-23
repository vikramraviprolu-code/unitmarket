import { describe, expect, it } from 'vitest';
import { MAX_RESPONSE_BYTES, mapFetchError, readCapped } from './wire-map';

// Moved unchanged from wire-fetch.test.ts (BU-1 deletes that file). The pure helpers in
// wire-map.ts are still the error mapping of the production Wire.

describe('response reading is capped', () => {
  const stream = (chunks: string[]) =>
    new ReadableStream<Uint8Array>({
      start(c) {
        for (const s of chunks) c.enqueue(new TextEncoder().encode(s));
        c.close();
      },
    });

  it('reads a body up to the cap and refuses one byte more', async () => {
    expect(MAX_RESPONSE_BYTES).toBe(1024 * 1024);
    const ok = await readCapped(
      new Response(stream(['a'.repeat(MAX_RESPONSE_BYTES)])),
      MAX_RESPONSE_BYTES,
    );
    expect(ok.kind).toBe('ok');
    const over = await readCapped(
      new Response(stream(['a'.repeat(MAX_RESPONSE_BYTES), 'b'])),
      MAX_RESPONSE_BYTES,
    );
    expect(over).toEqual({ kind: 'too_large' });
  });

  it('refuses a declared content-length over the cap before reading', async () => {
    const r = new Response('x', { headers: { 'content-length': String(MAX_RESPONSE_BYTES + 1) } });
    expect(await readCapped(r, MAX_RESPONSE_BYTES)).toEqual({ kind: 'too_large' });
  });

  it('decodes utf-8 across chunk boundaries and handles an empty body', async () => {
    const bytes = new TextEncoder().encode('é');
    const s = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(bytes.slice(0, 1));
        c.enqueue(bytes.slice(1));
        c.close();
      },
    });
    expect(await readCapped(new Response(s), 100)).toEqual({ kind: 'ok', text: 'é' });
    expect(await readCapped(new Response(null, { status: 204 }), 100)).toEqual({
      kind: 'ok',
      text: '',
    });
  });
});

describe('fetch error mapping (no message text leaks)', () => {
  const e = (name: string, message: string, code?: string) => {
    const err = new Error(message, code ? { cause: { code } } : undefined);
    err.name = name;
    return err;
  };
  it('maps timeout, abort, dns, connect, tls, reset, redirect and unknown', () => {
    expect(mapFetchError(e('TimeoutError', 'timed out'))).toBe('timeout');
    expect(mapFetchError(e('AbortError', 'aborted'))).toBe('aborted');
    expect(mapFetchError(e('TypeError', 'fetch failed', 'ENOTFOUND'))).toBe('dns');
    expect(mapFetchError(e('TypeError', 'fetch failed', 'EAI_AGAIN'))).toBe('dns');
    expect(mapFetchError(e('TypeError', 'fetch failed', 'ECONNREFUSED'))).toBe('connect');
    expect(mapFetchError(e('TypeError', 'fetch failed', 'EHOSTUNREACH'))).toBe('connect');
    expect(mapFetchError(e('TypeError', 'fetch failed', 'UND_ERR_CONNECT_TIMEOUT'))).toBe(
      'timeout',
    );
    expect(mapFetchError(e('TypeError', 'fetch failed', 'ECONNRESET'))).toBe('reset');
    expect(mapFetchError(e('TypeError', 'fetch failed', 'UND_ERR_SOCKET'))).toBe('reset');
    expect(mapFetchError(e('TypeError', 'fetch failed', 'CERT_HAS_EXPIRED'))).toBe('tls');
    expect(mapFetchError(e('TypeError', 'fetch failed', 'ERR_TLS_CERT_ALTNAME_INVALID'))).toBe(
      'tls',
    );
    expect(mapFetchError(e('TypeError', 'fetch failed', 'DEPTH_ZERO_SELF_SIGNED_CERT'))).toBe(
      'tls',
    );
    expect(mapFetchError(e('TypeError', 'fetch failed', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE'))).toBe(
      'tls',
    );
    expect(
      mapFetchError(e('TypeError', 'unexpected redirect, redirect mode is set to error')),
    ).toBe('redirect');
    expect(mapFetchError(e('TypeError', 'fetch failed', 'SOMETHING_NEW'))).toBe('other');
    expect(mapFetchError('not an error')).toBe('other');
    expect(mapFetchError(null)).toBe('other');
  });
});
