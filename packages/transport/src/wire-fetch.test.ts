import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createFetchWire } from './wire-fetch';
import { MAX_RESPONSE_BYTES, mapFetchError, readCapped } from './wire-map';
import { netSpies } from './test-support';

let spies: ReturnType<typeof netSpies>;
beforeEach(() => {
  spies = netSpies();
});
afterEach(() => {
  spies.assertZero();
  spies.spies['global fetch'].mockRestore();
});

const REPO = fileURLToPath(new URL('../../../', import.meta.url));

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === '.next' || name === 'dist' || name.startsWith('.'))
      continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}
const rel = (p: string) => relative(REPO, p).split(sep).join('/');
const isTest = (f: string) => /\.test\.tsx?$/.test(f) || f.endsWith('/test-support.ts');

describe('the production fetch call lives in exactly one file', () => {
  const pkgFiles = walk(join(REPO, 'packages')).filter((f) => /\.(ts|tsx|mts|js|mjs)$/.test(f));
  const prod = pkgFiles.filter((f) => !isTest(rel(f)));

  it('only packages/transport/src/wire-fetch.ts calls fetch in non-test package code', () => {
    const hits = prod.filter((f) =>
      /(^|[^.\w$])fetch\s*\(|globalThis\s*\.\s*fetch|\bfetch\s*:/.test(readFileSync(f, 'utf8')),
    );
    expect(hits.map(rel)).toEqual(['packages/transport/src/wire-fetch.ts']);
  });

  it('wire-fetch.ts calls fetch exactly once, with redirect error, no credentials, and a timeout signal', () => {
    const src = readFileSync(join(REPO, 'packages/transport/src/wire-fetch.ts'), 'utf8');
    expect(src.match(/(^|[^.\w$])fetch\s*\(/gm)).toHaveLength(1);
    expect(src).toContain("redirect: 'error'");
    expect(src).toContain("credentials: 'omit'");
    expect(src).toContain("cache: 'no-store'");
    expect(src).toContain('AbortSignal.timeout');
  });

  it('only sandbox.ts imports wire-fetch among non-test files of the package', () => {
    const importers = prod
      .filter((f) => rel(f).startsWith('packages/transport/'))
      .filter((f) =>
        /from\s+['"]\.\/wire-fetch['"]|import\(\s*['"]\.\/wire-fetch/.test(readFileSync(f, 'utf8')),
      );
    expect(importers.map(rel)).toEqual(['packages/transport/src/sandbox.ts']);
  });

  it('the package index does not export the production wire', () => {
    const idx = readFileSync(join(REPO, 'packages/transport/src/index.ts'), 'utf8');
    expect(idx).not.toMatch(/wire-fetch|createFetchWire/);
  });

  it('no other workspace code names the fetch wire module', () => {
    const others = walk(REPO)
      .filter(
        (f) =>
          /\.(ts|tsx|mts|mjs)$/.test(f) &&
          !rel(f).startsWith('packages/transport/') &&
          !rel(f).startsWith('node_modules'),
      )
      .filter((f) => !rel(f).startsWith('docs/') && !rel(f).endsWith('wire-fetch.test.ts'))
      .filter((f) => /wire-fetch|createFetchWire/.test(readFileSync(f, 'utf8')));
    expect(others.map(rel)).toEqual([]);
  });
});

describe('production wire (constructed, never called)', () => {
  it('constructing it touches nothing', () => {
    const w = createFetchWire();
    expect(typeof w.request).toBe('function');
    expect(spies.counts()['global fetch']).toBe(0);
  });
});

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
