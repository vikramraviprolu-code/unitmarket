// SKIN-A state tests (docs/specs/skin-a-system.md): the skin is chosen on the server from the um_skin
// cookie, the Appearance route sets that cookie and nothing else, and no .tsx carries an inline style
// (the CSP has no style-src 'unsafe-inline'). The unit runner does not compile .tsx, so pages are read as text.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { App } from '../composition.server';
import { bootTestApp } from './support';
import { readGlobalsCss, stripComments } from './skin-css-support';
import { SKIN_COOKIE, SKIN_COOKIE_MAX_AGE_S, skinFromCookie } from './lib/skin';
import {
  APPEARANCE_LEGEND,
  APPEARANCE_SAVE_FAILED,
  APPEARANCE_SAVING,
  SKIN_LABELS,
} from './lib/appearance-copy';

vi.mock('server-only', () => ({}));

const here = fileURLToPath(new URL('.', import.meta.url));
const read = (rel: string) => readFileSync(join(here, rel), 'utf8');
const noComments = (s: string) => s.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir).sort()) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (name.endsWith('.tsx')) out.push(p);
  }
  return out;
}

describe('the skin is chosen on the server', () => {
  it('skinFromCookie renders harbour only for the exact value harbour; everything else is market', () => {
    expect(skinFromCookie('harbour')).toBe('harbour');
    expect(skinFromCookie('market')).toBe('market');
    for (const v of [undefined, '', 'Harbour', 'HARBOUR', ' harbour', 'dark', 'harbour;x', 'null'])
      expect(skinFromCookie(v)).toBe('market');
  });

  it('layout.tsx reads um_skin with cookies() and puts data-skin on <html> in the server HTML', () => {
    const src = noComments(read('app/layout.tsx'));
    expect(src).toMatch(/import \{[^}]*\bcookies\b[^}]*\} from 'next\/headers'/);
    expect(src).toContain('SKIN_COOKIE');
    expect(src).toContain('skinFromCookie(');
    expect(src).toMatch(/<html[^>]*\bdata-skin=\{skin\}/);
    expect(src).toContain('<AppearanceControl');
    expect(SKIN_COOKIE).toBe('um_skin');
  });

  it('globals.css has a market block that is the default and a harbour block with a dark colour scheme', () => {
    const css = stripComments(readGlobalsCss());
    expect(css).toMatch(/:root,\s*:root\[data-skin='market'\]\s*\{/);
    expect(css).toMatch(/:root\[data-skin='harbour'\]\s*\{[^}]*color-scheme:\s*dark/);
    expect(css).not.toMatch(/url\(/);
    expect(css).not.toContain('data:');
  });
});

describe('Appearance control and copy', () => {
  it('is a labelled radio group that posts to /api/appearance, reloads, and does not use localStorage', () => {
    const src = noComments(read('ui/AppearanceControl.tsx'));
    expect(src.startsWith("'use client'")).toBe(true);
    expect(src).toContain('<fieldset');
    expect(src).toContain('<legend');
    expect(src).toContain('type="radio"');
    expect(src).toContain("postJson('/api/appearance'");
    expect(src).toContain('window.location.reload()');
    expect(src).not.toMatch(/localStorage|sessionStorage/);
    expect(src).toContain('APPEARANCE_LEGEND');
  });

  it('the words are fixed and carry no dash', () => {
    expect(APPEARANCE_LEGEND).toBe('Appearance');
    expect(SKIN_LABELS).toEqual({ market: 'Bright Market', harbour: 'Deep Harbour' });
    expect(APPEARANCE_SAVING).toBe('Saving your choice');
    expect(APPEARANCE_SAVE_FAILED).toBe('We could not save your choice. Please try again.');
    for (const s of [
      APPEARANCE_LEGEND,
      ...Object.values(SKIN_LABELS),
      APPEARANCE_SAVING,
      APPEARANCE_SAVE_FAILED,
    ])
      expect(s).not.toMatch(/[‒-―−]| - |--/);
  });
});

describe('no inline style attribute in any .tsx under src/app and src/ui', () => {
  it('finds none (the CSP would block it)', () => {
    const files = [...walk(join(here, 'app')), ...walk(join(here, 'ui'))];
    expect(files.length).toBeGreaterThan(10);
    const bad = files.filter((f) => /\sstyle=/.test(noComments(readFileSync(f, 'utf8'))));
    expect(bad).toEqual([]);
  });
  it('the access meter fills by class, in whole days', () => {
    const src = noComments(read('ui/WindowMeter.tsx'));
    expect(src).toContain('meter-fill-');
    const css = readGlobalsCss();
    for (const n of [1, 2, 3, 4, 5]) expect(css).toContain(`.meter-fill-${n}`);
  });
});

describe('POST /api/appearance', () => {
  let app: App;
  let route: typeof import('./app/api/appearance/route');
  beforeAll(async () => {
    app = await bootTestApp();
    route = await import('./app/api/appearance/route');
  });
  afterAll(async () => {
    await app.close();
  });

  const post = (body: unknown, headers: Record<string, string> = {}) =>
    route.POST(
      new Request('http://localhost:3000/api/appearance', {
        method: 'POST',
        headers: {
          origin: 'http://localhost:3000',
          'content-type': 'application/json',
          ...headers,
        },
        body: typeof body === 'string' ? body : JSON.stringify(body),
      }),
      { params: Promise.resolve({}) },
    );

  it('is public, csrf-checked, 64 bytes, 30 per minute per ip', () => {
    expect(route.routeMeta).toMatchObject({
      path: '/api/appearance',
      method: 'POST',
      auth: 'public',
      csrf: true,
      max_body_bytes: 64,
      rate: { per: 'ip', limit: 30, window_ms: 60_000 },
    });
  });

  it('sets um_skin for each of the two skins, signed out, with the cookie attributes and no other data', async () => {
    for (const skin of ['harbour', 'market'] as const) {
      const res = await post({ skin });
      expect(res.status).toBe(200);
      const cookie = res.headers.get('set-cookie') ?? '';
      expect(cookie).toBe(
        `um_skin=${skin}; Path=/; Max-Age=${SKIN_COOKIE_MAX_AGE_S}; SameSite=Lax; Secure; HttpOnly`,
      );
      expect(SKIN_COOKIE_MAX_AGE_S).toBe(180 * 24 * 60 * 60);
      expect(await res.json()).toEqual({ skin });
    }
  });

  it('refuses a third value, an extra field, a missing field and a bad body, with no cookie', async () => {
    for (const body of [
      { skin: 'dark' },
      { skin: 'HARBOUR' },
      { skin: '' },
      { skin: 'harbour', extra: 1 },
      {},
    ]) {
      // withRoute answers a body that fails the strict schema with 422 (the first run of this test
      // guessed 400; the spec names no code, so the test follows the route wrapper).
      const res = await post(body);
      expect(res.status, JSON.stringify(body)).toBe(422);
      expect(res.headers.get('set-cookie')).toBeNull();
    }
    const unreadable = await post('{not json');
    expect(unreadable.status).toBe(400);
    expect(unreadable.headers.get('set-cookie')).toBeNull();
  });

  it('refuses a cross-origin POST and a POST with no origin, with no cookie', async () => {
    const cross = await post({ skin: 'harbour' }, { origin: 'https://evil.example' });
    expect(cross.status).toBe(403);
    expect(cross.headers.get('set-cookie')).toBeNull();
    const none = await route.POST(
      new Request('http://localhost:3000/api/appearance', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ skin: 'harbour' }),
      }),
      { params: Promise.resolve({}) },
    );
    expect(none.status).toBe(403);
    expect(none.headers.get('set-cookie')).toBeNull();
  });

  it('refuses a body over 64 bytes', async () => {
    const res = await post({ skin: 'harbour', pad: 'x'.repeat(80) });
    expect(res.status).toBe(413);
    expect(res.headers.get('set-cookie')).toBeNull();
  });

  it('a GET is not allowed', () => {
    expect((route as Record<string, unknown>)['GET']).toBeUndefined();
  });

  it('answers 429 after 30 requests in a minute from one address', async () => {
    let last = 0;
    for (let i = 0; i < 40; i += 1) last = (await post({ skin: 'market' })).status;
    expect(last).toBe(429);
  });
});
